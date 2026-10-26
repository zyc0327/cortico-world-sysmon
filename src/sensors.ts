/**
 * 系统状态采集与格式化。
 *
 * 数据源是 npm 包 `systeminformation`(MIT),只在本机读 WMI/性能计数器与
 * `nvidia-smi`,不发任何网络请求,也不读写用户文件。每一项都可能读不到:
 * 读不到时字段为 null,格式化一律显示 n/a,事件与告警不会拿缺失值编造结论。
 */
import { execFile } from 'node:child_process';
import si from 'systeminformation';

// ── 样本类型 ──────────────────────────────────────────────────────────

export interface CpuSample {
  model: string | null;
  cores: number | null;
  physicalCores: number | null;
  speedGhz: number | null;
  loadPercent: number | null;
  loadUserPercent: number | null;
  loadSystemPercent: number | null;
  perCorePercent: number[] | null;
  tempMainC: number | null;
  tempMaxC: number | null;
  tempCoresC: number[] | null;
}

export interface MemSample {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  freeBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  usedPercent: number | null;
}

export interface GpuSample {
  model: string;
  vramBytes: number | null;
  usedBytes: number | null;
  utilPercent: number | null;
  tempC: number | null;
  powerW: number | null;
  fanPercent: number | null;
}

export interface DiskSample {
  mount: string;
  fs: string;
  sizeBytes: number;
  usedBytes: number;
  availableBytes: number;
  usePercent: number | null;
  rw: boolean;
}

export interface DiskHealthEntry {
  name: string;
  status: string;
}

export interface DiskIoSample {
  readMBs: number | null;
  writeMBs: number | null;
  latencyMs: number | null;
}

export interface ProcessSample {
  pid: number;
  name: string;
  cpuPercent: number | null;
  memPercent: number | null;
  memRssBytes: number | null;
  path: string | null;
}

export interface ConnectionSample {
  pid: number | null;
  process: string | null;
  peerAddress: string;
  peerPort: number | null;
  state: string;
}

export interface SysSample {
  tsMs: number;
  /** 系统名称,优先用发行版名称(如 "Windows 11 Pro");读不到时为 null。 */
  os: string | null;
  platform: string;
  arch: string | null;
  uptimeSeconds: number | null;
  cpu: CpuSample | null;
  mem: MemSample | null;
  gpus: GpuSample[];
  disks: DiskSample[];
  diskHealth: DiskHealthEntry[];
  diskIo: DiskIoSample | null;
  processes: ProcessSample[];
  connections: ConnectionSample[];
}

/** 不算异常主体的进程(系统空闲、内核伪进程)。 */
export const EXCLUDED_PROCESS_NAMES: ReadonlySet<string> = new Set([
  'system idle process',
  'system',
  'idle',
  'registry',
  'memory compression',
  'secure system',
]);

// ── 采集 ──────────────────────────────────────────────────────────────

type Raw = Record<string, unknown>;

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function bytesFromMb(value: unknown): number | null {
  const mb = num(value);
  return mb === null ? null : mb * 1024 * 1024;
}

async function safeCall(call: () => Promise<unknown>): Promise<Raw | null> {
  try {
    const value = await call();
    return value && typeof value === 'object' ? (value as Raw) : null;
  } catch {
    return null;
  }
}

function safeArray(value: unknown): Raw[] | null {
  return Array.isArray(value) ? (value as Raw[]) : null;
}

/** 采集一次完整快照;单个采集器失败只让对应字段为 null,不影响其它字段。 */
export async function collectSnapshot(): Promise<SysSample> {
  const [cpu, load, temp, mem, graphics, fsSize, fsStats, diskLayout, processes, osInfo, time, connections] =
    await Promise.all([
      safeCall(() => si.cpu()),
      safeCall(() => si.currentLoad()),
      safeCall(() => si.cpuTemperature()),
      safeCall(() => si.mem()),
      safeCall(() => si.graphics()),
      safeCall(() => si.fsSize()),
      safeCall(() => si.fsStats()),
      safeCall(() => si.diskLayout()),
      safeCall(() => si.processes()),
      safeCall(() => si.osInfo()),
      safeCall(async () => si.time()),
      safeCall(() => si.networkConnections()),
    ]);

  const diskIo = mapDiskIo(fsStats) ?? (await collectDiskIoFallback());
  const mappedProcesses = mapProcesses(processes);
  const mappedConnections = resolveConnectionNames(mapConnections(connections), mappedProcesses);

  return {
    tsMs: Date.now(),
    os: str(osInfo?.distro) ?? str(osInfo?.platform) ?? null,
    platform: str(osInfo?.platform) ?? process.platform,
    arch: str(osInfo?.arch),
    uptimeSeconds: num(time?.uptime) ?? num(osInfo?.uptime),
    cpu: mapCpu(cpu, load, temp),
    mem: mapMem(mem),
    gpus: mapGpus(graphics),
    disks: mapDisks(fsSize),
    diskHealth: mapDiskHealth(diskLayout),
    diskIo,
    processes: mappedProcesses,
    connections: mappedConnections,
  };
}

function mapCpu(cpu: Raw | null, load: Raw | null, temp: Raw | null): CpuSample | null {
  if (!cpu && !load && !temp) return null;
  const cores = safeArray(load?.cpus);
  const perCore = cores
    ? cores.map((core) => num(core?.load)).filter((value): value is number => value !== null)
    : null;
  const tempCores = safeArray(temp?.cores)
    ?.map((value) => num(value))
    .filter((value): value is number => value !== null) ?? null;
  const brand = str(cpu?.brand);
  const manufacturer = str(cpu?.manufacturer);
  return {
    model: brand && manufacturer && !brand.includes(manufacturer) ? `${manufacturer} ${brand}` : (brand ?? manufacturer),
    cores: num(cpu?.cores),
    physicalCores: num(cpu?.physicalCores),
    speedGhz: num(cpu?.speed),
    loadPercent: num(load?.currentLoad),
    loadUserPercent: num(load?.currentLoadUser),
    loadSystemPercent: num(load?.currentLoadSystem),
    perCorePercent: perCore && perCore.length > 0 ? perCore : null,
    tempMainC: num(temp?.main),
    tempMaxC: num(temp?.max),
    tempCoresC: tempCores && tempCores.length > 0 ? tempCores : null,
  };
}

function mapMem(mem: Raw | null): MemSample | null {
  if (!mem) return null;
  const total = num(mem.total) ?? 0;
  const used = num(mem.used) ?? 0;
  return {
    totalBytes: total,
    usedBytes: used,
    availableBytes: num(mem.available) ?? 0,
    freeBytes: num(mem.free) ?? 0,
    swapTotalBytes: num(mem.swaptotal) ?? 0,
    swapUsedBytes: num(mem.swapused) ?? 0,
    usedPercent: total > 0 ? (used / total) * 100 : null,
  };
}

function mapGpus(graphics: Raw | null): GpuSample[] {
  const controllers = safeArray(graphics?.controllers) ?? [];
  const gpus: GpuSample[] = [];
  for (const controller of controllers) {
    const model = str(controller?.model) ?? str(controller?.vendor);
    if (!model) continue;
    gpus.push({
      model,
      vramBytes: bytesFromMb(controller?.vram) ?? bytesFromMb(controller?.memoryTotal),
      usedBytes: bytesFromMb(controller?.memoryUsed),
      utilPercent: num(controller?.utilizationGpu),
      tempC: num(controller?.temperatureGpu),
      powerW: num(controller?.powerDraw),
      fanPercent: num(controller?.fanSpeed),
    });
  }
  return gpus;
}

function mapDisks(fsSize: Raw | null): DiskSample[] {
  const list = safeArray(fsSize) ?? [];
  const disks: DiskSample[] = [];
  for (const entry of list) {
    const mount = str(entry?.mount);
    const size = num(entry?.size) ?? 0;
    if (!mount || size <= 0) continue;
    const used = num(entry?.used) ?? 0;
    disks.push({
      mount,
      fs: str(entry?.type) ?? 'unknown',
      sizeBytes: size,
      usedBytes: used,
      availableBytes: num(entry?.available) ?? Math.max(0, size - used),
      usePercent: num(entry?.use) ?? (size > 0 ? (used / size) * 100 : null),
      rw: entry?.rw === true,
    });
  }
  return disks;
}

function mapDiskHealth(diskLayout: Raw | null): DiskHealthEntry[] {
  const list = safeArray(diskLayout) ?? [];
  const entries: DiskHealthEntry[] = [];
  for (const disk of list) {
    const name = str(disk?.name) ?? str(disk?.device);
    const status = str(disk?.smartStatus);
    if (name && status && status.toLowerCase() !== 'unknown') entries.push({ name, status });
  }
  return entries;
}

function mapDiskIo(fsStats: Raw | null): DiskIoSample | null {
  if (!fsStats) return null;
  const read = num(fsStats.rx_sec);
  const write = num(fsStats.wx_sec);
  return {
    readMBs: read === null ? null : read / (1024 * 1024),
    writeMBs: write === null ? null : write / (1024 * 1024),
    latencyMs: num(fsStats.ms),
  };
}

/**
 * si.fsStats() 在部分 Windows 机器上返回空;这时用 PowerShell 的
 * `Get-Counter \LogicalDisk(_Total)\...` 补一次(约 1 秒,只在本机执行)。
 */
export async function collectDiskIoFallback(): Promise<DiskIoSample | null> {
  if (process.platform !== 'win32') return null;
  const script = [
    "$c = Get-Counter -Counter '\\LogicalDisk(_Total)\\Disk Read Bytes/sec','\\LogicalDisk(_Total)\\Disk Write Bytes/sec','\\LogicalDisk(_Total)\\Avg. Disk sec/Transfer' -MaxSamples 1 -ErrorAction Stop",
    'ConvertTo-Json -Compress -Depth 3 @($c.CounterSamples | ForEach-Object { $_.Path + "=" + $_.CookedValue })',
  ].join('\n');
  try {
    return parseCounterOutput(await runPowerShell(script, 8000));
  } catch {
    return null;
  }
}

/** 解析 Get-Counter 的 "路径=数值" 列表;读不出的项为 null。 */
export function parseCounterOutput(raw: string): DiskIoSample | null {
  if (!raw) return null;
  let entries: string[];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) entries = parsed.map((value) => String(value));
    else if (typeof parsed === 'string') entries = [parsed];
    else return null;
  } catch {
    return null;
  }
  let readMBs: number | null = null;
  let writeMBs: number | null = null;
  let latencyMs: number | null = null;
  for (const entry of entries) {
    const separator = entry.lastIndexOf('=');
    if (separator < 0) continue;
    const path = entry.slice(0, separator).toLowerCase();
    const value = Number(entry.slice(separator + 1));
    if (!Number.isFinite(value)) continue;
    if (path.includes('disk read bytes/sec')) readMBs = value / (1024 * 1024);
    else if (path.includes('disk write bytes/sec')) writeMBs = value / (1024 * 1024);
    else if (path.includes('avg. disk sec/transfer')) latencyMs = value * 1000;
  }
  if (readMBs === null && writeMBs === null && latencyMs === null) return null;
  return { readMBs, writeMBs, latencyMs };
}

function mapProcesses(processes: Raw | null): ProcessSample[] {
  const list = safeArray(processes?.list) ?? [];
  const mapped: ProcessSample[] = [];
  for (const entry of list) {
    const pid = num(entry?.pid);
    const name = str(entry?.name);
    if (pid === null || !name) continue;
    mapped.push({
      pid,
      name,
      cpuPercent: num(entry?.cpu),
      memPercent: num(entry?.mem),
      memRssBytes: num(entry?.memRss),
      path: str(entry?.path),
    });
  }
  return mapped;
}

function mapConnections(connections: Raw | null): ConnectionSample[] {
  const list = safeArray(connections) ?? [];
  const mapped: ConnectionSample[] = [];
  for (const entry of list) {
    const peer = str(entry?.peerAddress);
    if (!peer) continue;
    mapped.push({
      pid: num(entry?.pid),
      process: str(entry?.process),
      peerAddress: peer,
      peerPort: num(entry?.peerPort),
      state: (str(entry?.state) ?? 'unknown').toUpperCase(),
    });
  }
  return mapped;
}

/**
 * netstat 只有 PID 时按进程快照补名字;补不到就保持 null,
 * 事件里会退化成 pid:NNN 而不是编造一个进程名。
 */
export function resolveConnectionNames(
  connections: readonly ConnectionSample[],
  processes: readonly ProcessSample[],
): ConnectionSample[] {
  const names = new Map<number, string>();
  for (const process of processes) names.set(process.pid, process.name);
  return connections.map((connection) => {
    if (connection.process || connection.pid === null) return connection;
    return { ...connection, process: names.get(connection.pid) ?? null };
  });
}

// ── Windows 侧一次性采集(PowerShell) ────────────────────────────────

function runPowerShell(script: string, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(String(stdout ?? '').trim());
      },
    );
  });
}

function parseJsonList(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((value) => String(value));
    if (typeof parsed === 'string') return [parsed];
    return [];
  } catch {
    return [];
  }
}

/**
 * 读注册表 Run/RunOnce 与启动文件夹里的条目,返回 "名称 @ 来源" 列表。
 * 只读,不需要管理员权限;非 Windows 或读取失败时返回空列表。
 */
export async function collectStartupEntries(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const script = [
    '$items = New-Object System.Collections.ArrayList',
    "$keys = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce')",
    'foreach ($k in $keys) {',
    '  if (Test-Path $k) {',
    '    $p = Get-ItemProperty $k -ErrorAction SilentlyContinue',
    '    if ($p) { foreach ($name in $p.PSObject.Properties.Name) { if (-not $name.StartsWith("PS")) { [void]$items.Add($name + " @ Run") } } }',
    '  }',
    '}',
    'foreach ($f in @("$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup", "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup")) {',
    '  if (Test-Path $f) { foreach ($entry in Get-ChildItem $f -File -ErrorAction SilentlyContinue) { [void]$items.Add($entry.Name + " @ Startup") } }',
    '}',
    'ConvertTo-Json -Compress -Depth 3 @($items | Sort-Object -Unique)',
  ].join('\n');
  try {
    return parseJsonList(await runPowerShell(script));
  } catch {
    return [];
  }
}

/** 数一个采样间隔内 Application/System 日志的 Error 事件;读不到时返回 null。 */
export async function countEventLogErrors(minutes: number): Promise<number | null> {
  if (process.platform !== 'win32') return null;
  const safeMinutes = Math.max(1, Math.min(120, Math.trunc(minutes)));
  const script = [
    `$since = (Get-Date).AddMinutes(-${safeMinutes})`,
    '$count = 0',
    "foreach ($log in @('Application','System')) {",
    '  try { $count += @(Get-WinEvent -FilterHashtable @{LogName=$log; Level=2; StartTime=$since} -MaxEvents 500 -ErrorAction Stop).Count } catch { }',
    '}',
    'Write-Output $count',
  ].join('\n');
  try {
    const value = Number.parseInt((await runPowerShell(script)).trim(), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** 列出现有(非 Disabled)的计划任务 "名称 @ 路径";读不到时返回空列表。 */
export async function collectScheduledTasks(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const script = [
    'ConvertTo-Json -Compress -Depth 3 @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.State -ne "Disabled" } | ForEach-Object { $_.TaskName + " @ " + $_.TaskPath })',
  ].join('\n');
  try {
    return parseJsonList(await runPowerShell(script));
  } catch {
    return [];
  }
}

// ── 格式化(纯函数) ──────────────────────────────────────────────────

export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return 'n/a';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value < 100 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatPercent(value: number | null, digits = 0): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return `${value.toFixed(digits)}%`;
}

export function formatTempC(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return `${value.toFixed(0)}°C`;
}

export function formatGhz(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(2)} GHz`;
}

/** 整机状态快照的模型可读文本。缺失值一律 n/a。 */
export function formatStatus(sample: SysSample): string {
  const lines: string[] = [];
  const os = `${sample.os ?? sample.platform}${sample.arch ? ` · ${sample.arch}` : ''}`;
  lines.push(`系统: ${os} · 已运行 ${formatUptime(sample.uptimeSeconds)}`);

  if (sample.cpu) {
    const cpu = sample.cpu;
    const parts = [
      cpu.model ?? 'n/a',
      cpu.cores ? `${cpu.cores} 线程` : 'n/a 线程',
      `负载 ${formatPercent(cpu.loadPercent)}`,
      `频率 ${formatGhz(cpu.speedGhz)}`,
      `温度 ${formatTempC(cpu.tempMainC)}`,
    ];
    lines.push(`CPU: ${parts.join(' · ')}`);
    if (cpu.perCorePercent && cpu.perCorePercent.length > 1) {
      lines.push(`  每核负载: ${cpu.perCorePercent.map((value) => formatPercent(value)).join(' ')}`);
    }
  }

  if (sample.mem) {
    const mem = sample.mem;
    const parts = [
      `${formatBytes(mem.usedBytes)} / ${formatBytes(mem.totalBytes)} (${formatPercent(mem.usedPercent)})`,
      `可用 ${formatBytes(mem.availableBytes)}`,
    ];
    if (mem.swapTotalBytes > 0) {
      parts.push(`交换 ${formatBytes(mem.swapUsedBytes)} / ${formatBytes(mem.swapTotalBytes)}`);
    }
    lines.push(`内存: ${parts.join(' · ')}`);
  }

  // 只详列能读到使用率/温度/显存占用的显示适配器;虚拟机与虚拟显示驱动单独汇总。
  const informative = sample.gpus.filter((gpu) =>
    gpu.utilPercent !== null || gpu.tempC !== null || gpu.powerW !== null || gpu.usedBytes !== null,
  );
  for (const gpu of informative) {
    const parts = [`使用率 ${formatPercent(gpu.utilPercent)}`];
    if (gpu.vramBytes !== null) {
      parts.push(`显存 ${formatBytes(gpu.usedBytes)} / ${formatBytes(gpu.vramBytes)}`);
    }
    parts.push(`温度 ${formatTempC(gpu.tempC)}`);
    if (gpu.powerW !== null) parts.push(`功耗 ${gpu.powerW.toFixed(0)} W`);
    if (gpu.fanPercent !== null) parts.push(`风扇 ${formatPercent(gpu.fanPercent)}`);
    lines.push(`GPU: ${gpu.model} · ${parts.join(' · ')}`);
  }
  const others = sample.gpus.length - informative.length;
  if (others > 0) {
    lines.push(`其他显示适配器: ${others} 个(虚拟显示或驱动不提供使用率/温度)`);
  }

  if (sample.disks.length > 0) {
    const disks = sample.disks.map((disk) =>
      `${disk.mount} (${disk.fs}) ${formatBytes(disk.usedBytes)} / ${formatBytes(disk.sizeBytes)} (${formatPercent(disk.usePercent)})`,
    );
    lines.push(`磁盘: ${disks.join(' · ')}`);
  }

  if (sample.diskHealth.length > 0) {
    lines.push(`磁盘健康: ${sample.diskHealth.map((entry) => `${entry.name} (${entry.status})`).join(' · ')}`);
  }

  if (sample.diskIo) {
    const parts = [`读 ${formatMBs(sample.diskIo.readMBs)}`, `写 ${formatMBs(sample.diskIo.writeMBs)}`];
    if (sample.diskIo.latencyMs !== null) parts.push(`响应 ${sample.diskIo.latencyMs.toFixed(2)} ms`);
    lines.push(`磁盘 IO: ${parts.join(' · ')}`);
  }

  const temps: string[] = [];
  if (sample.cpu?.tempMainC !== null && sample.cpu?.tempMainC !== undefined) temps.push(`CPU ${formatTempC(sample.cpu.tempMainC)}`);
  if (sample.cpu?.tempCoresC && sample.cpu.tempCoresC.length > 0) {
    temps.push(`核心最高 ${formatTempC(Math.max(...sample.cpu.tempCoresC))}`);
  }
  for (const gpu of sample.gpus) {
    if (gpu.tempC !== null) temps.push(`${gpu.model} ${formatTempC(gpu.tempC)}`);
  }
  if (temps.length > 0) lines.push(`温度: ${temps.join(' · ')}`);

  if (sample.cpu?.perCorePercent === null && sample.gpus.length === 0 && sample.disks.length === 0) {
    lines.push('(部分传感器不可用:温度、GPU 或磁盘数据缺失时显示 n/a,不代表数值为零)');
  }

  const hasAnyData = Boolean(sample.cpu || sample.mem || sample.gpus.length > 0 || sample.disks.length > 0 || sample.diskIo || sample.diskHealth.length > 0);
  if (!hasAnyData) {
    lines.push('(没有读到任何传感器数据;所有数值都显示 n/a,不代表为零)');
  }

  return lines.join('\n');
}

/** 按 CPU 或内存排序的进程列表文本。 */
export function formatProcesses(
  processes: ProcessSample[],
  options: { top: number; sortBy: 'cpu' | 'mem' },
): string {
  const top = Math.min(30, Math.max(1, Math.trunc(options.top)));
  const sorted = [...processes]
    .filter((process) => !EXCLUDED_PROCESS_NAMES.has(process.name.toLowerCase()))
    .sort((a, b) => {
      const left = options.sortBy === 'cpu' ? (a.cpuPercent ?? -1) : (a.memPercent ?? -1);
      const right = options.sortBy === 'cpu' ? (b.cpuPercent ?? -1) : (b.memPercent ?? -1);
      return right - left || b.pid - a.pid;
    })
    .slice(0, top);

  if (sorted.length === 0) return '没有可读的进程数据。';
  const header = `按 ${options.sortBy === 'cpu' ? 'CPU' : '内存'} 排名的前 ${sorted.length} 个进程:`;
  const rows = sorted.map((process) => {
    const parts = [
      `CPU ${formatPercent(process.cpuPercent, 1)}`,
      `内存 ${formatPercent(process.memPercent, 1)}`,
    ];
    if (process.memRssBytes !== null) parts.push(`RSS ${formatBytes(process.memRssBytes)}`);
    const path = process.path ? ` · ${truncate(process.path, 120)}` : '';
    return `- ${process.name} (PID ${process.pid}): ${parts.join(' · ')}${path}`;
  });
  return [header, ...rows].join('\n');
}

export function formatUptime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return 'n/a';
  const totalMinutes = Math.floor(seconds / 60);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  return `${minutes} 分钟`;
}

function formatMBs(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(1)} MB/s`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

// ── 可疑进程识别(纯函数) ────────────────────────────────────────────

/** 常见系统进程名(小写)。伪装检测只做事实比对,不下病毒结论。 */
export const SYSTEM_PROCESS_NAMES: ReadonlySet<string> = new Set([
  'system idle process',
  'system',
  'registry',
  'memory compression',
  'svchost.exe',
  'lsass.exe',
  'csrss.exe',
  'wininit.exe',
  'winlogon.exe',
  'services.exe',
  'smss.exe',
  'explorer.exe',
  'dwm.exe',
  'taskhostw.exe',
  'runtimebroker.exe',
  'conhost.exe',
  'fontdrvhost.exe',
  'spoolsv.exe',
  'audiodg.exe',
  'sihost.exe',
  'ctfmon.exe',
  'searchindexer.exe',
  'securityhealthservice.exe',
  'msmpeng.exe',
  'smartscreen.exe',
  'taskmgr.exe',
]);

/** 编辑距离;只用来判断"名字与系统进程只差一个字符"。 */
export function levenshtein(left: string, right: string): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a === b) return 0;
  const matrix: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[a.length][b.length];
}

/** 名字与某个系统进程同长度、只差一个字符,且差异是字母↔数字替换(如 svch0st.exe)。 */
export function nearSystemProcessName(name: string): string | null {
  const normalized = name.trim().toLowerCase();
  if (!normalized || SYSTEM_PROCESS_NAMES.has(normalized)) return null;
  for (const known of SYSTEM_PROCESS_NAMES) {
    if (known.length !== normalized.length) continue;
    let diff = -1;
    let diffs = 0;
    for (let index = 0; index < known.length; index += 1) {
      if (known[index] !== normalized[index]) {
        diffs += 1;
        diff = index;
        if (diffs > 1) break;
      }
    }
    if (diffs !== 1) continue;
    const replaced = normalized[diff];
    const original = known[diff];
    const digitLetterSwap = (/[0-9]/.test(replaced) && /[a-z]/.test(original))
      || (/[a-z]/.test(replaced) && /[0-9]/.test(original));
    if (digitLetterSwap) return known;
  }
  return null;
}

export interface ImpostorFinding {
  pid: number;
  name: string;
  path: string | null;
  reason: string;
}

/**
 * 找"像系统进程但位置不对"的进程:系统名但不在系统目录,或名字与系统进程只差一个字符。
 * 只报告可核对的事实,不判断是不是病毒。
 */
export function findImpostors(processes: readonly ProcessSample[]): ImpostorFinding[] {
  const windowsDir = (process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows').replace(/[\\/]+$/, '').toLowerCase();
  const findings: ImpostorFinding[] = [];
  for (const process of processes) {
    const normalized = process.name.trim().toLowerCase();
    if (!normalized || EXCLUDED_PROCESS_NAMES.has(normalized)) continue;
    const near = nearSystemProcessName(process.name);
    if (near) {
      findings.push({ pid: process.pid, name: process.name, path: process.path, reason: `名字与系统进程 ${near} 相似(字母被数字替换)` });
      continue;
    }
    if (SYSTEM_PROCESS_NAMES.has(normalized) && process.path) {
      const path = process.path.toLowerCase().replace(/[\\/]+$/, '');
      if (!path.startsWith(`${windowsDir}\\`) && path !== windowsDir) {
        findings.push({ pid: process.pid, name: process.name, path: process.path, reason: '名字与系统进程一致,但可执行文件不在系统目录' });
      }
    }
  }
  return findings;
}

// ── 供异常引擎使用的聚合(纯函数) ────────────────────────────────────

/** 每个分区当前可用字节数,键是挂载点。 */
export function freeBytesByMount(disks: readonly DiskSample[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const disk of disks) result[disk.mount] = disk.availableBytes;
  return result;
}

/** 已建立(ESTABLISHED)外联连接按进程分组;回环与系统伪进程不计。 */
export function establishedByProcess(connections: readonly ConnectionSample[]): Array<{
  key: string;
  name: string;
  count: number;
  peers: string[];
}> {
  const groups = new Map<string, { key: string; name: string; count: number; peers: string[] }>();
  for (const connection of connections) {
    if (connection.state !== 'ESTABLISHED') continue;
    if (isLoopbackPeer(connection.peerAddress)) continue;
    const name = connection.process ?? (connection.pid !== null ? `pid:${connection.pid}` : 'unknown');
    if (EXCLUDED_PROCESS_NAMES.has(name.toLowerCase())) continue;
    const key = connection.process ?? `pid:${connection.pid}`;
    const group = groups.get(key) ?? { key, name, count: 0, peers: [] };
    group.count += 1;
    if (group.peers.length < 3) group.peers.push(connection.peerPort === null ? connection.peerAddress : `${connection.peerAddress}:${connection.peerPort}`);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** 回环、全零地址与本机地址不算外联。 */
export function isLoopbackPeer(address: string): boolean {
  const peer = address.trim();
  return peer === ''
    || peer === '::1'
    || peer === '::'
    || peer === '0.0.0.0'
    || peer.startsWith('127.')
    || peer.startsWith('::ffff:127.')
    || peer.toLowerCase() === 'localhost';
}

/** 新增条目:在 current 里但不在 baseline 里。 */
export function newEntries(baseline: readonly string[], current: readonly string[]): string[] {
  const known = new Set(baseline);
  return current.filter((entry) => !known.has(entry));
}

/** 当前最大温度的 CPU 读数;主温度没有时退回核心最大值。 */
export function cpuTempOf(cpu: CpuSample | null): number | null {
  if (!cpu) return null;
  if (cpu.tempMainC !== null) return cpu.tempMainC;
  return cpu.tempMaxC;
}

/** 当前最高 GPU 使用率与最高温度。 */
export function maxGpuUtil(gpus: readonly GpuSample[]): number | null {
  const values = gpus.map((gpu) => gpu.utilPercent).filter((value): value is number => value !== null);
  return values.length > 0 ? Math.max(...values) : null;
}

export function maxGpuTemp(gpus: readonly GpuSample[]): number | null {
  const values = gpus.map((gpu) => gpu.tempC).filter((value): value is number => value !== null);
  return values.length > 0 ? Math.max(...values) : null;
}

/** 单个进程的 CPU 百分比(取最大者;排除系统伪进程)。 */
export function topProcessByCpu(processes: readonly ProcessSample[]): ProcessSample | null {
  let best: ProcessSample | null = null;
  for (const process of processes) {
    if (EXCLUDED_PROCESS_NAMES.has(process.name.toLowerCase())) continue;
    if (process.cpuPercent === null) continue;
    if (best === null || process.cpuPercent > (best.cpuPercent ?? -1)) best = process;
  }
  return best;
}

/** 读写合计 MB/s。 */
export function diskIoTotalMbs(diskIo: DiskIoSample | null): number | null {
  if (!diskIo) return null;
  const read = diskIo.readMBs;
  const write = diskIo.writeMBs;
  if (read === null && write === null) return null;
  return (read ?? 0) + (write ?? 0);
}
