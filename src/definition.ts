import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { SYSMON_DEFAULTS, type SysmonConfigSection } from './config.ts';
import { SYS_TOOL_DECLS, SysmonWorld } from './world.ts';

export const SYSMON: WorldDefinition<SysmonConfigSection> = {
  id: 'sysmon',
  label: '系统监控',
  // `ctx.cfg` 是 `worlds.sysmon` 的活引用:采样间隔、阈值与信号开关热改即生效。
  defaults: () => ({ ...SYSMON_DEFAULTS }),
  create: (ctx) => new SysmonWorld({ cfg: ctx.cfg, timezone: ctx.timezone }),
  // 自描述:可能出现的全部工具与会推出的全部事件,不进提示词。
  describe: {
    tools: describeTools(SYS_TOOL_DECLS, {
      sysmon_status: {
        zh: '读一次本机快照:CPU 负载/频率/温度、内存、GPU、磁盘容量与读写、磁盘健康、风扇与开机时长;缺失值显示 n/a。',
        en: 'Reads one snapshot of this machine: CPU load/frequency/temperature, memory, GPU, disk capacity and IO, disk health, fans and uptime; missing sensors read as n/a.',
      },
      sysmon_processes: {
        zh: '按 CPU 或内存列出占用最高的进程,带 PID、路径与百分比。',
        en: 'Lists the top processes by CPU or memory with PID, path and percentages.',
      },
    }),
    events: [
      {
        type: 'sysmon.started',
        description: {
          zh: 'World 挂载完成,采样开始。',
          en: 'The World was mounted and sampling started.',
        },
      },
      {
        type: 'sysmon.alert',
        description: {
          zh: '越过阈值,或检测到持续型/事件型异常;meta 里带 signal 与事实。',
          en: 'A threshold was crossed, or a sustained/episodic anomaly was detected; meta carries the signal and facts.',
        },
      },
      {
        type: 'sysmon.recover',
        description: {
          zh: '持续型异常回落到阈值以下。',
          en: 'A sustained anomaly fell back below its threshold.',
        },
      },
    ],
  },
};
