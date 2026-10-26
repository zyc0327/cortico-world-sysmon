/** 真机冒烟测试:采一次快照并打印,确认 systeminformation 在这台机器上的实际输出。 */
import { collectSnapshot, formatStatus } from '../src/sensors.ts';

const sample = await collectSnapshot();
console.log(formatStatus(sample));
console.log(`\n[connections] ${sample.connections.length} 条,进程 ${sample.processes.length} 个,GPU ${sample.gpus.length} 个,分区 ${sample.disks.length} 个`);
