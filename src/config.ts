import type { ConfigGroup } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { text } from './strings.ts';

/** config.json 的 worlds.sysmon 段。默认禁用，由 bot 声明或部署配置启用。 */
export interface SysmonConfigSection {
  enabled: boolean;
  /** 采样间隔，秒;每次调度现读。 */
  intervalSeconds: number;
  /** 阈值告警总开关;每次采样现读。 */
  alertsEnabled: boolean;
  /** 以下四项是瞬时阈值:越过推送一次，回落到阈值以下再推送一次。 */
  cpuTempC: number;
  gpuTempC: number;
  memPercent: number;
  cpuLoadPercent: number;
  /** 异常信号总开关;每次采样现读。 */
  anomaliesEnabled: boolean;
  /** 持续判定窗口，分钟。 */
  anomalySustainMinutes: number;
  /** 同一信号两次推送之间的最小分钟数。 */
  anomalyCooldownMinutes: number;
  /** 单进程持续高 CPU 的阈值，百分比。 */
  processCpuPercent: number;
  /** GPU 持续满载的阈值，百分比。 */
  gpuPercent: number;
  /** 磁盘持续读写的阈值，读写合计 MB/s。 */
  diskIoMbs: number;
  /** 判定窗口内某分区可用空间骤降的阈值，百分比。 */
  diskDropPercent: number;
  /** 单进程已建立外联连接数阈值。 */
  connectionsCount: number;
  /** 一个采样间隔内 Windows 日志错误事件数阈值。 */
  eventLogErrors: number;
  /** 磁盘响应时间阈值，毫秒。 */
  diskLatencyMs: number;
  /** 进程列表默认条数。 */
  processesTopDefault: number;
  /** 异常信号开关;A 类默认开，B 类默认关。 */
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

export const SYSMON_DEFAULTS: SysmonConfigSection = {
  enabled: false,
  intervalSeconds: 60,
  alertsEnabled: false,
  cpuTempC: 90,
  gpuTempC: 85,
  memPercent: 90,
  cpuLoadPercent: 90,
  anomaliesEnabled: false,
  anomalySustainMinutes: 10,
  anomalyCooldownMinutes: 10,
  processCpuPercent: 70,
  gpuPercent: 90,
  diskIoMbs: 60,
  diskDropPercent: 2,
  connectionsCount: 10,
  eventLogErrors: 20,
  diskLatencyMs: 200,
  processesTopDefault: 8,
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
};

/** World 配置的 JSON Schema 声明;每个路径都必须落在 worlds.sysmon. 段内。 */
export function sysmonConfigGroup(language: Language): ConfigGroup {
  const t = text(language);
  return {
    id: 'world:sysmon',
    owner: 'world:sysmon',
    schema: {
      type: 'object',
      title: t.configTitle,
      description: t.configDescription,
      properties: {
        'worlds.sysmon.intervalSeconds': {
          type: 'integer',
          title: t.intervalTitle,
          description: t.intervalDescription,
          minimum: 30,
          maximum: 600,
          multipleOf: 10,
          'x-hot': true,
        },
        'worlds.sysmon.alertsEnabled': {
          type: 'boolean',
          title: t.alertsTitle,
          description: t.alertsDescription,
          'x-hot': true,
        },
        'worlds.sysmon.cpuTempC': {
          type: 'integer',
          title: t.cpuTempTitle,
          description: t.cpuTempDescription,
          minimum: 30,
          maximum: 110,
          'x-hot': true,
        },
        'worlds.sysmon.gpuTempC': {
          type: 'integer',
          title: t.gpuTempTitle,
          description: t.gpuTempDescription,
          minimum: 30,
          maximum: 110,
          'x-hot': true,
        },
        'worlds.sysmon.memPercent': {
          type: 'integer',
          title: t.memPercentTitle,
          description: t.memPercentDescription,
          minimum: 50,
          maximum: 100,
          'x-hot': true,
        },
        'worlds.sysmon.cpuLoadPercent': {
          type: 'integer',
          title: t.cpuLoadTitle,
          description: t.cpuLoadDescription,
          minimum: 50,
          maximum: 100,
          'x-hot': true,
        },
        'worlds.sysmon.anomaliesEnabled': {
          type: 'boolean',
          title: t.anomaliesTitle,
          description: t.anomaliesDescription,
          'x-hot': true,
        },
        'worlds.sysmon.anomalySustainMinutes': {
          type: 'integer',
          title: t.sustainTitle,
          description: t.sustainDescription,
          minimum: 1,
          maximum: 60,
          'x-hot': true,
        },
        'worlds.sysmon.anomalyCooldownMinutes': {
          type: 'integer',
          title: t.cooldownTitle,
          description: t.cooldownDescription,
          minimum: 0,
          maximum: 120,
          'x-hot': true,
        },
        'worlds.sysmon.processCpuPercent': {
          type: 'integer',
          title: t.processCpuTitle,
          description: t.processCpuDescription,
          minimum: 10,
          maximum: 100,
          'x-hot': true,
        },
        'worlds.sysmon.gpuPercent': {
          type: 'integer',
          title: t.gpuPercentTitle,
          description: t.gpuPercentDescription,
          minimum: 50,
          maximum: 100,
          'x-hot': true,
        },
        'worlds.sysmon.diskIoMbs': {
          type: 'number',
          title: t.diskIoTitle,
          description: t.diskIoDescription,
          minimum: 1,
          maximum: 1000,
          'x-hot': true,
        },
        'worlds.sysmon.diskDropPercent': {
          type: 'number',
          title: t.diskDropTitle,
          description: t.diskDropDescription,
          minimum: 0.1,
          maximum: 50,
          multipleOf: 0.1,
          'x-hot': true,
        },
        'worlds.sysmon.connectionsCount': {
          type: 'integer',
          title: t.connectionsTitle,
          description: t.connectionsDescription,
          minimum: 2,
          maximum: 200,
          'x-hot': true,
        },        'worlds.sysmon.eventLogErrors': {
          type: 'integer',
          title: t.eventLogErrorsTitle,
          description: t.eventLogErrorsDescription,
          minimum: 5,
          maximum: 500,
          'x-hot': true,
        },
        'worlds.sysmon.diskLatencyMs': {
          type: 'integer',
          title: t.diskLatencyTitle,
          description: t.diskLatencyDescription,
          minimum: 10,
          maximum: 5000,
          'x-hot': true,
        },
        'worlds.sysmon.processesTopDefault': {
          type: 'integer',
          title: t.processesTopTitle,
          description: t.processesTopDescription,
          minimum: 3,
          maximum: 30,
          'x-hot': true,
        },
        'worlds.sysmon.watchProcessCpu': {
          type: 'boolean',
          title: t.watchProcessCpuTitle,
          description: '单进程 CPU 持续超过阈值。',
          'x-hot': true,
        },
        'worlds.sysmon.watchGpu': {
          type: 'boolean',
          title: t.watchGpuTitle,
          description: 'GPU 使用率持续超过阈值。',
          'x-hot': true,
        },
        'worlds.sysmon.watchDiskIo': {
          type: 'boolean',
          title: t.watchDiskIoTitle,
          description: '磁盘读写合计持续超过阈值且 CPU 不高。',
          'x-hot': true,
        },
        'worlds.sysmon.watchDiskDrop': {
          type: 'boolean',
          title: t.watchDiskDropTitle,
          description: '判定窗口内分区可用空间骤降。',
          'x-hot': true,
        },
        'worlds.sysmon.watchRestart': {
          type: 'boolean',
          title: t.watchRestartTitle,
          description: '两次采样之间开机时长回退,说明系统重启过。',
          'x-hot': true,
        },
        'worlds.sysmon.watchStartup': {
          type: 'boolean',
          title: t.watchStartupTitle,
          description: '注册表 Run/RunOnce 与启动文件夹出现新条目。',
          'x-hot': true,
        },
        'worlds.sysmon.watchImpostor': {
          type: 'boolean',
          title: t.watchImpostorTitle,
          description: '进程名像系统进程但可执行文件不在系统目录,或把系统进程名里的字母换成数字(如 svch0st.exe)。',
          'x-hot': true,
        },
        'worlds.sysmon.watchConnections': {
          type: 'boolean',
          title: t.watchConnectionsTitle,
          description: '单进程已建立外联连接数超过阈值。',
          'x-hot': true,
        },
        'worlds.sysmon.watchEventLog': {
          type: 'boolean',
          title: t.watchEventLogTitle,
          description: '采样时会执行 PowerShell 读事件日志,较慢。',
          'x-hot': true,
        },
        'worlds.sysmon.watchDiskLatency': {
          type: 'boolean',
          title: t.watchDiskLatencyTitle,
          description: '磁盘平均响应时间持续高于阈值。',
          'x-hot': true,
        },
        'worlds.sysmon.watchScheduledTasks': {
          type: 'boolean',
          title: t.watchScheduledTasksTitle,
          description: '计划任务列表出现新条目时推送。',
          'x-hot': true,
        },
      },
    },
  };
}
