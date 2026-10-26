import { describe, it, expect } from 'vitest';
import { evaluate, initialEngineState, enabledSignalSummary, type AnomalyConfig, type AnomalyInput } from '../src/anomaly.ts';
import type { SysSample } from '../src/sensors.ts';

function sample(overrides: Partial<SysSample> = {}): SysSample {
  return {
    tsMs: 0,
    os: 'Windows 11 Pro',
    platform: 'Windows 11',
    arch: 'x64',
    uptimeSeconds: 10_000,
    cpu: {
      model: 'cpu',
      cores: 4,
      physicalCores: 2,
      speedGhz: 3,
      loadPercent: 10,
      loadUserPercent: 8,
      loadSystemPercent: 2,
      perCorePercent: null,
      tempMainC: 50,
      tempMaxC: 55,
      tempCoresC: null,
    },
    mem: {
      totalBytes: 8 * 1024 ** 3,
      usedBytes: 2 * 1024 ** 3,
      availableBytes: 6 * 1024 ** 3,
      freeBytes: 6 * 1024 ** 3,
      swapTotalBytes: 0,
      swapUsedBytes: 0,
      usedPercent: 25,
    },
    gpus: [],
    disks: [],
    diskHealth: [],
    diskIo: null,
    processes: [],
    connections: [],
    ...overrides,
  };
}

function cfg(overrides: Partial<AnomalyConfig> = {}): AnomalyConfig {
  return {
    alertsEnabled: true,
    anomaliesEnabled: true,
    cpuTempC: 90,
    gpuTempC: 85,
    memPercent: 90,
    cpuLoadPercent: 90,
    processCpuPercent: 70,
    gpuPercent: 90,
    diskIoMbs: 60,
    diskDropPercent: 2,
    connectionsCount: 2,
    eventLogErrors: 20,
    diskLatencyMs: 200,
    sustainSamples: 2,
    cooldownSamples: 3,
    sustainMinutes: 1,
    watchProcessCpu: false,
    watchGpu: false,
    watchDiskIo: false,
    watchDiskDrop: false,
    watchRestart: false,
    watchStartup: false,
    watchImpostor: false,
    watchConnections: false,
    watchEventLog: false,
    watchDiskLatency: false,
    watchScheduledTasks: false,
    ...overrides,
  };
}

function input(overrides: Partial<AnomalyInput> = {}): AnomalyInput {
  return {
    sample: sample(),
    prevUptimeSeconds: 10_000,
    startupCurrent: null,
    scheduledTasksCurrent: null,
    eventLogErrorCount: null,
    ...overrides,
  };
}

describe('阈值信号', () => {
  it('CPU 温度越过阈值告警,回落后恢复', () => {
    let state = initialEngineState();
    const config = cfg();

    let result = evaluate(state, input({ sample: sample({ cpu: { ...sample().cpu!, tempMainC: 95 } }) }), config);
    state = result.state;
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ type: 'sysmon.alert', signal: 'cpu_temp' });

    result = evaluate(state, input({ sample: sample({ cpu: { ...sample().cpu!, tempMainC: 80 } }) }), config);
    state = result.state;
    expect(result.events).toHaveLength(0);
    result = evaluate(state, input({ sample: sample({ cpu: { ...sample().cpu!, tempMainC: 80 } }) }), config);
    expect(result.events[0]).toMatchObject({ type: 'sysmon.recover', signal: 'cpu_temp' });
  });

  it('关闭阈值告警后温度高也不推事件', () => {
    const config = cfg({ alertsEnabled: false });
    const result = evaluate(initialEngineState(), input({ sample: sample({ cpu: { ...sample().cpu!, tempMainC: 99 } }) }), config);
    expect(result.events).toHaveLength(0);
  });
});

describe('持续型异常', () => {
  const hotProcess = (cpu: number) => sample({
    processes: [{ pid: 777, name: 'xmrig.exe', cpuPercent: cpu, memPercent: 2, memRssBytes: 100, path: 'C:\\Users\\me\\xmrig.exe' }],
  });

  it('单进程持续高 CPU:连续两个采样才告警,冷却期内不重复', () => {
    let state = initialEngineState();
    const config = cfg({ watchProcessCpu: true, sustainSamples: 2, cooldownSamples: 3 });

    let result = evaluate(state, input({ sample: hotProcess(85) }), config);
    state = result.state;
    expect(result.events).toHaveLength(0);

    result = evaluate(state, input({ sample: hotProcess(85) }), config);
    state = result.state;
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ type: 'sysmon.alert', signal: 'process_cpu' });
    expect(result.events[0].text).toContain('xmrig.exe');

    // 冷却期内再次高 CPU 不重复告警
    result = evaluate(state, input({ sample: hotProcess(85) }), config);
    state = result.state;
    expect(result.events).toHaveLength(0);
  });

  it('持续型异常两次回落后恢复', () => {
    let state = initialEngineState();
    const config = cfg({ watchProcessCpu: true, sustainSamples: 1, cooldownSamples: 0 });

    let result = evaluate(state, input({ sample: hotProcess(85) }), config);
    state = result.state;
    expect(result.events).toHaveLength(1);

    result = evaluate(state, input({ sample: hotProcess(5) }), config);
    state = result.state;
    expect(result.events).toHaveLength(0);
    result = evaluate(state, input({ sample: hotProcess(5) }), config);
    expect(result.events[0]).toMatchObject({ type: 'sysmon.recover', signal: 'process_cpu' });
  });

  it('磁盘读写高且 CPU 低才告警', () => {
    const config = cfg({ watchDiskIo: true, sustainSamples: 1 });
    const busyDisk = sample({
      cpu: { ...sample().cpu!, loadPercent: 10 },
      diskIo: { readMBs: 120, writeMBs: 10, latencyMs: 5 },
    });
    let result = evaluate(initialEngineState(), input({ sample: busyDisk }), config);
    expect(result.events[0]).toMatchObject({ type: 'sysmon.alert', signal: 'disk_io' });

    const busyCpu = sample({
      cpu: { ...sample().cpu!, loadPercent: 95 },
      diskIo: { readMBs: 120, writeMBs: 10, latencyMs: 5 },
    });
    result = evaluate(initialEngineState(), input({ sample: busyCpu }), cfg({ watchDiskIo: true, sustainSamples: 1, alertsEnabled: false }));
    expect(result.events).toHaveLength(0);
  });

  it('磁盘可用空间骤降', () => {
    const config = cfg({ watchDiskDrop: true, sustainSamples: 3, diskDropPercent: 5 });
    const disk = (freeGb: number) => sample({
      disks: [{ mount: 'C:', fs: 'NTFS', sizeBytes: 1000 * 1024 ** 3, usedBytes: (1000 - freeGb) * 1024 ** 3, availableBytes: freeGb * 1024 ** 3, usePercent: 50, rw: true }],
    });

    let state = initialEngineState();
    state = evaluate(state, input({ sample: disk(500) }), config).state;
    state = evaluate(state, input({ sample: disk(500) }), config).state;
    const result = evaluate(state, input({ sample: disk(460) }), config);
    expect(result.events[0]).toMatchObject({ type: 'sysmon.alert', signal: 'disk_drop' });
    expect(result.events[0].text).toContain('C:');
  });

  it('Windows 日志错误数超过阈值', () => {
    const config = cfg({ watchEventLog: true, sustainSamples: 1, eventLogErrors: 20 });
    let state = initialEngineState();
    let result = evaluate(state, input({ eventLogErrorCount: 30 }), config);
    state = result.state;
    expect(result.events[0]).toMatchObject({ type: 'sysmon.alert', signal: 'event_log' });

    result = evaluate(state, input({ eventLogErrorCount: 5 }), config);
    state = result.state;
    result = evaluate(state, input({ eventLogErrorCount: 5 }), config);
    expect(result.events[0]).toMatchObject({ type: 'sysmon.recover', signal: 'event_log' });
  });
});

describe('事件型异常', () => {
  it('重启:开机时长回退', () => {
    const config = cfg({ watchRestart: true, cooldownSamples: 0 });
    let state = initialEngineState();
    state = evaluate(state, input({ sample: sample({ uptimeSeconds: 10_000 }) }), config).state;
    const result = evaluate(state, input({ sample: sample({ uptimeSeconds: 300 }), prevUptimeSeconds: 10_000 }), config);
    expect(result.events[0]).toMatchObject({ type: 'sysmon.alert', signal: 'restart' });
    expect(result.events[0].text).toContain('重启');
  });

  it('新增自启动项只在出现时告警一次', () => {
    const config = cfg({ watchStartup: true, cooldownSamples: 0 });
    let state = initialEngineState();
    state = evaluate(state, input({ startupCurrent: ['a @ Run'] }), config).state;
    let result = evaluate(state, input({ startupCurrent: ['a @ Run', 'b @ Run'] }), config);
    state = result.state;
    expect(result.events[0]).toMatchObject({ type: 'sysmon.alert', signal: 'startup' });
    expect(result.events[0].text).toContain('b @ Run');

    result = evaluate(state, input({ startupCurrent: ['a @ Run', 'b @ Run'] }), config);
    expect(result.events).toHaveLength(0);
  });

  it('伪装系统进程只报一次', () => {
    const config = cfg({ watchImpostor: true, cooldownSamples: 0 });
    const impostorSample = sample({
      processes: [{ pid: 42, name: 'svch0st.exe', cpuPercent: 5, memPercent: 1, memRssBytes: 100, path: 'C:\\Users\\me\\svch0st.exe' }],
    });
    let state = initialEngineState();
    let result = evaluate(state, input({ sample: impostorSample }), config);
    state = result.state;
    expect(result.events[0]).toMatchObject({ type: 'sysmon.alert', signal: 'impostor' });

    result = evaluate(state, input({ sample: impostorSample }), config);
    expect(result.events).toHaveLength(0);
  });

  it('单进程外联连接数超过阈值', () => {
    const config = cfg({ watchConnections: true, cooldownSamples: 0 });
    const connections = [1, 2, 3].map((index) => ({
      pid: 50,
      process: 'miner.exe',
      peerAddress: `1.1.1.${index}`,
      peerPort: 3333,
      state: 'ESTABLISHED',
    }));
    const result = evaluate(initialEngineState(), input({ sample: sample({ connections }) }), config);
    expect(result.events[0]).toMatchObject({ type: 'sysmon.alert', signal: 'connections' });
    expect(result.events[0].text).toContain('miner.exe');
  });

  it('新增计划任务', () => {
    const config = cfg({ watchScheduledTasks: true, cooldownSamples: 0 });
    let state = initialEngineState();
    state = evaluate(state, input({ scheduledTasksCurrent: ['t1 @ \\'] }), config).state;
    const result = evaluate(state, input({ scheduledTasksCurrent: ['t1 @ \\', 't2 @ \\'] }), config);
    expect(result.events[0]).toMatchObject({ type: 'sysmon.alert', signal: 'scheduled_tasks' });
    expect(result.events[0].text).toContain('t2');
  });

  it('关闭异常监控后所有异常信号都不推', () => {
    const config = cfg({ anomaliesEnabled: false, watchRestart: true, watchImpostor: true });
    const result = evaluate(initialEngineState(), input({
      sample: sample({ uptimeSeconds: 100, processes: [{ pid: 1, name: 'svch0st.exe', cpuPercent: null, memPercent: null, memRssBytes: null, path: 'C:\\x\\svch0st.exe' }] }),
    }), config);
    expect(result.events).toHaveLength(0);
  });
});

describe('enabledSignalSummary', () => {
  it('列出启用的信号', () => {
    expect(enabledSignalSummary(cfg({ watchProcessCpu: true }))).toContain('单进程持续高 CPU');
    expect(enabledSignalSummary(cfg({ alertsEnabled: false, anomaliesEnabled: false }))).toBe('无');
  });
});
