/**
 * 异常判定引擎:纯函数状态机,不碰 I/O、不碰定时器。
 *
 * 两类信号:
 * - 持续型(persistent):条件连续成立 sustainSamples 次才告警;连续两次不成立才恢复。
 *   阈值型(温度/内存/整机负载)的 sustainSamples 固定为 1。
 * - 事件型(episodic):重启、新增自启动、新增计划任务、伪装进程、外联异常。
 *   按"键"去重:同一批对象只报一次,冷却时间过后才允许再报。
 *
 * 文本只陈述可核对的事实(数值、阈值、进程名、路径、时间),
 * 判断"是不是病毒/是不是被挖矿"留给模型结合上下文去说。
 */
import type { SysSample } from './sensors.ts';
import {
  cpuTempOf,
  establishedByProcess,
  findImpostors,
  formatBytes,
  formatPercent,
  freeBytesByMount,
  maxGpuTemp,
  maxGpuUtil,
  newEntries,
  topProcessByCpu,
  diskIoTotalMbs,
} from './sensors.ts';

export interface AnomalyEvent {
  type: 'sysmon.alert' | 'sysmon.recover';
  signal: string;
  text: string;
  meta: Record<string, unknown>;
}

export interface AnomalyConfig {
  alertsEnabled: boolean;
  anomaliesEnabled: boolean;
  cpuTempC: number;
  gpuTempC: number;
  memPercent: number;
  cpuLoadPercent: number;
  processCpuPercent: number;
  gpuPercent: number;
  diskIoMbs: number;
  diskDropPercent: number;
  connectionsCount: number;
  eventLogErrors: number;
  diskLatencyMs: number;
  /** 持续判定需要连续成立的采样次数。 */
  sustainSamples: number;
  /** 同一信号两次告警之间至少间隔的采样次数。 */
  cooldownSamples: number;
  /** 持续判定的分钟数,只用于事件文本。 */
  sustainMinutes: number;
  watchProcessCpu: boolean;
  watchGpu: boolean;
  watchDiskIo: boolean;
  watchDiskDrop: boolean;
  watchRestart: boolean;
  watchStartup: boolean;
  watchImpostor: boolean;
  watchConnections: boolean;
  watchEventLog: boolean;
  watchDiskLatency: boolean;
  watchScheduledTasks: boolean;
}

export interface AnomalyInput {
  sample: SysSample;
  prevUptimeSeconds: number | null;
  startupCurrent: readonly string[] | null;
  scheduledTasksCurrent: readonly string[] | null;
  eventLogErrorCount: number | null;
}

interface SignalState {
  active: boolean;
  trueCount: number;
  falseCount: number;
  lastAlertSample: number;
  lastKey: string | null;
}

export interface AnomalyEngineState {
  sampleIndex: number;
  signals: Record<string, SignalState>;
  /** 每个分区可用字节数的历史,用于磁盘骤降;最多保留 sustainSamples 份。 */
  diskFreeHistory: Array<Record<string, number>>;
  uptimeBaseline: number | null;
  startupBaseline: string[] | null;
  tasksBaseline: string[] | null;
}

/** 持续型信号回落需要连续不成立的次数。 */
const RECOVER_SAMPLES = 2;
/** 磁盘读写异常判定时,CPU 负载低于这个值才算"低 CPU 高 IO"。 */
const DISK_IO_CPU_CEILING = 50;

export function initialEngineState(): AnomalyEngineState {
  return {
    sampleIndex: 0,
    signals: {},
    diskFreeHistory: [],
    uptimeBaseline: null,
    startupBaseline: null,
    tasksBaseline: null,
  };
}

function signalState(state: AnomalyEngineState, name: string): SignalState {
  state.signals[name] ??= { active: false, trueCount: 0, falseCount: 0, lastAlertSample: -1, lastKey: null };
  return state.signals[name];
}

interface TextBuilder {
  alert: () => { text: string; meta: Record<string, unknown> };
  recover: () => { text: string; meta: Record<string, unknown> };
}

export function evaluate(
  state: AnomalyEngineState,
  input: AnomalyInput,
  cfg: AnomalyConfig,
): { state: AnomalyEngineState; events: AnomalyEvent[] } {
  const next = structuredClone(state);
  next.sampleIndex += 1;
  const events: AnomalyEvent[] = [];
  const sample = input.sample;

  const stepPersistent = (name: string, cond: boolean, riseAfter: number, builder: TextBuilder): void => {
    const st = signalState(next, name);
    if (cond) {
      st.trueCount += 1;
      st.falseCount = 0;
      if (!st.active && st.trueCount >= riseAfter) {
        const cooled = st.lastAlertSample < 0 || next.sampleIndex - st.lastAlertSample >= cfg.cooldownSamples;
        if (cooled) {
          st.active = true;
          st.lastAlertSample = next.sampleIndex;
          const built = builder.alert();
          events.push({ type: 'sysmon.alert', signal: name, text: built.text, meta: built.meta });
        }
      }
    } else {
      st.falseCount += 1;
      st.trueCount = 0;
      if (st.active && st.falseCount >= RECOVER_SAMPLES) {
        st.active = false;
        st.lastAlertSample = next.sampleIndex;
        const built = builder.recover();
        events.push({ type: 'sysmon.recover', signal: name, text: built.text, meta: built.meta });
      }
    }
  };

  const stepEpisodic = (name: string, key: string | null, builder: () => { text: string; meta: Record<string, unknown> } | null): void => {
    const st = signalState(next, name);
    if (key === null || key.length === 0) return;
    if (st.lastKey === key) return;
    if (st.lastAlertSample >= 0 && next.sampleIndex - st.lastAlertSample < cfg.cooldownSamples) return;
    const built = builder();
    if (!built) return;
    st.lastKey = key;
    st.lastAlertSample = next.sampleIndex;
    events.push({ type: 'sysmon.alert', signal: name, text: built.text, meta: built.meta });
  };

  // ── 阈值信号(alertsEnabled 控制) ──────────────────────────────────
  if (cfg.alertsEnabled) {
    const cpuTemp = cpuTempOf(sample.cpu);
    stepPersistent('cpu_temp', cpuTemp !== null && cpuTemp >= cfg.cpuTempC, 1, {
      alert: () => ({
        text: `CPU 温度 ${(cpuTemp ?? 0).toFixed(0)}°C,达到阈值 ${cfg.cpuTempC}°C。`,
        meta: { kind: 'threshold', signal: 'cpu_temp', value: cpuTemp, threshold: cfg.cpuTempC },
      }),
      recover: () => ({
        text: `CPU 温度回落到 ${cpuTemp === null ? 'n/a' : `${cpuTemp.toFixed(0)}°C`},低于阈值 ${cfg.cpuTempC}°C。`,
        meta: { kind: 'threshold', signal: 'cpu_temp', value: cpuTemp, threshold: cfg.cpuTempC },
      }),
    });

    const gpuTemp = maxGpuTemp(sample.gpus);
    stepPersistent('gpu_temp', gpuTemp !== null && gpuTemp >= cfg.gpuTempC, 1, {
      alert: () => ({
        text: `GPU 温度 ${gpuTemp!.toFixed(0)}°C,达到阈值 ${cfg.gpuTempC}°C。`,
        meta: { kind: 'threshold', signal: 'gpu_temp', value: gpuTemp, threshold: cfg.gpuTempC },
      }),
      recover: () => ({
        text: `GPU 温度回落到 ${gpuTemp === null ? 'n/a' : `${gpuTemp.toFixed(0)}°C`},低于阈值 ${cfg.gpuTempC}°C。`,
        meta: { kind: 'threshold', signal: 'gpu_temp', value: gpuTemp, threshold: cfg.gpuTempC },
      }),
    });

    const mem = sample.mem?.usedPercent ?? null;
    stepPersistent('mem', mem !== null && mem >= cfg.memPercent, 1, {
      alert: () => ({
        text: `内存使用 ${formatPercent(mem)},达到阈值 ${cfg.memPercent}%。`,
        meta: { kind: 'threshold', signal: 'mem', value: mem, threshold: cfg.memPercent },
      }),
      recover: () => ({
        text: `内存使用回落到 ${formatPercent(mem)},低于阈值 ${cfg.memPercent}%。`,
        meta: { kind: 'threshold', signal: 'mem', value: mem, threshold: cfg.memPercent },
      }),
    });

    const load = sample.cpu?.loadPercent ?? null;
    stepPersistent('cpu_load', load !== null && load >= cfg.cpuLoadPercent, 1, {
      alert: () => ({
        text: `整机 CPU 负载 ${formatPercent(load)},达到阈值 ${cfg.cpuLoadPercent}%。`,
        meta: { kind: 'threshold', signal: 'cpu_load', value: load, threshold: cfg.cpuLoadPercent },
      }),
      recover: () => ({
        text: `整机 CPU 负载回落到 ${formatPercent(load)},低于阈值 ${cfg.cpuLoadPercent}%。`,
        meta: { kind: 'threshold', signal: 'cpu_load', value: load, threshold: cfg.cpuLoadPercent },
      }),
    });
  }

  // ── 持续型异常信号(anomaliesEnabled + 各自开关) ───────────────────
  if (cfg.anomaliesEnabled) {
    if (cfg.watchProcessCpu) {
      const proc = topProcessByCpu(sample.processes);
      const cond = proc !== null && proc.cpuPercent !== null && proc.cpuPercent >= cfg.processCpuPercent;
      stepPersistent('process_cpu', cond, Math.max(1, cfg.sustainSamples), {
        alert: () => ({
          text: `进程 ${proc!.name} (PID ${proc!.pid}) 连续约 ${cfg.sustainMinutes} 分钟 CPU ${formatPercent(proc!.cpuPercent, 1)},高于阈值 ${cfg.processCpuPercent}%${proc!.path ? `,路径 ${proc!.path}` : ''}。`,
          meta: { kind: 'anomaly', signal: 'process_cpu', name: proc!.name, pid: proc!.pid, cpu: proc!.cpuPercent, threshold: cfg.processCpuPercent },
        }),
        recover: () => ({
          text: `进程 ${proc?.name ?? 'n/a'} 的 CPU 已回落到 ${formatPercent(proc?.cpuPercent ?? null, 1)},低于阈值 ${cfg.processCpuPercent}%。`,
          meta: { kind: 'anomaly', signal: 'process_cpu', name: proc?.name ?? null, pid: proc?.pid ?? null, threshold: cfg.processCpuPercent },
        }),
      });
    }

    if (cfg.watchGpu) {
      const util = maxGpuUtil(sample.gpus);
      stepPersistent('gpu', util !== null && util >= cfg.gpuPercent, Math.max(1, cfg.sustainSamples), {
        alert: () => ({
          text: `GPU 使用率 ${formatPercent(util)},连续约 ${cfg.sustainMinutes} 分钟高于阈值 ${cfg.gpuPercent}%。`,
          meta: { kind: 'anomaly', signal: 'gpu', value: util, threshold: cfg.gpuPercent },
        }),
        recover: () => ({
          text: `GPU 使用率回落到 ${formatPercent(util)},低于阈值 ${cfg.gpuPercent}%。`,
          meta: { kind: 'anomaly', signal: 'gpu', value: util, threshold: cfg.gpuPercent },
        }),
      });
    }

    if (cfg.watchDiskIo) {
      const total = diskIoTotalMbs(sample.diskIo);
      const load = sample.cpu?.loadPercent ?? null;
      const cond = total !== null && total >= cfg.diskIoMbs && (load === null || load < DISK_IO_CPU_CEILING);
      stepPersistent('disk_io', cond, Math.max(1, cfg.sustainSamples), {
        alert: () => ({
          text: `磁盘读写合计 ${total!.toFixed(1)} MB/s,连续约 ${cfg.sustainMinutes} 分钟高于阈值 ${cfg.diskIoMbs} MB/s,同期 CPU 负载 ${formatPercent(load)}。`,
          meta: { kind: 'anomaly', signal: 'disk_io', value: total, threshold: cfg.diskIoMbs, cpu: load },
        }),
        recover: () => ({
          text: `磁盘读写合计回落到 ${total === null ? 'n/a' : `${total.toFixed(1)} MB/s`},低于阈值 ${cfg.diskIoMbs} MB/s。`,
          meta: { kind: 'anomaly', signal: 'disk_io', value: total, threshold: cfg.diskIoMbs },
        }),
      });
    }

    if (cfg.watchDiskDrop) {
      const current = freeBytesByMount(sample.disks);
      next.diskFreeHistory.push(current);
      while (next.diskFreeHistory.length > Math.max(2, cfg.sustainSamples)) next.diskFreeHistory.shift();

      let worst: { mount: string; before: number; after: number; pct: number } | null = null;
      const oldest = next.diskFreeHistory[0];
      if (next.diskFreeHistory.length >= 2) {
        for (const [mount, before] of Object.entries(oldest)) {
          const after = current[mount];
          if (after === undefined || before <= 0) continue;
          const pct = ((before - after) / before) * 100;
          if (pct >= cfg.diskDropPercent && (worst === null || pct > worst.pct)) {
            worst = { mount, before, after, pct };
          }
        }
      }
      stepPersistent('disk_drop', worst !== null, 1, {
        alert: () => ({
          text: `分区 ${worst!.mount} 可用空间从 ${formatBytes(worst!.before)} 降到 ${formatBytes(worst!.after)},降幅 ${worst!.pct.toFixed(1)}%(阈值 ${cfg.diskDropPercent}%)。`,
          meta: { kind: 'anomaly', signal: 'disk_drop', mount: worst!.mount, before: worst!.before, after: worst!.after, percent: worst!.pct, threshold: cfg.diskDropPercent },
        }),
        recover: () => ({
          text: '磁盘可用空间不再快速下降。',
          meta: { kind: 'anomaly', signal: 'disk_drop' },
        }),
      });
    }

    if (cfg.watchDiskLatency) {
      const latency = sample.diskIo?.latencyMs ?? null;
      stepPersistent('disk_latency', latency !== null && latency >= cfg.diskLatencyMs, Math.max(1, cfg.sustainSamples), {
        alert: () => ({
          text: `磁盘平均响应时间 ${latency!.toFixed(2)} ms,连续约 ${cfg.sustainMinutes} 分钟高于阈值 ${cfg.diskLatencyMs} ms。`,
          meta: { kind: 'anomaly', signal: 'disk_latency', value: latency, threshold: cfg.diskLatencyMs },
        }),
        recover: () => ({
          text: `磁盘平均响应时间回落到 ${latency === null ? 'n/a' : `${latency.toFixed(2)} ms`},低于阈值 ${cfg.diskLatencyMs} ms。`,
          meta: { kind: 'anomaly', signal: 'disk_latency', value: latency, threshold: cfg.diskLatencyMs },
        }),
      });
    }

    if (cfg.watchEventLog) {
      const count = input.eventLogErrorCount;
      stepPersistent('event_log', count !== null && count >= cfg.eventLogErrors, Math.max(1, cfg.sustainSamples), {
        alert: () => ({
          text: `最近一个采样窗口内 Windows 应用/系统日志有 ${count} 条错误事件,高于阈值 ${cfg.eventLogErrors}。`,
          meta: { kind: 'anomaly', signal: 'event_log', value: count, threshold: cfg.eventLogErrors },
        }),
        recover: () => ({
          text: 'Windows 应用/系统日志的错误事件数回落到阈值以下。',
          meta: { kind: 'anomaly', signal: 'event_log' },
        }),
      });
    }

    // ── 事件型异常信号 ────────────────────────────────────────────────
    if (cfg.watchRestart) {
      const uptime = sample.uptimeSeconds ?? null;
      if (uptime !== null && next.uptimeBaseline !== null && uptime < next.uptimeBaseline - 120) {
        const before = next.uptimeBaseline;
        next.uptimeBaseline = uptime;
        stepEpisodic('restart', `restart:${uptime}`, () => ({
          text: `开机时长从 ${Math.round(before / 60)} 分钟变成 ${Math.round(uptime / 60)} 分钟,系统在两次采样之间重启过。`,
          meta: { kind: 'anomaly', signal: 'restart', before, after: uptime },
        }));
      } else if (uptime !== null && next.uptimeBaseline === null) {
        next.uptimeBaseline = uptime;
      }
    }

    if (cfg.watchStartup && input.startupCurrent !== null) {
      if (next.startupBaseline === null) {
        next.startupBaseline = [...input.startupCurrent];
      } else {
        const added = newEntries(next.startupBaseline, input.startupCurrent);
        if (added.length > 0) {
          next.startupBaseline = [...input.startupCurrent];
          stepEpisodic('startup', added.join('|'), () => ({
            text: `检测到新增自启动项: ${added.slice(0, 5).join('; ')}${added.length > 5 ? ` 等 ${added.length} 项` : ''}。`,
            meta: { kind: 'anomaly', signal: 'startup', entries: added },
          }));
        }
      }
    }

    if (cfg.watchImpostor) {
      const findings = findImpostors(sample.processes);
      if (findings.length > 0) {
        const key = findings.map((finding) => `${finding.pid}:${finding.name}`).sort().join('|');
        stepEpisodic('impostor', key, () => ({
          text: `发现可疑进程: ${findings.slice(0, 3).map((finding) => `${finding.name} (PID ${finding.pid}, ${finding.reason}${finding.path ? `, 路径 ${finding.path}` : ''})`).join('; ')}${findings.length > 3 ? ` 等 ${findings.length} 个` : ''}。`,
          meta: { kind: 'anomaly', signal: 'impostor', findings },
        }));
      }
    }

    if (cfg.watchConnections) {
      const groups = establishedByProcess(sample.connections).filter((group) => group.count >= cfg.connectionsCount);
      if (groups.length > 0) {
        const key = groups.map((group) => `${group.name}:${group.count}`).join('|');
        stepEpisodic('connections', key, () => ({
          text: `进程 ${groups.slice(0, 3).map((group) => `${group.name} 有 ${group.count} 个已建立外联连接`).join('; ')}${groups.length > 3 ? ` 等 ${groups.length} 组` : ''}。`,
          meta: { kind: 'anomaly', signal: 'connections', groups },
        }));
      }
    }

    if (cfg.watchScheduledTasks && input.scheduledTasksCurrent !== null) {
      if (next.tasksBaseline === null) {
        next.tasksBaseline = [...input.scheduledTasksCurrent];
      } else {
        const added = newEntries(next.tasksBaseline, input.scheduledTasksCurrent);
        if (added.length > 0) {
          next.tasksBaseline = [...input.scheduledTasksCurrent];
          stepEpisodic('scheduled_tasks', added.join('|'), () => ({
            text: `检测到新增计划任务: ${added.slice(0, 5).join('; ')}${added.length > 5 ? ` 等 ${added.length} 项` : ''}。`,
            meta: { kind: 'anomaly', signal: 'scheduled_tasks', entries: added },
          }));
        }
      }
    }
  }

  return { state: next, events };
}

/** 已启用的信号一览,给环境提示词与操作员看。 */
export function enabledSignalSummary(cfg: AnomalyConfig): string {
  const names: string[] = [];
  if (cfg.alertsEnabled) names.push('温度/内存/整机负载阈值');
  if (!cfg.anomaliesEnabled) return names.join(', ') || '无';
  if (cfg.watchProcessCpu) names.push('单进程持续高 CPU');
  if (cfg.watchGpu) names.push('GPU 持续满载');
  if (cfg.watchDiskIo) names.push('磁盘持续高读写');
  if (cfg.watchDiskDrop) names.push('磁盘空间骤降');
  if (cfg.watchRestart) names.push('意外重启');
  if (cfg.watchStartup) names.push('新增自启动项');
  if (cfg.watchImpostor) names.push('伪装系统进程');
  if (cfg.watchConnections) names.push('外联连接异常');
  if (cfg.watchEventLog) names.push('日志错误风暴');
  if (cfg.watchDiskLatency) names.push('磁盘响应时间持续高');
  if (cfg.watchScheduledTasks) names.push('新增计划任务');
  return names.join(', ') || '无';
}
