# M2 前阿里云 ECS 资源评估与购买步骤 v1.0

> 评估日期：2026-08-14（Asia/Shanghai）  
> 适用范围：M2 协议级数字孪生建设与验收，不提前采购 M3 正式评测资源  
> 产品名说明：阿里云产品正式名称是 **ECS（云服务器）**，不是 ESC。

> 2026-08-14 实际执行结果：用户最终决定在自己的主账号购买经济档 `ecs.e-c1m4.xlarge`（4C16G），并新建隔离的 `10.30.0.0/16` VPC；ECS、40G 系统盘、100G 数据盘、网络和主机基线已经通过验收。原文“丈夫账号 + 推荐档 g6a/PL0”保留为购买前方案，不应再作为当前资源事实。实际结果见 [M2数字孪生ECS资源验收记录_v1.0.md](./M2数字孪生ECS资源验收记录_v1.0.md)。

## 1. 一句话结论

现有两台 ECS **足够完成 M1/M1.5，并能做 M2 的单 gNB、单 UE、单故障、串行技术预演；但不够稳妥地完成完整 M2 验收**。

M2 开始前只新增一台数字孪生 ECS：

- 推荐配置：`ecs.g6a.xlarge`，4 vCPU / 16 GiB，x86，Ubuntu 22.04；
- 存储：40 GiB ESSD PL0 系统盘 + 100 GiB ESSD PL0 数据盘；
- 计费：按量付费，不买包年包月，不买抢占式实例；
- 位置：丈夫账号、华东 1（杭州）、优先杭州可用区 I、现有 `opsmind-evallab-vpc`；
- 用途：只运行 Open5GS、MongoDB、UERANSIM、故障注入、场景重置和 PCAP；
- 当前实时报价参考：约 **1.174 元/小时、28.18 元/天、197.23 元/周、845.28 元/30天**。这是 2026-08-14 通过阿里云询价接口取得的“实例 + 40G 系统盘 + 100G 数据盘”参考价，最终以创建页订单为准，不含公网流量、快照、OSS、SLS 和 DeepSeek API。

如果预算优先，可选 `ecs.e-c1m4.xlarge` 4C16G + ESSD Entry，同口径约 **0.7771 元/小时、18.65 元/天、130.55 元/周、559.48 元/30天**。它适合串行开发和低并发验收，但性能余量、磁盘稳定性低于推荐档；如果压测未过，仍要升到 `g6a`/PL0，因此默认推荐直接选择 `g6a`。

## 2. 现有资源实测

### 2.1 主账号产品 ECS

| 项目 | 当前情况 | M2 判断 |
|---|---|---|
| 实例 | `i-bp12nyanjsyue1vs5bu6`，杭州，2C8G，Ubuntu 22.04 | 保留原职责 |
| 当前职责 | MySQL/Redis 数据底座、OpsMind-LangGraph 运行时、PostgreSQL/Redis、OSS 连接 | 不能再叠加数字孪生 |
| 结论 | 产品数据域和长期资产域 | 不作为 M2 计算节点，不做原地扩容 |

原因：把 Open5GS、UERANSIM、MongoDB 和持续 PCAP 塞入产品数据机，会让评测负载污染业务运行，也破坏试验隔离。

### 2.2 丈夫账号 EvalLab ECS

| 项目 | 2026-08-14 实测 | M2 判断 |
|---|---:|---|
| 实例 | `i-bp14ezltpnq8mxic1gsb`，`ecs.e-c1m2.xlarge` | 保留为控制面 |
| CPU | 4 vCPU；采样负载 `0.00 / 0.02 / 0.00` | 控制面充足 |
| 内存 | 标称 8 GiB；系统可见 7.1 GiB；可用约 6.4 GiB；无 Swap | 不适合再常驻完整孪生栈 |
| 系统盘 | 40 GiB；已用约 3.9 GiB；可用约 34 GiB | PCAP、镜像和快照空间不足 |
| EvalOS | `opsmind-evalos.service` 正常运行 | 继续承载 API、Console、可信内核和调度 |
| M1.5 交付包 | `/opt/opsmind-evalos` 约 292 MiB | 当前负载很轻 |
| 容器环境 | 尚未安装 Docker | 不影响控制面；孪生组件放新机 |

结论：这台免费 ECS 不升级、不塞满，继续作为轻量 Control Plane。这样即使孪生机反复重置、抓包或出现故障，也不会拖垮 EvalOS 的 Trace、预算、Ledger 和评分控制面。

## 3. 为什么 M2 需要独立的 4C16G/100G

完整 M2 不是“装一个模拟器”这么简单。它需要同时运行：

```text
EvalLab-E1（现有 4C8G）
└─ EvalOS 控制面、调度、Trace/Ledger、评分、页面

Twin-T1（新增 4C16G）
├─ Open5GS 5G 核心网
├─ MongoDB（Open5GS 用户与配置数据）
├─ UERANSIM gNB / UE
├─ 故障注入器
├─ 场景初始化、清理和确定性重置
├─ tcpdump/PCAP 环形缓存
└─ 每 Trial 独立 namespace 和临时证据目录
```

Open5GS 官方快速入门明确包含 MongoDB 依赖；UERANSIM 需要 Linux、SCTP 和编译/运行依赖。再加上容器镜像、多个网络命名空间、故障注入及持续抓包，8 GiB 内存和 40 GiB 系统盘只能做单场景 Smoke，不能作为完整 M2 的稳定验收环境。

## 4. 本次该买与不该买

### 4.1 现在购买

| 优先级 | 资源 | 选择 |
|---|---|---|
| 必须 | Twin-T1 ECS | 1 台 `ecs.g6a.xlarge`，4C16G，按量付费 |
| 必须 | 系统盘 | 40 GiB ESSD PL0 |
| 必须 | 数据盘 | 100 GiB ESSD PL0 |
| 必须 | 安全组 | 新建 `opsmind-twin-sg`，默认拒绝公网业务端口 |
| 必须 | 快照 | 孪生基线安装、验证后制作 1 个手工快照/自定义镜像 |
| 轻量开通 | OSS | 私有、按量付费；保存 Trace、PCAP、Manifest、Ledger、报告 |
| 可选 | SLS | M2 初期按量、低量、短保留；预算紧可先用结构化日志 + OSS |

### 4.2 现在不要买

- 不买 M3 的 8C32G Twin-T2；
- 不买 M3 的 8C32G Runner-R1/R2；
- 不买 RDS、Tair、SLB、NAT 网关、CEN；
- 不为 Claude Agent SDK 版和 LangGraph 对照版各买一台不同规格机器；
- 不买 ARM 规格 `ecs.g6r.xlarge`，避免 UERANSIM、镜像和依赖的架构兼容成本；
- 不买抢占式实例，防止回收中断 Trial、损坏 PCAP 或让场景重置结果失真。

M2 验收后再根据真实 CPU、内存、磁盘、重置耗时和抓包丢包率决定 M3 采购，不能用纸面估算提前买一整套正式集群。

## 5. 阿里云控制台购买步骤

以下步骤在**丈夫账号**执行。

### 第 0 步：购买前保护

1. 进入费用与成本中心，设置日预算和余额预警；建议至少设置 50 元、200 元、500 元三级提醒。
2. 检查是否有可用代金券，并确认适用“按量付费 ECS”。
3. 确认账号已实名认证且余额充足。
4. 不改动现有免费 EvalLab ECS，不释放现有实例、磁盘、VPC、vSwitch 或安全组。

### 第 1 步：创建 ECS

路径：**云服务器 ECS → 实例 → 创建实例**。

| 控制台字段 | 选择值 |
|---|---|
| 付费类型 | 按量付费 |
| 地域 | 华东 1（杭州），`cn-hangzhou` |
| 可用区 | 优先可用区 I；若推荐规格暂时无库存，选择同 VPC 内已有 vSwitch 的可用区，或先新建对应 vSwitch |
| 网络 | 专有网络 VPC |
| VPC | `opsmind-evallab-vpc`，`vpc-bp18tl0dki33pt10z8c85` |
| vSwitch | 优先 `opsmind-evallab-vswitch-i`，`vsw-bp1hfrj4iycp5gqpli5nr` |
| 实例规格 | 首选 `ecs.g6a.xlarge`，4C16G，x86 |
| 镜像 | Ubuntu 22.04 64 位公共镜像 |
| 系统盘 | ESSD PL0，40 GiB |
| 数据盘 | ESSD PL0，100 GiB |
| 实例名称 | `opsmind-m2-twin-t1` |
| 主机名 | `opsmind-m2-twin-t1` |
| 登录方式 | SSH 密钥对，不使用弱密码 |
| 释放保护 | 建设期打开；M2 归档验收后再关闭并释放 |
| 标签 | `project=opsmind-evalos`、`stage=m2`、`role=twin` |

如果创建页没有 `ecs.g6a.xlarge`：

1. 先刷新库存或在杭州同 VPC 可覆盖的可用区查看；
2. 第二选择 `ecs.u1-c1m4.xlarge`；
3. 预算受限时选择 `ecs.e-c1m4.xlarge`；
4. 仍然保持 **4C16G、x86、100G 数据盘**，不要降到 8 GiB，也不要换 ARM。

### 第 2 步：公网选择

M2 业务端口不需要公网入口。安装阶段仍需下载系统包和镜像，采用下面的低成本方案：

1. 创建时选择“按使用流量”公网带宽，峰值 1–5 Mbps；
2. 公网只用于安装和维护，不向公网开放 Open5GS、MongoDB、UERANSIM 或 EvalOS API；
3. 安装完成且私网运维路径可用后，移除固定公网入口或解绑 EIP；
4. 不为这一台临时 Twin 单独购买 NAT 网关。

### 第 3 步：新建独立安全组

新建 `opsmind-twin-sg`，不要直接复用控制面安全组。

入方向建议：

- SSH 22：仅允许操作人员当前公网 `/32`；如果从 EvalLab 跳转，则仅允许 `10.20.1.156/32`；
- EvalOS 到 Twin 的控制接口：只允许 EvalLab 私网 IP 或来源安全组，端口在实现时固定后再开；
- Open5GS/UERANSIM 内部端口：尽量只在同机容器网络/namespace 内通信，不对公网开放；
- 禁止 `0.0.0.0/0` 访问 22、27017、38412、2152、8805、3000、8000 等管理、数据库、N2/N3/PFCP 或应用端口。

出方向可以先允许访问软件源、容器镜像和必要 API；M2 加固完成后再按域名/目的收紧。

### 第 4 步：确认订单

下单前逐项截图或记录：

- 账号、地域、可用区、VPC、vSwitch；
- 实例规格必须是 x86 4C16G；
- 40G 系统盘 + 100G 数据盘；
- 按量付费，不是包年包月、不是抢占式；
- 公网按流量，不是高额固定带宽；
- 预计小时价与本文报价相比是否异常；
- 是否误选付费商业镜像、自动快照策略或额外安全产品。

任何一项不符，先不点“立即购买”。

## 6. 购买后 30 分钟内完成的配置

1. 将 100G 数据盘格式化并挂载到 `/srv/opsmind-twin`，容器数据、PCAP、Trial 工作目录都放这里，不挤系统盘。
2. 安装 Docker/Compose、时间同步、主机监控和日志轮转。
3. 部署固定版本的 Open5GS、MongoDB、UERANSIM；记录镜像 digest、软件版本和配置哈希。
4. 建立 PCAP 环形缓存，设置单 Trial、单场景和整机磁盘上限。
5. 完成单 gNB + 单 UE 注册/会话 Smoke，验证 SCTP/N2、GTP/N3 和核心网信令。
6. 验证 EvalLab-E1 只能通过私网控制 Twin；公网无法访问数据库和孪生业务端口。
7. 基线验证通过后创建 `opsmind-m2-baseline-v1` 快照/自定义镜像。
8. 建立费用、CPU、内存、磁盘告警；磁盘 70% 预警、80% 阻断新 Trial。

## 7. OSS、SLS 和跨账号怎么选

### M2 最简单做法

- 在丈夫账号杭州地域创建一个 EvalOS 专用私有 OSS Bucket，按量付费，不先买资源包；
- 开启服务端加密、版本控制和生命周期规则；
- Twin 的 PCAP 和 Trial 原始证据先写入同账号 OSS；
- 每个里程碑再把不可变证据包同步到主账号 OSS 或本地离线副本；
- Bucket 名不要包含真实姓名、手机号或账号信息。

两个账号隔离**不影响 M2 建设**。M2 控制面和 Twin 都放丈夫账号同一个 VPC，主账号仅保存业务数据和长期证据。如后续必须私网直连主账号资源，可建立跨账号、同地域 VPC 对等连接，但要配置双方路由、安全组并确认 CIDR 不重叠。不要用开放公网数据库端口代替跨账号网络。

SLS 在 M2 不是刚性购买项。先保持 EvalOS 自身的结构化 Trace、append-only Ledger 和 OSS 原始证据；需要集中检索时，再开一个低量按量 Logstore。不要预购大规格日志资源包。

## 8. M2 容量验收门槛

购买 4C16G 不等于自动通过 M2。开始批量制作 20–30 个 L2 Case 前，至少通过以下容量门禁：

- 连续完成 5 次“初始化 → 注入故障 → Agent 调查 → 收集证据 → 清理 → 重置”；
- 每次重置后核心网、用户数据、网络 namespace、缓存和 PCAP 状态均回到基线；
- 无 OOM、无容器串扰、无 Trial 证据丢失；
- 内存长期低于 75%；
- CPU 不持续高于 70%；
- 数据盘使用率低于 70%，PCAP 达到上限后按策略滚动；
- 抓包无不可解释丢包；
- EvalOS Trace、预算、终止原因、工具调用和 Ledger 可完整关联到同一 Trial ID；
- 同一个 Case 重跑能得到相同环境事实，Agent 推理可以不同，但环境不能漂移。

如果门禁失败：

1. 先降低 UE 数和并发，检查日志/PCAP配置；
2. 如果是 I/O 抖动，确认使用 PL0 并调整 PCAP；
3. 如果 4C16G 仍持续 CPU/内存不足，再升配到 8C32G；
4. 不用 Swap、静默丢日志或删减证据来“伪装通过”。

## 9. 费用控制和退场

- 预计连续使用 7 天：推荐档约 197 元，经济档约 131 元；
- 预计连续使用 14 天：推荐档约 394 元，经济档约 261 元；
- 普通“关机/停止”仍可能继续收计算费；不用时应选择节省停机模式，或在证据归档后释放实例；
- 节省停机模式仍会收云盘、EIP、快照等费用，而且再次启动可能因库存不足失败；
- M2 验收后，如果 M3 不立即开始：先校验 OSS 对象数、总字节数、哈希清单和可下载性，再制作基线快照，最后释放 Twin-T1；
- 释放实例前检查数据盘是否“随实例释放”。未随实例释放的磁盘、EIP 和快照会继续收费；已经随实例释放的盘会永久删除，必须先完成证据归档。

## 10. 最终购买清单

### 立即执行

- [ ] 丈夫账号设置余额与日预算预警；
- [ ] 创建 1 台 `ecs.g6a.xlarge`，杭州、优先可用区 I、现有 EvalLab VPC；
- [ ] 选择 Ubuntu 22.04 x86、40G ESSD PL0 系统盘、100G ESSD PL0 数据盘；
- [ ] 按量付费、按流量公网、非抢占式；
- [ ] 新建 `opsmind-twin-sg`，公网 SSH 仅 `/32`，业务端口仅私网；
- [ ] 创建私有按量 OSS Bucket；
- [ ] 部署并通过容量门禁后，再正式进入 M2 Case 建设。

### 暂缓

- [ ] 8C32G Twin-T2；
- [ ] 8C32G Runner-R1/R2；
- [ ] RDS/Tair/SLB/NAT/CEN；
- [ ] SLS 资源包和 OSS 预付资源包。

## 11. 官方依据

- [阿里云 ECS 快速入门](https://help.aliyun.com/zh/ecs/quick-start)
- [ECS 按量付费与节省停机模式](https://help.aliyun.com/zh/ecs/pay-as-you-go-1)
- [ECS 实例规格族](https://help.aliyun.com/zh/ecs/user-guide/overview-of-instance-families)
- [ECS DescribePrice 询价接口](https://help.aliyun.com/zh/ecs/developer-reference/api-ecs-2014-05-26-describeprice/)
- [ESSD 云盘](https://help.aliyun.com/zh/ecs/user-guide/essds)
- [块存储性能](https://help.aliyun.com/zh/ecs/user-guide/block-storage-performance)
- [释放 ECS 实例](https://help.aliyun.com/zh/ecs/user-guide/release-an-instance)
- [释放云盘](https://help.aliyun.com/zh/ecs/user-guide/release-a-disk)
- [跨账号 VPC 对等连接](https://help.aliyun.com/zh/vpc/user-guide/vpc-peer-to-peer-connection/)
- [OSS 计费概述](https://www.alibabacloud.com/help/zh/oss/billing-overview)
- [SLS 计费概述](https://www.alibabacloud.com/help/zh/sls/billing-overview)
- [Open5GS Quickstart](https://open5gs.org/open5gs/docs/guide/01-quickstart/)
- [UERANSIM Installation](https://github.com/aligungr/UERANSIM/wiki/Installation)
- [UERANSIM Configuration](https://github.com/aligungr/UERANSIM/wiki/Configuration)
