/**
 * 系统监控 World:查询本机 CPU/GPU/内存/磁盘/温度,并按间隔采样做阈值与异常监控。
 *
 * 工具只读;事件只陈述可核对的事实;全部数据留在本机进程内,
 * 不落盘、不联网、不需要任何密钥。
 */
import { fileURLToPath } from 'node:url';
import type { ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { nowIso } from 'cortico/core/util.ts';
import { sysmonConfigGroup, type SysmonConfigSection } from './config.ts';
import {
  collectScheduledTasks,
  collectSnapshot,
  collectStartupEntries,
  countEventLogErrors,
  formatProcesses,
  formatStatus,
  type SysSample,
} from './sensors.ts';
import {
  enabledSignalSummary,
  evaluate,
  initialEngineState,
  type AnomalyConfig,
  type AnomalyEngineState,
  type AnomalyEvent,
} from './anomaly.ts';
import { text } from './strings.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

export const SYSMON_ID = 'sysmon';

/** 自启动与计划任务列表的重扫间隔(按采样次数计)。 */
const BASELINE_RESCAN_SAMPLES = 10;
/** 事件文本上限;路径等长字段会截断。 */
const EVENT_TEXT_MAX_CHARS = 500;

export interface SysmonDeps {
  collectSnapshot: () => Promise<SysSample>;
  collectStartupEntries: () => Promise<string[]>;
  countEventLogErrors: (minutes: number) => Promise<number | null>;
  collectScheduledTasks: () => Promise<string[]>;
}

const DEFAULT_DEPS: SysmonDeps = {
  collectSnapshot,
  collectStartupEntries,
  countEventLogErrors,
  collectScheduledTasks,
};

export interface SysmonWorldOptions {
  /** `worlds.sysmon` 的活引用。 */
  cfg: SysmonConfigSection;
  timezone: string;
  /** 测试可替换的采集器;缺省用 sensors.ts 的本机实现。 */
  deps?: Partial<SysmonDeps>;
}

/** 全部工具的声明;定义里的 describe 与 `tools()` 都取它。 */
export const SYS_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'sysmon_status',
    description:
      'Read a snapshot of this computer: CPU load/frequency/temperature, memory, GPU usage/memory/temperature, per-disk capacity, disk IO rates, disk health, fan speeds when available, and uptime. Every field is a fact as reported by the OS; missing sensors read as n/a and are never guessed. Use it when the user asks how the computer is doing, before judging whether a load is normal, or to explain an anomaly alert.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'sysmon_processes',
    description:
      'List the top processes by CPU or memory usage, with PID, path and per-process percentages. Use it after sysmon_status when a load needs to be attributed to a process, or when the user asks what is running heavily.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        top: {
          type: 'integer',
          minimum: 1,
          maximum: 30,
          default: 8,
          description: 'How many processes to return (1-30).',
        },
        sortBy: {
          type: 'string',
          enum: ['cpu', 'mem'],
          default: 'cpu',
          description: 'Sort by CPU percentage or memory percentage.',
        },
      },
    },
  },
];

export class SysmonWorld implements World {
  readonly id = SYSMON_ID;

  private readonly cfg: SysmonConfigSection;
  private readonly timezone: string;
  private readonly deps: SysmonDeps;
  private host: WorldHost | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private busy = false;
  private tickCount = 0;
  private engine: AnomalyEngineState = initialEngineState();
  private lastUptimeSeconds: number | null = null;
  private startupCurrent: string[] | null = null;
  private tasksCurrent: string[] | null = null;
  private eventLogErrorCount: number | null = null;

  constructor(options: SysmonWorldOptions) {
    this.cfg = options.cfg;
    this.timezone = options.timezone;
    this.deps = { ...DEFAULT_DEPS, ...options.deps };
  }

  envPromptVars(): Record<string, string> {
    return {
      'sysmon.intervalSeconds': String(this.intervalSeconds()),
      'sysmon.alertSignals': enabledSignalSummary(this.anomalyConfig()),
    };
  }

  tools(): ToolDef[] {
    return [this.statusTool(), this.processesTool()];
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = text(language);
    const monitoring = this.cfg.alertsEnabled === true || this.cfg.anomaliesEnabled === true;
    return {
      label: t.moduleLabel,
      lamps: [
        {
          label: t.lampSampling,
          state: monitoring && this.timer ? 'online' : 'offline',
          hint: !this.timer ? t.lampOffline : monitoring ? t.lampOnline : t.lampQueryOnly,
        },
      ],
      config: [sysmonConfigGroup(language)],
      promptDocs: [
        {
          key: 'worlds.sysmon.envPrompt',
          title: t.promptDocTitle,
          description: t.promptDocDescription,
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'sysmon.intervalSeconds', description: t.varIntervalDescription },
            { name: 'sysmon.alertSignals', description: t.varSignalsDescription },
          ],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.stopped = false;
    this.busy = false;
    this.tickCount = 0;
    this.engine = initialEngineState();
    this.lastUptimeSeconds = null;

    this.pushEvent('sysmon.started', this.startedText(), { kind: 'lifecycle' }, undefined);
    await this.initBaselines();
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.host = null;
  }

  // ── 定时采样 ────────────────────────────────────────────────────────

  private scheduleNext(): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      void this.tick();
    }, this.intervalSeconds() * 1000);
    // 定时器不阻止进程退出;测试里用假定时器时 unref 是空操作。
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      // 默认只查询:阈值告警与异常监控都关着时不采样,把开销降到零。
      if (!this.cfg.alertsEnabled && !this.cfg.anomaliesEnabled) return;
      this.tickCount += 1;
      const sample = await this.deps.collectSnapshot();

      await this.refreshBaselines();
      if (this.cfg.watchEventLog) {
        this.eventLogErrorCount = await this.deps.countEventLogErrors(this.intervalSeconds() / 60);
      }

      const anomalyConfig = this.anomalyConfig();
      const prevUptime = this.lastUptimeSeconds;
      this.lastUptimeSeconds = sample.uptimeSeconds ?? prevUptime;
      const result = evaluate(this.engine, {
        sample,
        prevUptimeSeconds: prevUptime,
        startupCurrent: this.startupCurrent,
        scheduledTasksCurrent: this.tasksCurrent,
        eventLogErrorCount: this.eventLogErrorCount,
      }, anomalyConfig);
      this.engine = result.state;
      for (const event of result.events) this.emit(event);
    } catch (error) {
      this.logWarn(`sysmon: sampling failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.busy = false;
      this.scheduleNext();
    }
  }

  private async initBaselines(): Promise<void> {
    if (this.cfg.watchStartup) {
      try {
        this.startupCurrent = await this.deps.collectStartupEntries();
      } catch {
        this.startupCurrent = null;
      }
    }
    if (this.cfg.watchScheduledTasks) {
      try {
        this.tasksCurrent = await this.deps.collectScheduledTasks();
      } catch {
        this.tasksCurrent = null;
      }
    }
  }

  private async refreshBaselines(): Promise<void> {
    if (this.cfg.watchStartup && this.tickCount % BASELINE_RESCAN_SAMPLES === 0) {
      try {
        this.startupCurrent = await this.deps.collectStartupEntries();
      } catch {
        // 保留上一份列表;读取失败不等于没有变化。
      }
    }
    if (this.cfg.watchScheduledTasks && this.tickCount % BASELINE_RESCAN_SAMPLES === 0) {
      try {
        this.tasksCurrent = await this.deps.collectScheduledTasks();
      } catch {
        // 同上
      }
    }
  }

  // ── 工具 ────────────────────────────────────────────────────────────

  private statusTool(): ToolDef {
    return {
      ...SYS_TOOL_DECLS[0],
      handler: async () => {
        try {
          const sample = await this.deps.collectSnapshot();
          const body = formatStatus(sample);
          return {
            text: `${body}\n(异常监控: ${enabledSignalSummary(this.anomalyConfig())};采样间隔 ${this.intervalSeconds()} 秒)`,
          };
        } catch (error) {
          return fail(`[sysmon] 采集失败: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    };
  }

  private processesTool(): ToolDef {
    return {
      ...SYS_TOOL_DECLS[1],
      handler: async (args) => {
        const top = clampInt(args.top, 1, 30, this.cfg.processesTopDefault);
        const sortBy = args.sortBy === 'mem' ? 'mem' : 'cpu';
        try {
          const sample = await this.deps.collectSnapshot();
          return { text: formatProcesses(sample.processes, { top, sortBy }) };
        } catch (error) {
          return fail(`[sysmon] 读取进程失败: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    };
  }

  // ── 事件 ────────────────────────────────────────────────────────────

  private startedText(): string {
    const cfg = this.cfg;
    return `系统监控 World 已挂载:每 ${this.intervalSeconds()} 秒采样;阈值告警${cfg.alertsEnabled ? '开' : '关'},异常监控${cfg.anomaliesEnabled ? '开' : '关'}(${enabledSignalSummary(this.anomalyConfig())})。`;
  }

  private emit(event: AnomalyEvent): void {
    const opts = event.type === 'sysmon.recover' || event.type === 'sysmon.alert' ? { trigger: 'debounce' as const } : undefined;
    this.pushEvent(event.type, event.text, { kind: event.meta.kind ?? 'anomaly', ...event.meta, signal: event.signal }, opts);
  }

  private pushEvent(type: string, body: string, meta: Record<string, unknown> | undefined, opts: { trigger?: 'flush' | 'debounce' | 'preempt' | 'interrupt' | 'piggyback' } | undefined): void {
    const host = this.host;
    if (!host) return;
    void host.pushEvent({
      type,
      ts: nowIso(this.timezone),
      source: SYSMON_ID,
      origin: 'internal',
      senderKey: String(meta?.signal ?? SYSMON_ID),
      text: truncate(body, EVENT_TEXT_MAX_CHARS),
      meta,
    }, opts).catch((error: unknown) => this.logWarn(`sysmon: cannot push ${type}: ${error instanceof Error ? error.message : String(error)}`));
  }

  // ── 配置换算 ────────────────────────────────────────────────────────

  private intervalSeconds(): number {
    return clampInt(this.cfg.intervalSeconds, 30, 600, 60);
  }

  private anomalyConfig(): AnomalyConfig {
    const cfg = this.cfg;
    const interval = this.intervalSeconds();
    const sustainMinutes = clampInt(cfg.anomalySustainMinutes, 1, 60, 10);
    return {
      alertsEnabled: cfg.alertsEnabled === true,
      anomaliesEnabled: cfg.anomaliesEnabled === true,
      cpuTempC: clampInt(cfg.cpuTempC, 30, 110, 90),
      gpuTempC: clampInt(cfg.gpuTempC, 30, 110, 85),
      memPercent: clampInt(cfg.memPercent, 50, 100, 90),
      cpuLoadPercent: clampInt(cfg.cpuLoadPercent, 50, 100, 90),
      processCpuPercent: clampInt(cfg.processCpuPercent, 10, 100, 70),
      gpuPercent: clampInt(cfg.gpuPercent, 50, 100, 90),
      diskIoMbs: clampNumber(cfg.diskIoMbs, 1, 1000, 60),
      diskDropPercent: clampNumber(cfg.diskDropPercent, 0.1, 50, 2),
      connectionsCount: clampInt(cfg.connectionsCount, 2, 200, 10),
      eventLogErrors: clampInt(cfg.eventLogErrors, 5, 500, 20),
      diskLatencyMs: clampInt(cfg.diskLatencyMs, 10, 5000, 200),
      sustainSamples: Math.max(1, Math.ceil((sustainMinutes * 60) / interval)),
      cooldownSamples: Math.max(0, Math.ceil((clampInt(cfg.anomalyCooldownMinutes, 0, 120, 10) * 60) / interval)),
      sustainMinutes,
      watchProcessCpu: cfg.watchProcessCpu === true,
      watchGpu: cfg.watchGpu === true,
      watchDiskIo: cfg.watchDiskIo === true,
      watchDiskDrop: cfg.watchDiskDrop === true,
      watchRestart: cfg.watchRestart === true,
      watchStartup: cfg.watchStartup === true,
      watchImpostor: cfg.watchImpostor === true,
      watchConnections: cfg.watchConnections === true,
      watchEventLog: cfg.watchEventLog === true,
      watchDiskLatency: cfg.watchDiskLatency === true,
      watchScheduledTasks: cfg.watchScheduledTasks === true,
    };
  }

  private logWarn(message: string): void {
    this.host?.log.warn(message);
  }
}

// ── 纯函数 ────────────────────────────────────────────────────────────

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Math.trunc(Number(raw));
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function clampNumber(raw: unknown, min: number, max: number, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function fail(message: string): ToolOutcome {
  return { text: message, failed: true };
}
