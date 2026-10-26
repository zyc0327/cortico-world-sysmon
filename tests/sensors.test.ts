import { describe, it, expect } from 'vitest';
import {
  EXCLUDED_PROCESS_NAMES,
  cpuTempOf,
  diskIoTotalMbs,
  establishedByProcess,
  findImpostors,
  formatBytes,
  formatGhz,
  formatPercent,
  formatProcesses,
  formatStatus,
  formatTempC,
  formatUptime,
  freeBytesByMount,
  levenshtein,
  maxGpuTemp,
  maxGpuUtil,
  nearSystemProcessName,
  newEntries,
  parseCounterOutput,
  resolveConnectionNames,
  topProcessByCpu,
  type SysSample,
} from '../src/sensors.ts';

function sample(overrides: Partial<SysSample> = {}): SysSample {
  return {
    tsMs: 0,
    os: 'Windows 11 Pro',
    platform: 'Windows 11',
    arch: 'x64',
    uptimeSeconds: 90061,
    cpu: {
      model: 'Intel Core i7-12700H',
      cores: 8,
      physicalCores: 4,
      speedGhz: 3.2,
      loadPercent: 23,
      loadUserPercent: 20,
      loadSystemPercent: 3,
      perCorePercent: [10, 20, 30, 40],
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
    gpus: [{
      model: 'NVIDIA GeForce RTX 3060',
      vramBytes: 12 * 1024 ** 3,
      usedBytes: 4.2 * 1024 ** 3,
      utilPercent: 41,
      tempC: 57,
      powerW: 65,
      fanPercent: 45,
    }],
    disks: [{
      mount: 'C:',
      fs: 'NTFS',
      sizeBytes: 500 * 1024 ** 3,
      usedBytes: 210 * 1024 ** 3,
      availableBytes: 290 * 1024 ** 3,
      usePercent: 42,
      rw: true,
    }],
    diskHealth: [{ name: 'ST1000DM003', status: 'OK' }],
    diskIo: { readMBs: 12.3, writeMBs: 2.1, latencyMs: 0.8 },
    processes: [
      { pid: 100, name: 'chrome.exe', cpuPercent: 12.3, memPercent: 3.4, memRssBytes: 512 * 1024 ** 2, path: 'C:\\Program Files\\Google\\Chrome\\chrome.exe' },
      { pid: 4, name: 'System Idle Process', cpuPercent: 99, memPercent: 0, memRssBytes: 0, path: null },
      { pid: 200, name: 'svchost.exe', cpuPercent: 1, memPercent: 0.5, memRssBytes: 64 * 1024 ** 2, path: 'C:\\Windows\\System32\\svchost.exe' },
    ],
    connections: [],
    ...overrides,
  };
}

describe('格式化', () => {
  it('字节与百分比', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(12.3 * 1024 ** 3)).toBe('12.3 GB');
    expect(formatBytes(null)).toBe('n/a');
    expect(formatPercent(42.4)).toBe('42%');
    expect(formatPercent(null)).toBe('n/a');
    expect(formatTempC(58.6)).toBe('59°C');
    expect(formatGhz(null)).toBe('n/a');
    expect(formatUptime(90061)).toBe('1 天 1 小时');
    expect(formatUptime(3700)).toBe('1 小时 1 分钟');
    expect(formatUptime(null)).toBe('n/a');
  });

  it('状态快照包含各段并显示 n/a', () => {
    const text = formatStatus(sample());
    expect(text).toContain('系统: Windows 11 Pro · x64 · 已运行 1 天 1 小时');
    expect(text).toContain('CPU: Intel Core i7-12700H');
    expect(text).toContain('每核负载');
    expect(text).toContain('内存: 11.2 GB / 32.0 GB (35%)');
    expect(text).toContain('GPU: NVIDIA GeForce RTX 3060');
    expect(text).toContain('磁盘: C: (NTFS) 210 GB / 500 GB (42%)');
    expect(text).toContain('磁盘健康: ST1000DM003 (OK)');
    expect(text).toContain('磁盘 IO: 读 12.3 MB/s');
    expect(text).toContain('温度: CPU 58°C · 核心最高 63°C');

    const empty = formatStatus(sample({ cpu: null, mem: null, gpus: [], disks: [], diskHealth: [], diskIo: null }));
    expect(empty).toContain('n/a');
    expect(empty).not.toContain('GPU:');
  });

  it('进程列表按 CPU 或内存排序,排除系统伪进程', () => {
    const processes = [
      { pid: 1, name: 'a.exe', cpuPercent: 5, memPercent: 50, memRssBytes: 100, path: null },
      { pid: 2, name: 'b.exe', cpuPercent: 60, memPercent: 10, memRssBytes: 200, path: null },
      { pid: 3, name: 'System Idle Process', cpuPercent: 99, memPercent: 0, memRssBytes: 0, path: null },
    ];
    const byCpu = formatProcesses(processes, { top: 2, sortBy: 'cpu' });
    expect(byCpu.indexOf('b.exe')).toBeLessThan(byCpu.indexOf('a.exe'));
    expect(byCpu).not.toContain('System Idle Process');

    const byMem = formatProcesses(processes, { top: 1, sortBy: 'mem' });
    expect(byMem).toContain('a.exe');
    expect(byMem).not.toContain('b.exe');
  });
});

describe('可疑进程识别', () => {
  it('编辑距离与相似名', () => {
    expect(levenshtein('svch0st.exe', 'svchost.exe')).toBe(1);
    expect(levenshtein('svchost.exe', 'svchost.exe')).toBe(0);
    expect(nearSystemProcessName('svch0st.exe')).toBe('svchost.exe');
    expect(nearSystemProcessName('svchost.exe')).toBe(null);
    expect(nearSystemProcessName('chrome.exe')).toBe(null);
    // 合法软件名只差一个字母(如 NZXT CAM 的 service.exe)不算伪装
    expect(nearSystemProcessName('service.exe')).toBe(null);
    expect(nearSystemProcessName('explorer.exe')).toBe(null);
  });

  it('系统名但不在系统目录、或名字只差一个字符的进程会被标记', () => {
    const findings = findImpostors([
      { pid: 1, name: 'svchost.exe', cpuPercent: null, memPercent: null, memRssBytes: null, path: 'C:\\Windows\\System32\\svchost.exe' },
      { pid: 2, name: 'svchost.exe', cpuPercent: null, memPercent: null, memRssBytes: null, path: 'D:\\tools\\svchost.exe' },
      { pid: 3, name: 'svch0st.exe', cpuPercent: null, memPercent: null, memRssBytes: null, path: 'C:\\Users\\me\\svch0st.exe' },
      { pid: 4, name: 'chrome.exe', cpuPercent: null, memPercent: null, memRssBytes: null, path: 'C:\\Program Files\\Google\\Chrome\\chrome.exe' },
      { pid: 5, name: 'System', cpuPercent: null, memPercent: null, memRssBytes: null, path: null },
    ]);
    expect(findings.map((finding) => finding.pid).sort()).toEqual([2, 3]);
    const system = findings.find((finding) => finding.pid === 2)!;
    expect(system.reason).toContain('不在系统目录');
    const near = findings.find((finding) => finding.pid === 3)!;
    expect(near.reason).toContain('相似');
    expect(findings.some((finding) => finding.pid === 4)).toBe(false);
  });
});

describe('聚合', () => {
  it('分区可用空间、外联连接分组、新增条目', () => {
    const free = freeBytesByMount(sample().disks);
    expect(free['C:']).toBe(290 * 1024 ** 3);

    const groups = establishedByProcess([
      { pid: 10, process: 'miner.exe', peerAddress: '1.1.1.1', peerPort: 3333, state: 'ESTABLISHED' },
      { pid: 10, process: 'miner.exe', peerAddress: '1.1.1.2', peerPort: 3333, state: 'ESTABLISHED' },
      { pid: 10, process: 'miner.exe', peerAddress: '1.1.1.3', peerPort: 443, state: 'TIME_WAIT' },
      { pid: 10, process: 'miner.exe', peerAddress: '1.1.1.4', peerPort: 443, state: 'ESTABLISHED' },
      { pid: 10, process: 'miner.exe', peerAddress: '127.0.0.1', peerPort: 8080, state: 'ESTABLISHED' },
      { pid: 10, process: 'miner.exe', peerAddress: '192.168.1.5', peerPort: 80, state: 'ESTABLISHED' },
      { pid: 4, process: 'System', peerAddress: '10.0.0.1', peerPort: 445, state: 'ESTABLISHED' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(4);
    expect(groups[0].peers[0]).toBe('1.1.1.1:3333');

    expect(newEntries(['a', 'b'], ['a', 'b', 'c'])).toEqual(['c']);
    expect(newEntries(['a'], ['a'])).toEqual([]);
  });

  it('温度、使用率与进程 Top', () => {
    const s = sample();
    expect(cpuTempOf(s.cpu)).toBe(58);
    expect(maxGpuUtil(s.gpus)).toBe(41);
    expect(maxGpuTemp(s.gpus)).toBe(57);
    expect(topProcessByCpu(s.processes)?.name).toBe('chrome.exe');
    expect(diskIoTotalMbs(s.diskIo)).toBe(14.4);
    expect(EXCLUDED_PROCESS_NAMES.has('system idle process')).toBe(true);
  });

  it('解析 Get-Counter 的磁盘 IO 输出', () => {
    const raw = JSON.stringify([
      '\\\\pc\\logicaldisk(_total)\\disk read bytes/sec=1048576',
      '\\\\pc\\logicaldisk(_total)\\disk write bytes/sec=2097152',
      '\\\\pc\\logicaldisk(_total)\\avg. disk sec/transfer=0.005',
    ]);
    const io = parseCounterOutput(raw);
    expect(io).toEqual({ readMBs: 1, writeMBs: 2, latencyMs: 5 });
    expect(parseCounterOutput('')).toBe(null);
    expect(parseCounterOutput('not json')).toBe(null);
    expect(parseCounterOutput(JSON.stringify([]))).toBe(null);
  });

  it('netstat 只有 PID 时用进程快照补名字', () => {
    const resolved = resolveConnectionNames([
      { pid: 10, process: null, peerAddress: '1.1.1.1', peerPort: 443, state: 'ESTABLISHED' },
      { pid: 99, process: null, peerAddress: '1.1.1.2', peerPort: 443, state: 'ESTABLISHED' },
      { pid: 10, process: 'known.exe', peerAddress: '1.1.1.3', peerPort: 443, state: 'ESTABLISHED' },
    ], [
      { pid: 10, name: 'chrome.exe', cpuPercent: null, memPercent: null, memRssBytes: null, path: null },
    ]);
    expect(resolved[0].process).toBe('chrome.exe');
    expect(resolved[1].process).toBe(null);
    expect(resolved[2].process).toBe('known.exe');
  });
});
