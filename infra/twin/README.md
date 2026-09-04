# OpsMind M2 协议级数字孪生运行时

该目录是 M2 Twin-T1 的确定性“考场控制器”，不是被测 Agent 的诊断工作流。

- Agent 仍由 Claude Agent SDK + DeepSeek 的模型循环自主选择假设、MCP、Skill 和停止时间。
- 控制器只负责冻结版本、准备场景、隔离 Trial、故障注入、只读观测、PCAP 和确定性重置。
- 调用方只能提交经过校验的 `health/prepare/observe/snapshot/reset` 请求，不能提交 shell、路径、服务名或任意网络规则。
- `evalos-twin` 用户只有执行 `/usr/local/sbin/opsmind-twinctl` 的 sudo 权限。
- Trial 证据目录不在 reset 中删除，便于形成 append-only 证据链。
- 整个物理实验室只认 `/srv/opsmind-twin/physical-lease.json` 这一份租约。LangGraph、Agent+Harness
  和 EvalOS 都只能引用它，不能各自生成第二份租约。
- 租约持久化记录使用模式、候选产品、EvalOS Trial、内部 Trial、唯一 lease、到期时间和主机
  boot_id。主机重启、租约过期、文件损坏或首次从旧版升级都会进入 `quarantined`；管理员必须执行
  固定的 `recover` 请求，完成确定性基线复位后才能重新变为 `idle`。
- 两套真实候选产品始终使用各自原生的协议实验室 MCP 身份调查；EvalOS 不代理工具调用，
  也不把考务管理身份借给候选产品。
- EvalOS 的考务管理器只有 `status/prepare/snapshot/reset` 四个操作。它准备独占物理租约后，
  只把公开租约编号交给运行面核对，不提供候选 SSH 授权、远程观察或远程健康监督入口。
- 两套产品每 60 秒向 EvalOS HTTPS 入口发送独立 Ed25519 签名的短时状态。状态只保存在
  EvalOS 内存 180 秒，说明产品身份、版本、就绪状态及当前 Trial/租约绑定；不包含调查证据、
  Case、Seed、答案、凭据或修复权限。

组件版本、官方来源和 UERANSIM 源码哈希记录在 `stack.manifest.json`。

## 控制器版本与回滚

沿用现有版本机制：一个打包入口、一个安装入口、两个活动版本指针，不新增服务或数据库。

1. 发布前核验已部署提交是候选的祖先，提交并推送准确候选。正常构建运行 `python3 infra/twin/build-controller-release.py`，只取准确 HEAD 的 Git 文件；有未提交的已跟踪修改时拒绝构建。
2. 当前包包含 15 个固定文件：12 个既有运行入口/配置、共享 UE 探测模块、AH 源码迁移血缘清单和安装器源码。另生成 RELEASE.json，记录完整提交、逐文件摘要及组件清单摘要。临时目录和安装包都位于项目内被忽略的 .deploy/twin-controller/。
3. current 与 previous 指向不可覆盖的完整版本目录。没有两份不同、完整、经过验证的版本，不报告可回退。新探测模块通过控制器真实文件所在的版本目录加载，不另建系统路径兼容副本。
4. 唯一安装入口是 root 管理的普通文件 /usr/local/sbin/opsmind-twin-install-release，只提供 status、install、rollback。安装器源码随包归档，但不能从历史包执行安装器或将安装入口随版本回退；发布单独核验固定入口摘要。
5. 安装/回退复用 /run/lock/opsmind-twin.lock 和唯一物理租约。必须空闲、无残留归属且启动号一致。忙碌、损坏或旧启动记录会拒绝；安装器不修租约、不复位考场、不建立第二套监督。
6. 修改运行入口前验证完整包；校验和安装使用同一份读取内容。拒绝额外文件、路径越界、链接、重复文件、摘要错误和版本冲突。普通切换异常恢复原入口与版本指向，恢复失败明确报告。
7. status 核验版本归档、实际入口内容与安装器摘要；不启动实验进程。版本身份不等于真实链路已验收。回退仅切换代码/基线配置，不修改数据库、租约、Trace、账本、秘密或修复权限，不删除历史版本。

### 本次把既有 AH 实验室文件纳入统一版本

实验室原控制器已由 EvalOS 管理，四个 AH 实验室执行文件原先单独部署。首次扩展版本范围必须先保全这四个文件，不能先升级再去寻找旧副本。

- 源码搬迁单独提交，四个运行文件保持原内容；源仓库、提交、路径和 LF 摘要记录在 harness-source-lineage.json。此迁移提交与随后网络行为修复分开。
- 推送迁移提交后，使用同一打包工具的 --adoption-ref FULL_MIGRATION_COMMIT 生成完整旧组件包。只接受完整提交号，并校验其是当前候选祖先且已存在于远端分支；不切回旧分支。该包包含原控制器和迁移前四个 AH 文件，不包含新探测模块。
- 再从已推送、干净的最终候选 HEAD 生成新包。分别记录两个包的版本与摘要，不能混用。
- 调用固定安装入口：
  `install NEW_ARCHIVE NEW_RELEASE_ID NEW_SHA256 --adopt-harness OLD_COMPONENT_ARCHIVE OLD_COMPONENT_RELEASE_ID OLD_COMPONENT_SHA256`
- 安装器先逐一确认现场 12 个文件与完整旧组件包相同，再保存旧版、纳入版本指针，最后整体切换新版。任一文件不同即停止；不能把未知现场内容登记为已批准版本。
- 完成后 previous 是包含全部 AH 文件的旧组件版本，可以完整回退；禁止回退到只有原控制器、缺少 AH 文件的半份版本。
- 纳入旧组件时中途退出，可重跑同一命令；已经纳入旧组件的 current 也可直接继续正常 install。切换未完成时如实显示不可回退；普通异常恢复原指针。测试模拟进程中断，不冒充真实服务器断电验收。
- 后续版本使用普通 install，不重复使用 --adopt-harness。AH 原安装脚本及重复源码已退役，不能重新启用。

### 尚未建立版本指针的旧主机

已有主机首次登记使用 --baseline 明确提供准确旧包，不能抓取未知现场文件充当基线。同一打包工具的 --baseline-ref 只接受可读的实验室 accepted/prod 标签，并验证祖先关系。

若旧包只有原控制器的 9 文件清单，首次 install 必须同时提供 --baseline 和 --adopt-harness，核对原文件及 AH 文件后才切换。已纳入全部组件的旧包可直接作为完整 baseline。没有可核对的完整来源时停止；此入口不承担新建主机或恢复凭据的职责。

### 当前主机条件与 UE—MEC 修复边界

升级沿用既有 Open5GS、MongoDB、UERANSIM、网络命名空间、AH 身份/权限、DNS/MQTT 配置及绑定秘密。安装器不创建账号、不改 sudo 权限、不加载内核模块、不改系统网络参数。

发布前核查既有 iproute2、iptables、ping、curl、DNS/MQTT 服务，并核查本次探测所需的 traceroute 和 python3-dnspython。缺依赖必须显式处理并记录，不能把采集工具缺失当成业务故障；不能在安装器中暗含主机重建。

harness_network 是当前单 UE 实验室的业务网络配置。共享探测模块每次从当前 Trial 的 UE 资源解析实际 TUN 与地址，五类主动探测都绑定此数据出口，不改 UE 路由或退回管理网。UE→MEC 只在专用出口免于源地址转换，复用 MEC 的 UE 回程；原 DN 保持原行为。故障规则在正常放行之前生效，清理只移除本拓扑拥有的规则/资源，并在释放物理租约前验证清理。

普通资源快照不主动检查业务。独立验证身份的动作前、动作后、回退后快照重新采样 DNS/HTTP；注册/PDU 与 MEC 业务必须同时成功才报告任务恢复。缺失/歧义资源或采集失败明确表述，不能把无法确认当作成功。HTTP 日志只记录固定健康检查、源地址、响应状态和写出结果，并限制文件大小。

### 工程验证边界

Linux 安装器测试：
`python3 -B -m unittest discover -s infra/twin -p test_controller_release.py -v`

测试用真实 Linux 文件、符号链接和文件锁，所有路径、包和租约都重定向到临时夹具。测试不操作线上服务、不启动 Trial、不调用模型，也不证明真实链路已恢复。Windows 仅运行可用的打包检查，Linux 专用测试明确跳过，不能计作通过。

探测、规则顺序与控制器语义使用 test_harness_probes.py、test_harness_network.py、test_harness_labctl.py 回归。正式候选仍须完成真实出口/NAT、故障生效、会话重建、复位和其他消费者回归，以及准确版本的双路线验收。
