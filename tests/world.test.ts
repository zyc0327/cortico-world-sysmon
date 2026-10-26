import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { SYSMON } from '../src/definition.ts';
import { SYSMON_DEFAULTS, type SysmonConfigSection } from '../src/config.ts';
import { SYS_TOOL_DECLS, SysmonWorld, type SysmonDeps } from '../src/world.ts';
import type { SysSample } from '../src/sensors.ts';
import { FakeHost } from './helpers/fake-host.ts';

let scratchDir: string;
beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), 'sysmon-world-'));
});
afterEach(() => {
  rmSync(scratchDir, { recursive: true, force: true });
  vi.useRealTimers();
});

const call = {} as ToolCallContext;

function sample(overrides: Partial<SysSample> = {}): SysSample {
  return {
    tsMs: 0,
    os: 'Windows 11 Pro',
    platform: 'Windows 11',
    arch: 'x64',
    uptimeSeconds: 10_000,
    cpu: {
      model: 'Intel Core i7-12700H',
      cores: 8,
      physicalCores: 4,
      speedGhz: 3.2,
      loadPercent: 23,
      loadUserPercent: 20,
      loadSystemPercent: 3,
      perCorePercent: [10, 20],
      tempMainC: 58,
      tempMaxC: 63,
      tempCoresC: [55, 63],
    },
    mem: {
      totalBytes: 32 * 1024 ** 3,
      usedBytes: 11.2 * 1024 ** 3,
      availableBytes: 20.8 * 1024 ** 3,
      freeBytes: 10 * 1024 ** 3,
      swapTotalBytes: 8 * 1024 ** 3,
      swapUsedBytes: 0.4 * 1024 ** 3,
      usedPercent: 35,
    },
    gpus: [],
    disks: [{
      mount: 'C:',
      fs: 'NTFS',
      sizeBytes: 500 * 1024 ** 3,
      usedBytes: 210 * 1024 ** 3,
      availableBytes: 290 * 1024 ** 3,
      usePercent: 42,
      rw: true,
    }],
    diskHealth: [],
    diskIo: { readMBs: 1, writeMBs: 1, latencyMs: 0.5 },
    processes: [
      { pid: 100, name: 'chrome.exe', cpuPercent: 12.3, memPercent: 3.4, memRssBytes: 512 * 1024 ** 2, path: 'C:\\Program Files\\Google\\Chrome\\chrome.exe' },
      { pid: 4, name: 'System Idle Process', cpuPercent: 99, memPercent: 0, memRssBytes: 0, path: null },
    ],
    connections: [],
    ...overrides,
  };
}

function makeWorld(overrides: Partial<SysmonConfigSection> = {}, deps: Partial<SysmonDeps> = {}): SysmonWorld {
  return new SysmonWorld({
    cfg: { ...SYSMON_DEFAULTS, ...overrides },
    timezone: 'Asia/Shanghai',
    deps: {
      collectSnapshot: async () => sample(),
      collectStartupEntries: async () => [],
      countEventLogErrors: async () => 0,
      collectScheduledTasks: async () => [],
      ...deps,
    },
  });
}

describe('System Monitor World', () => {
  it('干装载不报失败:装载器会接受它', async () => {
    const report = await dryMountWorld(SYSMON, { scratchDir });
    expect(report.failures).toEqual([]);
  });

  it('工具名与声明、describe.json 完全一致', () => {
    const world = makeWorld();
    const instanceNames = world.tools().map((tool) => tool.name).sort();
    expect(instanceNames).toEqual(SYS_TOOL_DECLS.map((tool) => tool.name).sort());

    const describeJson = JSON.parse(readFileSync(new URL('../describe.json', import.meta.url), 'utf8')) as {
      tools: unknown;
      events: unknown;
      prompts: unknown;
    };
    expect(describeJson.tools).toEqual(SYSMON.describe?.tools);
    expect(describeJson.events).toEqual(SYSMON.describe?.events);

    const decl = SYSMON.create(fakeWorldContext(SYSMON, { scratchDir, packageDir: join(scratchDir, 'pkg') }));
    const doc = decl.webUi?.('zh').promptDocs?.find((entry) => entry.role === 'envPrompt');
    expect(doc).toBeDefined();
    expect(describeJson.prompts).toEqual([{
      key: doc!.key,
      title: doc!.title,
      role: doc!.role,
      content: readFileSync(doc!.path, 'utf8'),
    }]);
  });

  it('挂载时推 sysmon.started,其它事件不计入', async () => {
    const host = new FakeHost();
    const world = makeWorld();
    await world.start(host);
    expect(host.events.map((event) => event.type)).toEqual(['sysmon.started']);
    expect(host.events[0].origin).toBe('internal');
    await world.stop();
  });

  it('sysmon_status 输出各段,缺失值显示 n/a', async () => {
    const host = new FakeHost();
    const world = makeWorld({}, {
      collectSnapshot: async () => sample({ gpus: [], diskIo: null, diskHealth: [] }),
    });
    await world.start(host);
    const tool = world.tools().find((entry) => entry.name === 'sysmon_status')!;
    const outcome = await tool.handler({}, call) as { text: string };
    expect(outcome.text).toContain('CPU: Intel Core i7-12700H');
    expect(outcome.text).toContain('内存:');
    expect(outcome.text).toContain('磁盘: C:');
    expect(outcome.text).toContain('异常监控:');
    await world.stop();
  });

  it('sysmon_status 在采集失败时给出失败回执', async () => {
    const host = new FakeHost();
    const world = makeWorld({}, {
      collectSnapshot: async () => {
        throw new Error('sensors unavailable');
      },
    });
    await world.start(host);
    const tool = world.tools().find((entry) => entry.name === 'sysmon_status')!;
    const outcome = await tool.handler({}, call);
    expect(outcome).toMatchObject({ failed: true });
    expect(String((outcome as { text: string }).text)).toContain('采集失败');
    await world.stop();
  });

  it('sysmon_processes 限制条数并按 CPU/内存排序', async () => {
    const host = new FakeHost();
    const world = makeWorld({ processesTopDefault: 2 });
    await world.start(host);
    const tool = world.tools().find((entry) => entry.name === 'sysmon_processes')!;

    const byCpu = (await tool.handler({}, call) as { text: string }).text;
    expect(byCpu).toContain('chrome.exe');
    expect(byCpu).not.toContain('System Idle Process');

    const byMem = (await tool.handler({ sortBy: 'mem', top: 1 }, call) as { text: string }).text;
    expect(byMem).toContain('chrome.exe');
    expect(byMem.trim().split('\n').filter((line) => line.startsWith('- '))).toHaveLength(1);
    await world.stop();
  });

  it('定时采样:温度越过阈值推 alert,回落后推 recover', async () => {
    vi.useFakeTimers();
    let current = sample({ cpu: { ...sample().cpu!, tempMainC: 95 } });
    const host = new FakeHost();
    const world = makeWorld({
      intervalSeconds: 30,
      alertsEnabled: true,
      anomaliesEnabled: false,
      watchStartup: false,
      watchScheduledTasks: false,
    }, {
      collectSnapshot: async () => current,
    });
    await world.start(host);
    expect(host.events.map((event) => event.type)).toEqual(['sysmon.started']);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(host.events.map((event) => event.type)).toEqual(['sysmon.started', 'sysmon.alert']);
    expect(host.events[1].text).toContain('CPU 温度');
    expect(host.events[1].meta).toMatchObject({ kind: 'threshold', signal: 'cpu_temp' });

    current = sample({ cpu: { ...sample().cpu!, tempMainC: 80 } });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(host.events.map((event) => event.type)).toEqual(['sysmon.started', 'sysmon.alert', 'sysmon.recover']);
    await world.stop();
  });

  it('默认只查询:告警与异常都关着时不采样', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const host = new FakeHost();
    const world = makeWorld({ intervalSeconds: 30 }, {
      collectSnapshot: async () => {
        calls += 1;
        return sample();
      },
    });
    await world.start(host);
    await vi.advanceTimersByTimeAsync(30_000 * 3);
    expect(calls).toBe(0);
    expect(host.events.map((event) => event.type)).toEqual(['sysmon.started']);
    await world.stop();
  });

  it('定时采样:单进程持续高 CPU 在持续窗口后告警', async () => {
    vi.useFakeTimers();
    const hot = sample({
      processes: [{ pid: 777, name: 'xmrig.exe', cpuPercent: 85, memPercent: 2, memRssBytes: 100, path: 'C:\\Users\\me\\xmrig.exe' }],
    });
    const host = new FakeHost();
    const world = makeWorld({
      intervalSeconds: 30,
      anomaliesEnabled: true,
      anomalySustainMinutes: 1,
      watchProcessCpu: true,
      watchStartup: false,
      watchScheduledTasks: false,
    }, {
      collectSnapshot: async () => hot,
    });
    await world.start(host);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(host.events.map((event) => event.type)).toEqual(['sysmon.started']);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(host.events.map((event) => event.type)).toEqual(['sysmon.started', 'sysmon.alert']);
    expect(host.events[1].text).toContain('xmrig.exe');
    await world.stop();
  });

  it('默认不读事件日志;开启后读取失败不影响采样', async () => {
    let eventLogCalls = 0;
    vi.useFakeTimers();
    const host = new FakeHost();
    const world = makeWorld({ intervalSeconds: 30, anomaliesEnabled: true, watchStartup: false, watchScheduledTasks: false, watchEventLog: true }, {
      countEventLogErrors: async () => {
        eventLogCalls += 1;
        return null;
      },
    });
    await world.start(host);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(eventLogCalls).toBe(1);
    await world.stop();
  });

  it('新增自启动项在重扫后推事件', async () => {
    vi.useFakeTimers();
    let entries = ['a @ Run'];
    const host = new FakeHost();
    const world = makeWorld({
      intervalSeconds: 30,
      anomaliesEnabled: true,
      anomalySustainMinutes: 1,
      watchStartup: true,
    }, {
      collectStartupEntries: async () => entries,
    });
    await world.start(host);
    await vi.advanceTimersByTimeAsync(30_000 * 5);
    entries = ['a @ Run', 'b @ Run'];
    await vi.advanceTimersByTimeAsync(30_000 * 5);
    const startup = host.events.find((event) => event.meta?.signal === 'startup');
    expect(startup).toBeDefined();
    expect(startup!.text).toContain('b @ Run');
    await world.stop();
  });

  it('停止后不再采样', async () => {
    vi.useFakeTimers();
    const host = new FakeHost();
    const world = makeWorld({ intervalSeconds: 30, alertsEnabled: true, watchStartup: false, watchScheduledTasks: false });
    await world.start(host);
    await vi.advanceTimersByTimeAsync(30_000);
    const count = host.events.length;
    await world.stop();
    await vi.advanceTimersByTimeAsync(30_000 * 5);
    expect(host.events).toHaveLength(count);
  });
});
