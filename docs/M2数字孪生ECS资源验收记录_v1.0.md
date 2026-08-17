# M2 数字孪生 ECS 资源验收记录 v1.0

> 验收日期：2026-08-14（Asia/Shanghai）  
> 验收范围：M2 数字孪生专用 ECS 的购买、网络隔离、磁盘初始化、主机基线和容器运行能力  
> 重要边界：本记录通过的是“资源与主机基线验收”，不代表 Open5GS、MongoDB、UERANSIM 或完整 M2 Case 已经部署和验收。

## 1. 验收结论

**通过。** 已在用户本人的阿里云主账号、华东 1（杭州）创建一台最低成本的 4 vCPU / 16 GiB x86 数字孪生 ECS，并完成独立网络、安全组、100 GiB 数据盘、Docker/Compose、时钟同步、主机监控、日志轮转和离线容器运行验收。

本次采用经济档 `ecs.e-c1m4.xlarge`，满足 M2 串行开发和低并发验收的起步条件。若后续容量门禁出现持续 CPU、内存或 I/O 不足，再依据实测升配，不提前购买 M3 资源。

## 2. 已创建资源

| 资源 | 实际配置 |
|---|---|
| 账号 | 用户本人的阿里云主账号 |
| 地域 / 可用区 | 华东 1（杭州）/ 可用区 I，`cn-hangzhou-i` |
| ECS 名称 | `opsmind-m2-twin-t1` |
| ECS 实例 ID | `i-bp19u0lim79nhh4y7fkg` |
| 规格 | `ecs.e-c1m4.xlarge`，4 vCPU / 16 GiB，x86 |
| 操作系统 | Ubuntu 22.04 64 位 |
| 付费方式 | 按量付费，非抢占式 |
| 公网 | `114.215.189.185`；按使用流量，1 Mbps 峰值 |
| 私网 | `10.30.1.135` |
| 系统盘 | ESSD Entry 40 GiB，`d-bp19u0lim79nhh4xgf3q` |
| 数据盘 | ESSD Entry 100 GiB；ext4；挂载到 `/srv/opsmind-twin` |
| VPC | `opsmind-evalos-twin-vpc` / `vpc-bp1c00cd00nomiaimwa73` / `10.30.0.0/16` |
| vSwitch | `opsmind-evalos-twin-vswitch-i` / `vsw-bp1jlkw7q8bm8u5ryj0yn` / `10.30.1.0/24` |
| 安全组 | `opsmind-m2-twin-sg` / `sg-bp16ktwwoul5vlbc8rp8` |
| SSH 身份 | `ecs-user` + 密钥对 `opsmind-aliyun`；私钥只保存在项目目录外 |
| 标签 | `project=opsmind-evalos`、`stage=m2`、`role=twin` |
| 释放保护 | 已开启 |

## 3. 安全验收

- 未开放 Open5GS、MongoDB、UERANSIM、EvalOS、Node Exporter 等业务或管理端口到公网。
- SSH 22 只允许两个操作人员公网 `/32` 地址，以及阿里云 Workbench 官方内网来源 `100.104.0.0/16`。
- 没有使用 `0.0.0.0/0` 开放 SSH、数据库或数字孪生端口。
- 通过阿里云 Workbench 管理服务器；本机公网直连 SSH 在密钥交换前被云侧关闭，因此没有为图省事而扩大安全组范围。
- 主机只记录密钥对名称，仓库、Trace、文档和交付物均不保存私钥、密码、Token 或 AccessKey。

## 4. 主机基线

已完成：

- 主机名设为 `opsmind-m2-twin-t1`，并通过 cloud-init 配置持久保留；
- 100 GiB 数据盘格式化为 ext4，卷标为 `opsmind-data`，通过 `/etc/fstab` 持久挂载；
- 创建 `/srv/opsmind-twin/{docker,compose,config,state,pcap,trials,artifacts,logs}`；
- Docker 数据根目录迁移到 `/srv/opsmind-twin/docker`；
- Docker 日志使用 `local` 驱动，单文件 50 MiB、最多 5 个文件，并开启 `live-restore`；
- 安装 Docker、Docker Compose、chrony、Prometheus Node Exporter、jq、logrotate；
- Docker、chrony、Node Exporter、SSH 均设为开机启动并处于 `active`；
- Node Exporter 监听 9100，但安全组未向公网开放；
- `ecs-user` 已加入 `docker` 用户组，新登录会话可免 `sudo` 使用 Docker。

关键版本与状态：

| 验收项 | 结果 |
|---|---|
| Docker | `29.1.3` |
| Docker Compose | `2.40.3+ds1-0ubuntu1~22.04.1` |
| Docker 存储 | `/srv/opsmind-twin/docker`，`overlayfs` |
| logrotate | `3.19.0` |
| NTP 同步 | `yes` |
| 系统盘 | 40 GiB，约 3.3 GiB 已用、34 GiB 可用 |
| 数据盘 | 约 98 GiB 可用容量，约 93 GiB 可用 |

## 5. 容器运行验收

Docker Hub `registry-1.docker.io:443` 从该 ECS 访问超时；阿里云杭州官方容器镜像仓库 `registry.cn-hangzhou.aliyuncs.com` 可正常连接，未登录时返回 HTTP 401，属于预期结果。

为区分“Docker 引擎故障”和“Docker Hub 网络故障”，验收时从 Ubuntu 官方软件源安装静态 BusyBox，构建本地最小镜像并运行容器，容器输出：

```text
OPSMIND_DOCKER_RUNTIME_OK
```

因此 Docker 引擎、镜像导入、容器创建和容器进程运行均已通过。测试临时目录已删除；保留一个很小的本地 `opsmind/local-smoke:20260814` 镜像供后续主机自检。

后续正式部署不得接入来源不明的第三方镜像加速站。应把固定版本的 Open5GS、MongoDB、UERANSIM 镜像导入同地域的阿里云私有 ACR，并记录镜像 digest；或者使用可审计的离线镜像包。

## 6. 费用说明

- 创建页确认的实例、40 GiB 系统盘和 100 GiB 数据盘合计参考价约 `0.77706 元/小时`；最终账单以阿里云计费明细为准。
- 公网按使用流量计费，当前峰值 1 Mbps；账号免费试用页面显示中国内地公网流量仍有约 20 GiB 额度，但计费信息存在刷新延迟。
- 用户已充值 100 元；加上此前 0.01 元，确认可用现金余额为 100.01 元。充值是账户余额，不是一次性购买 100 元套餐，ECS 会按小时和实际流量逐步结算。
- 下单后免费试用页面的“每小时已用额度”没有立即刷新，不能据此承诺新 ECS 一定由免费额度覆盖。应以次日账单和实例级明细复核实际抵扣。
- 本次没有购买 NAT 网关、RDS、Tair、SLB、CEN、SLS 资源包、快照包或 M3 计算资源。

## 7. 尚未执行的 M2 功能工作

以下内容不属于本次资源基线验收，必须在下一阶段单独完成和验收：

1. 建立同地域私有 ACR 仓库并固化所需镜像 digest；
2. 部署固定版本 Open5GS、MongoDB 和 UERANSIM；
3. 实现 Trial 级 namespace、场景初始化、故障注入、清理和确定性重置；
4. 建立 PCAP 环形缓存及磁盘 70% 预警、80% 阻断规则；
5. 打通 EvalOS 控制面到 Twin 的受认证控制接口；
6. 完成单 gNB + 单 UE 注册、PDU 会话和端到端流量 Smoke；
7. 连续完成 5 次“初始化 → 故障 → 调查 → 证据 → 清理 → 重置”容量门禁；
8. 基线稳定后再创建 `opsmind-m2-baseline-v1` 快照或自定义镜像；快照会产生额外费用，创建前再次确认。

## 8. 最终判定

| 门禁 | 判定 |
|---|---|
| M2 资源采购 | 通过 |
| 网络与安全基线 | 通过 |
| 磁盘与目录基线 | 通过 |
| Docker/Compose 运行能力 | 通过 |
| 时间同步、主机监控、日志轮转 | 通过 |
| Open5GS/UERANSIM 功能 | 未开始，不冒充通过 |
| 完整 M2 协议级数字孪生 | 未开始，不冒充通过 |

下一步应进入 **M2.1 镜像供应链与单 gNB/单 UE 基线建设**，而不是继续购买服务器。
