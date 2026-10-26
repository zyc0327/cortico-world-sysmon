# cortico-world-sysmon

给 [Cortico](https://github.com/Pal-AI-Lab/Cortico) / [Coopanion](https://coo.palailab.org/) 用的 World 扩展:让 Coo 看得见这台 Windows 电脑的运行状态,并在出现异常时主动提醒。

两个只读查询工具、三类事件;阈值告警与九路异常监控默认关闭,装好即可用查询,需要时在 World 页逐项打开。全部数据来自本机,不发任何网络请求,不需要密钥。

## 能做什么

| 工具 | 作用 |
|---|---|
| `sysmon_status` | 读一次快照:CPU 负载/每核/频率/温度、内存、GPU 使用率/显存/温度/功耗/风扇、每分区容量、磁盘读写与响应时间、磁盘健康、开机时长 |
| `sysmon_processes` | 按 CPU 或内存列出占用最高的进程,带 PID、路径与百分比 |

事件:

- `sysmon.started`:World 挂载完成。
- `sysmon.alert`:阈值告警或异常信号;`meta.signal` 标明是哪一路。
- `sysmon.recover`:持续型信号回落到阈值以下。

阈值告警(越过推一次、回落推一次):CPU 温度、GPU 温度、内存占用、整机 CPU 负载。

异常监控(默认全部关闭;需要时在 World 页逐项开启):

| 信号 | 检测方式 | 默认阈值 |
|---|---|---|
| `process_cpu` | 单个进程 CPU 持续高于阈值 | 70%,持续 10 分钟 |
| `gpu` | GPU 使用率持续高于阈值(需要 `nvidia-smi`) | 90%,持续 10 分钟 |
| `disk_io` | 磁盘读写合计持续高于阈值,同时整机 CPU 低于 50%(扫盘/后台加密特征) | 60 MB/s,持续 10 分钟 |
| `disk_drop` | 判定窗口内某分区可用空间骤降(勒索加密/日志爆炸) | 降幅 2% |
| `restart` | 两次采样之间开机时长回退(意外重启) | 回退超过 2 分钟 |
| `startup` | 注册表 Run/RunOnce 与启动文件夹出现新条目(持久化) | 出现即报,每 10 分钟重扫 |
| `impostor` | 进程名像系统进程(如 `svch0st.exe` 把字母换成数字)但可执行文件不在系统目录 | 出现即报 |
| `connections` | 单个进程已建立外联 TCP 连接数超过阈值(矿池/木马外联;回环与系统伪进程不计,网页端口照常统计) | 10 个 |
| `event_log` | Windows 应用/系统日志错误事件数超过阈值 | 20 条/窗口,**默认关** |
| `disk_latency` | 磁盘平均响应时间持续高于阈值 | 200 ms,**默认关** |
| `scheduled_tasks` | 计划任务出现新条目 | 出现即报,**默认关** |

只报告可核对的事实:持续多久、超过多少、哪个进程、什么路径、多少连接。是不是病毒、要不要处理,由 Coo 结合上下文判断,扩展自己不下结论。

## 使用场景

- 「电脑怎么这么卡?」→ `sysmon_status` 看负载与温度,`sysmon_processes` 定位进程。
- 「显卡多少度?」→ `sysmon_status` 的 GPU 段。
- 「C 盘还剩多少?」→ `sysmon_status` 的磁盘段。
- 挖矿木马、扫盘程序、勒索加密、异常外联 → 对应的 `sysmon.alert` 事件会主动进来,Coo 先摆事实,再问你要不要处理。
- 开机后自启动项被悄悄加了 → `startup` 事件。

## 安装

扩展不发布到 npm,用本机目录安装:

1. 在 Coopanion 的「扩展」页选「手动安装」,填写这个目录的绝对路径(例如 `D:\Coo_extension\cortico-world-sysmon`)。
2. 重启 Coopanion 进程。
3. 在「World 总览」里启用「系统监控」,配置默认即可;想调阈值就在 World 页改。

本机目录以 link 方式装入,改代码后重启进程即生效。

## 配置

配置写在部署的 `config.json` 的 `worlds.sysmon` 段,也可以在 World 页里改,全部热生效:

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 是否挂载 |
| `intervalSeconds` | `60` | 采样间隔,30–600 秒 |
| `alertsEnabled` | `false` | 阈值告警总开关;关闭时只查询 |
| `cpuTempC` | `90` | CPU 温度阈值 |
| `gpuTempC` | `85` | GPU 温度阈值 |
| `memPercent` | `90` | 内存占用阈值 |
| `cpuLoadPercent` | `90` | 整机 CPU 负载阈值 |
| `anomaliesEnabled` | `false` | 异常监控总开关;关闭时只查询 |
| `anomalySustainMinutes` | `10` | 持续判定窗口(分钟) |
| `anomalyCooldownMinutes` | `10` | 同一信号冷却(分钟) |
| `processCpuPercent` | `70` | 单进程 CPU 阈值 |
| `gpuPercent` | `90` | GPU 使用率阈值 |
| `diskIoMbs` | `60` | 磁盘读写合计阈值(MB/s) |
| `diskDropPercent` | `2` | 分区可用空间骤降阈值(%) |
| `connectionsCount` | `10` | 单进程外联连接数阈值(回环与系统伪进程不计;云盘/P2P 误报时调高或关掉信号) |
| `eventLogErrors` | `20` | 日志错误数阈值 |
| `diskLatencyMs` | `200` | 磁盘响应时间阈值(ms) |
| `processesTopDefault` | `8` | `sysmon_processes` 默认条数 |
| `watchProcessCpu` 等 9 个 `watch*` | 全部 `false` | 各路异常开关,默认关闭 |

## 网络与文件

- **网络:完全没有。** 不请求任何地址,不含遥测。GPU 数据经本机 `nvidia-smi`,其余经 WMI/性能计数器,都是本机子进程。
- **文件:不读写用户文件。** 不落盘采样历史(只在内存里保留最近几次),不读 `.env`,不需要 API Key。
- **隐私:** 进程名、路径、外联地址会随事件进入 Coo 的上下文,属于本机信息;扩展不把它们发往别处。采样历史在停止时清空。

## 测试

```bash
corepack pnpm install
pnpm typecheck
pnpm test
```

改了工具、事件或环境提示词后,在仓库根目录跑 `pnpm describe` 重新生成 `describe.json`(测试会逐字对比)。

## 已知限制

- CPU 温度经 WMI 读取,部分主板/AMD 平台可能读不到,此时显示 `n/a`,对应告警不触发。
- GPU 使用率与温度需要 NVIDIA 驱动与 `nvidia-smi`;AMD/Intel 显卡通常只显示型号与显存。
- 伪装进程检测是名字与目录的启发式(系统名 + 路径不在系统目录,或字母被数字替换),不是杀毒;它只把可疑事实报给 Coo。
- 外联连接检测统计所有远端端口(矿池也常走 443/80),因此云盘、P2P 客户端可能触发误报;嫌吵就调高 `connectionsCount` 或关掉 `watchConnections`。
- 扫盘/加密检测用整机磁盘读写速率,无法归因到具体进程(需要管理员权限的性能计数器)。

## 许可与来源

MIT。骨架取自 Cortico 仓库的 World 扩展模板(`templates/extension/world`,MIT);测试用 `FakeHost` 同样来自模板;系统数据来自 [systeminformation](https://github.com/sebhildebrandt/systeminformation)(MIT);图标为本包原创(MIT)。详见 `LICENSE`。
