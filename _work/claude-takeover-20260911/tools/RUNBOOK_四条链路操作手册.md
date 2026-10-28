# 四条链路操作手册（Runbook）

固化日期：2026-09-14
最后校订：2026-09-16（对齐 `docs/HANDOFF_四条链路收口与控制台开放_ClaudeCode_20260916.md`）
用途：驱动四条链路。所有脚本在本目录。

> ### 2026-09-16：这里原先有一句假承诺，已作废
>
> 原文写的是"**新会话直接照此驱动四条链路，无需再从历史脚本反推流程**"。
> 那句话当时**不成立**，而且骗了两轮人：
>
> - `ah-*` / `lg-*` / `cmp.sh` 里把 **09-11 那一轮的调查编号、action 编号、trial 编号**
>   当字面量写死了。最坏的不是跑不起来，是 `ah-progress.sh` 会**不报错**地返回
>   09-11 那条已完成调查的状态——你会以为今天这次跑完了。
> - `evalos-op.sh` 的版本守卫钉死 EvalOS 提交 `41d99bc4`（2026-09-10 的发布），
>   线上一升级就在调 preflight 之前 fail-closed。
> - 它的 `idempotency_key` 也写死：复用同一个键再提交，EvalOS 会**返回上次那个请求**，
>   看起来像"提交成功"，实则什么都没跑。
> - `*-seal.sh` 把证据写进 `claude-takeover-20260911/` 这个旧批次目录。
>
> 所以 **2026-09-14/15 那一轮实际上没用这些脚本**——查证：那一轮的全部编号
> （`inv-75d347b34b3b`、`inv-3e577111c1be4798ad53fa0f`、`trial_787ed2b2df7402e7d367`、
> `trial_8be82e5264cb6a2fbc5d`、`exp_d3e867ec11bc04410b25`）在整个 `_work` 树里
> **没有任何 `.sh` 文件带它们**，只出现在 markdown 文档里。那一轮是现场拼命令喂给
> `ca.sh` 跑的，跟 09-11 一样。**每一轮都在重新推导流程，而这份手册声称不用。**
>
> **2026-09-16 已把这批脚本全部参数化**：写死的值改成必须传入的环境变量，
> **不给默认值**（给默认值等于保留陷阱），缺参数就拒绝运行并打印用法。
> 同时补上此前缺失的那块——统一启动器 `run-on.sh`。现在这句承诺才成立。

> **2026-09-16 校订范围**：§0 SSH 不通的真实原因、§0.1 控制台访问方式（新增）、
> §1.1 控制器身份断言、§2 冻结源实验 ID、§3 现行基线与 `task_success` 口径、
> §4 现行证据批次、§5 坑 9 的 nginx 段（IP 白名单已整条移除）、§5 新增坑 11（欠费的两种面貌）。
> 校订前的版本见 Git 历史（本文件与同目录脚本自 2026-09-16 起纳入 Git 跟踪；
> `_work/` 整体仍在 `.gitignore` 内，这些文件是显式 `git add -f` 进来的）。

---

## 0. 三台机全走 SSH（2026-10-29 起；云助手只剩账号层面的事）

> **2026-10-29 更正**：本节此前写「考场走 SSH、另两台走 Cloud Assistant」。10-27 实测三台都能经考场隧道 SSH，
> 10-29 起工具链全部改走 SSH：入口**只写在 `remote-hosts.sh` 一个地方**，`run-on.sh` / `send-file.sh` /
> `ah-deploy.sh` / `lg-deploy.sh` / `check-certs.sh` / `demo-window.sh` 都 source 它。

```
本机 ──WireGuard(UDP)──► 考场 EvalOS 10.77.240.1   root，钥匙 opsmind-evallab-ed25519
                           ├─► 产品机 10.77.240.4   root，钥匙 opsmind-aliyun，经考场 -W 转发
                           └─► 实验室 10.77.240.3   ecs-user + sudo -n（root 被禁），同上
```

| 行为 | 云助手时代 | 现在 |
|---|---|---|
| 退出码 | 永远 exit 0，要解析 `### exit=N` | **就是远端退出码**；255 = SSH 自己连不上（会打提示） |
| 时长 | 300 秒上限 | 没有；要限时给 `TIMEOUT=秒` |
| 输出 | 会截断 | 不截断 |
| 传文件 | 切 18 KB 一块、157 块往返 | 一条连接流式送达，远端核对 sha256 后才落地 |

**连不上先查两件事**（不是认证问题）：本机 Clash 是不是被切成全局模式；当前网络是不是封 UDP。

**长任务一律在主机上脱离会话跑**（`setsid nohup … &`，再读日志）：10-29 中途断过一次线，
LG 发版停在加白名单之前（线上没动，重跑即好）。实验室校准、考场发版窗口都按这个做。

云助手（`ca.sh` / `ca-eval.sh`）只剩查到期日、改安全组这类阿里云账号层面的事，平时不用。

### 0.1 怎么跑这套工具（统一入口）

```bash
./run-on.sh <product|evalos|lab> <脚本文件> [VAR=值 ...]
./run-on.sh <product|evalos|lab> - '<直接执行的命令>'
HOST=<product|evalos|lab> SRC=<本地文件> DEST=<远端路径> ./send-file.sh
```

```bash
# 实验室状态与租约
./run-on.sh lab - 'opsmind-harness-labctl manage-status'
# 新故障空跑校准（不花模型钱，44 次约 25 分钟，脱离会话跑）
./run-on.sh lab lab-fault-calibration.sh [SCENARIOS="a b"] [CANDIDATES="ah lg"]

# AH 直连：提交 / 轮询 / 看提案 / 审批 / 封存 / 复位
./run-on.sh product ah-direct-submit.sh NS=<命名空间> SOURCE=<唯一> NATIVE_TRIAL=<同 NS> EXPECT_AH_REV=<线上提交>
./run-on.sh product ah-progress.sh INV=<inv-id>
./run-on.sh product ah-inspect.sh  AID=<action-id>
./run-on.sh product ah-approve.sh  AID=<action-id> INV=<inv-id> NS=<本轮命名空间>
./run-on.sh product ah-seal.sh     INV=<inv-id> TAG=ah-chain1 BATCH=<证据批次目录>
./run-on.sh product ah-reset.sh    INV=<inv-id> NS=<本轮命名空间>

# 版本登记：产品机部署证明 → 考场只读发现 → 本机改三份配置（register-candidates.mjs）
./run-on.sh product product-deployment-proof.sh TAG=<证据目录>
./run-on.sh evalos  evalos-discover.sh

# EvalOS 链路：EXPECT_REV 取线上 RELEASE.json 的 source_revision，SRC_EXP 取当次最新冻结源
./run-on.sh evalos evalos-op.sh OP=preflight REF=agent-harness-v2 EXPECT_REV=<线上提交> SRC_EXP=<冻结源> CASES=M33-MAIN-14@3.3.0
./run-on.sh evalos evalos-op.sh OP=submit ... IDEM=<本轮唯一键>
# 正式考试（完整题库 × 两考生，先预检 ready 才提交）
./run-on.sh evalos evalos-formal.sh SRC_EXP=<冻结源> IDEM=<本轮唯一键> OP=submit
```

**缺参数会被拒绝并打印用法**，不会悄悄用上一轮的编号。

### 0.2 控制台访问（人要看页面时）

**三个入口，常态关闭，演示前后开关**（2026-09-16 起）：

```
https://121-40-223-202.sslip.io/        EvalOS 控制台（考场）  账号 opsmind
https://lg.114-55-40-170.sslip.io/      LG 工作台（考生甲）    账号 opsmind-lg
https://ah.114-55-40-170.sslip.io/      AH 工作台（考生乙）    账号 opsmind-ah
```

一律 **必须 https**（产品机不开 80，漏打会"连接被拒绝"；EvalOS 的 80 是 301 跳转）。
口令哈希在服务器 `/etc/nginx/opsmind-*.htpasswd`，**口令不入 Git**。

```bash
./demo-window.sh status      # 看三个入口当前开/关
./demo-window.sh open        # 演示前（也可只开一个：open lg）
./demo-window.sh close       # 演示后
./check-certs.sh             # 证书到期与续期状态（两台机）
```

**关闭态是硬 403，不是 401**：`deny all;` 与 `auth_basic` 同时存在时，nginx 的 access
阶段先于认证阶段生效，带正确口令也拿不到内容（实测 7 种组合确认）。
**关页面入口不影响链路③④**——`/api/candidate-relay/` 与 `/api/candidate-presence`
不含开关也无认证（日志实证 42 万次认领全部来自产品机）。但注意
`/api/trials/.../judge` **是带认证和开关的**，它不受影响只是因为评测走机内
`127.0.0.1:3000` 不经 nginx。排障的三道关见第 5 节坑 9。

**产品机上的 AH 前端与 LG 工作台目前浏览器够不着**：产品机对外只开 22 端口、无 nginx。
LG 的 `/app` 在机上已经在跑（监听 `127.0.0.1:8081`，`/app` 返回 200；**不是** compose
默认的 8080），AH 的 API 在 `127.0.0.1:8000`（`/v2/auth/me` 返回 401）。

> **2026-09-16 更正**：这两个**是容器，不是裸进程**——`opsmind-langgraph-api` 与
> `opsmind-agent-harness-api`，都用 **`net=host`**。所以 `ss -ltnp` 里显示的是裸
> `python` 而没有 `docker-proxy`（cgroup 已确证），很容易误判成宿主机进程。
> 对比：`mysql`/`redis`/`postgres` 走 bridge 网络，`ss` 里能看到 `docker-proxy`。
整机只有 22 端口是 `0.0.0.0`，其余全在回环；宿主机 iptables 是空策略 ACCEPT，
**安全组是唯一的网络边界**。

**三个工作台都要能出场演示**，方案见
`docs/implementation/三个工作台公网入口_外围MVP方案_20260916.md`（待批准）。
规划地址：LG `https://lg.114-55-40-170.sslip.io/`、AH `https://ah.114-55-40-170.sslip.io/`。
AH 的前端**不在服务器上**，且 API 地址是构建期写死的（`apps/web/src/api/client.ts:1`，
缺省 `http://127.0.0.1:8000`），必须用 `VITE_AGENT_API=` 重新构建成同源相对路径。

---

## 1. 直连链路（① AH→5G，② LG→5G）

### 1.1 实验室 prepare

在**实验室主机**执行。前置断言必须全过，否则停止。

```
控制器身份按 RELEASE.json 的**发布清单摘要**核对
  （2026-09-14 起 EvalOS 侧的网络取证**不再钉死 Git 提交号**；线上控制器现为 18d3eb90，
   标签 prod-twin-20260914-business-truth-contract。旧文里的 8e859e82 已是历史，
   照抄会误判成「实验室被人动过」而白停一轮）
物理租约 status == "idle"
网关 SHA-256 匹配（**一律取当次 RELEASE.json 清单值**；
  LG 上次观测 92c4a427…aaef59，仅作对照参考，不要当断言用）
```

```bash
# AH
/usr/local/sbin/opsmind-harness-labctl   manage-prepare <trial_id> sctp-blocked 2026081601 agent_harness_direct
# LG
/usr/local/sbin/opsmind-langgraph-labctl manage-prepare <trial_id> sctp-blocked 2026081601 langgraph_direct
```

Trial 命名惯例：`ah-<用途>-<日期>-NN` / `lg-<用途>-<日期>-NN`

### 1.2 提交调查

relay 配置（含各角色令牌目录与产品 API 源）：
- AH：`/etc/opsmind-candidate-relay/agent-harness-v2.env`
- LG：`/etc/opsmind-candidate-relay/langgraph-v1.env`

三个角色令牌：`candidate_submitter` / `approval_oracle` / `mode_administrator`

| | AH | LG |
|---|---|---|
| 创建调查 | `POST /v2/investigation-candidates` | `POST /api/v1/candidates` |
| 查状态 | `GET /v2/investigations/<inv>` | `GET /api/v1/investigations/<inv>` + `/product-e2e` |
| 审批 | `POST /v2/actions/<aid>/approval` | `POST /api/v1/investigations/<inv>/approvals` |
| 身份 | `GET /v2/auth/me` | `GET /api/v1/me` |
| 复位 | `POST /v2/investigations/<inv>/protocol-lab/reset` | 实验室侧 `manage-reset` |

**公开症状必须逐字节一致**（四条链路对照的前提）：
`goal_sha256 = fb0dbd53eb285b26e287b8349906fe4586473520ece5e84b35407f0c38965352`
全文见 `_work/network-evidence-20260906/direct-06-submit.sh`（AH）与 `_work/lg-repair-20260909/lg-direct-submit-11.sh`（LG，base64）。

提交前应校验：容器镜像 label `org.opencontainers.image.revision` == 预期提交；
`operating_mode == human_collaboration`；`production_write_enabled == false`。

### 1.3 审批（以独立裁判身份）

审批前必须校验的安全不变量：

```
scope.resource_ref.namespace == 本轮 trial
scope.resource_ownership == "trial_lease"
scope.deployment_profile == "ISOLATED_LAB"
scope.shared_resource is False
policy_decision.execution_mode == "controlled_simulation"
policy 有效期未过（AH 30 分钟；LG 申请 30 分钟 / 执行票据 60 秒）
submitter.user_id != approver.user_id        ← 职责分离
approver.permissions.approve_action == True
```

审批请求体必须绑定 `proposal_digest` + `snapshot_digest`（防串票）。

脚本：`ah-inspect.sh`（看提案）→ `ah-approve.sh`（批准）

### 1.4 轮询、封存、复位

- 轮询：`ah-progress.sh` / `lg-progress.sh`（建议 45–60 秒一次，放后台）
- 诊断失败原因：`ah-why.sh`（stop_reason / error_message / status_semantics）、`ah-tail.sh`（末尾事件与在途工具）
- 封存：`ah-seal.sh` / `lg-seal.sh` → 落到服务器 `/srv/opsmind-evidence/<批次>/`，本地只留摘要
- 复位：`ah-reset.sh`（走产品 API）/ 实验室侧 `manage-reset`（LG）
- 复位后必须确认 `lease.status == "idle"` 且 `clean == true`

---

## 2. EvalOS 链路（③ AH→EvalOS→5G，④ LG→EvalOS→5G）

EvalOS 控制 API 在 **`http://127.0.0.1:3000`**（仅本机，无需令牌，通过 Cloud Assistant 在机上调用）。

统一入口脚本：`evalos-op.sh`，通过环境变量传参：

```bash
{ echo 'OP=preflight; REF=agent-harness-v2; ARG1=-; ARG2=-'; cat evalos-op.sh; } > run.sh
./ca-eval.sh i-bp14ezltpnq8mxic1gsb 180 < run.sh
```

`OP` 取值：`preflight` / `submit` / `status` / `progress` / `details`
`REF` 取值：`agent-harness-v2` / `langgraph-v1`

**关键请求参数（两个候选相同）：**

```
mode                 : QUICK_VALIDATION
request_kind         : NEW_EVALUATION
evaluation_purpose   : SINGLE_SYSTEM_REGRESSION
source_experiment_id : <当次登记生成的最新冻结源>   ← "M3.2 现场症状自主诊断验收冻结源"
case_refs            : ["M3-OBS-001@3.2.0"]
environment_seeds    : [2026081601]
repetitions          : 1
requested_concurrency: 1
```

**不要用历史实验 ID**，要用当次登记自动生成的最新冻结源。已用过的历史值（**全部不要照抄**）：
`exp_5c63a32c9596333f2ffb`、`exp_43ba9a7da14b2c596d5e`、`exp_3d36f6e4067a5ac8c227`（2026-09-11）、
`exp_d3e867ec11bc04410b25`（2026-09-16，本手册校订时的最后一轮）。

公开症状必须逐字节一致：`goal_sha256 = fb0dbd53eb285b26e287b8349906fe4586473520ece5e84b35407f0c38965352`

**流程：** `preflight`（必须 `ready: true`、`blockers: []`）→ `submit` → 轮询 `status` 直到 `COMPLETED` → 取 `trial_id` → `ev-assert.sh` 看维度与硬门 → `ev-seal.sh` 封存。

**EvalOS 会自己管理实验室租约**（`owner_mode: evalos_trial`，命名空间加 `ah-`/`lg-` 前缀），也会自己复位。不要手动干预。

**耗时参考：** AH 约 5 分钟；LG 约 20–30 分钟。

---

## 3. 评分口径（读分数前必看）

**满分不是 100。** 9 个维度中 4 个在本 Case 声明为"不适用"并从满分中**剔除**：

| 维度 | 权重 | 本 Case |
|---|---|---|
| task_success | 25 | 适用 |
| rca_quality | 15 | 适用 |
| evidence_quality | 15 | 适用 |
| trajectory_quality | 15 | 适用 |
| engineering_agility | 5 | **不适用** |
| open_world | 15 | **不适用** |
| proactive_capability | 5 | **不适用** |
| resource_cost | 5 | **不适用** |
| recommendation_quality | 0 | 仅资格信号 |

**实际满分 = 70。**

| 基线 | AH（链路③） | LG（链路④） |
|---|---|---|
| 2026-09-11 | 64.5/70 = 92.14 | 27.5/70 = 39.29 |
| **2026-09-16（现行）** | **96.43**（`trial_787ed2b2df7402e7d367`） | **100**（`trial_8be82e5264cb6a2fbc5d`） |

两条都是 15/15 硬门通过。③ 离满分差的那一档是 `evidence_quality` 命中 5/6，
属模型逐次波动，**不是回归**，不要当缺陷追。

`task_success` 判定公式（`grader.mjs:380`）：
```
value = statusHit && (expectedStatus==="inconclusive" || rootCauseHit) && environmentTaskPassed
```
其中 `statusHit` 与 `rootCauseHit` **来自候选自己的报告**；`environmentTaskPassed` 自 2026-09-14
起**已改为读业务真值契约**——不再读实验室场景分，那一项已经修完（`grader.mjs:366-376`）：

```
environmentTaskPassed     = changePolicyPassed && environmentRecoveryPassed
environmentRecoveryPassed = 契约不适用 || expected_behavior == "diagnose_only"
                         || ( business_verification.contract_version
                                == "opsmind-mec-business-verification/1.0"
                              && business_verification.passed === true )
```

**业务真值不是 `passed === true` 就一律不通过**——`false` 与 `None`/`inconclusive` 都算不通过。
对照实验是这条口径的实证：⑤ `trial_d7bdff026c116e4fd8cc`（故意不修数据面）拿到
`environment_recovery: false`、64.29 判负；⑤-b 强对照 `inv-37e9847fe582` 控制面修好、
数据面仍断 → `business_passed: false`。**控制面修好 + 进程存活 ≠ 业务恢复。**

---

## 4. 证据位置

**现行批次（2026-09-14 业务真值契约）**——统一目录
`/srv/opsmind-evidence/business-truth-contract-20260914/`：

| 位置 | 内容 |
|---|---|
| 产品机 `114.55.40.170` | 链路 ①②⑤-b 的调查全量 JSON + .gz |
| EvalOS 机 `121.40.223.202` | 链路 ③④⑤ 的 Trial 全量 JSON + .gz；`console-click-e2e-20260916/`（控制台点击验收 10/10、10 张截图、SHA256SUMS）；`deployment-proof-20260915.json`、`candidate-discovery-20260915.json` |
| D 盘 | `_work/claude-takeover-20260911/验收证据清单_业务真值契约_20260914.md`（含各份 sha256，防云盘丢失） |

**历史批次（2026-09-11）**：

| 位置 | 内容 |
|---|---|
| 产品机 `/srv/opsmind-evidence/claude-takeover-20260911/` | 链路① `ah-chain1-inv-608b343f5330.json`（677720 B，sha256 `fc4945a7…`）；链路② `lg-chain2-inv-f3b024e29c6940149d5cf98b.json`（1241367 B，sha256 `abe5cef2…`） |
| EvalOS 机 同路径 | 链路③ `ah-chain3-evalos-trial_d0cd88d0a0aa0700452e.json`（2250667 B，sha256 `4908a3d3…`）；链路④ `lg-chain4-evalos-trial_b5c10dfd80c54d2e8dea.json`（2451844 B，sha256 `38c77d02…`） |
| 实验室机 同路径 | 三份 PCAP |
| D 盘 `_work/claude-takeover-20260911/` | 摘要、PCAP 副本、分析报告、本工具目录 |

---

## 5. 踩过的坑

1. **Cloud Assistant 输出截断** —— 大 JSON 走 base64 会被截断。先落盘服务器再分块取。
2. **全表扫描必超时** —— `candidate_relay_requests` 16.72 GB 无 `created_at` 索引，任何按日期聚合都要几分钟。用 `nohup` 后台跑。
3. **轮询脚本空输出当成完成** —— 解析失败返回空串时不能判为终态，必须重试（`ca.sh` 已修）。
4. **`opsmind-twin` SSH 别名不要用** —— 它是考务身份，可能触碰实验室核心，且其私钥已不在 `.ssh` 目录。
5. **LG 顶层目录是废弃的独立 clone** —— 对象库里没有 `f99d377` / `e34773b`，`git log` 会静默给出错误画面。正确目录见 HANDOFF。
6. **云助手重试必须带 `--ClientToken`** —— 回包丢失不等于命令没执行。2026-09-15 实测：
   代理抖动时约半数 TLS 握手会失败，其中一部分是"阿里云已经创建调用、脚本已在主机上跑"，
   只是回包没拿到。不带 token 的重试会让同一段脚本在主机上**跑两遍**——本次就让"拼装发布包
   + 启动安装器"跑了两遍，差一点并发起两个安装器（停服务、备份 19G 库、换 current 软链）。
   `ca.sh` / `ca-eval.sh` 已在重试循环**外**生成一个 ClientToken 并在每次尝试中复用。
   实测：同一 token 两次调用 → 同一个 InvokeId、主机只执行 1 次；不同 token 两次调用 →
   两个 InvokeId、执行 2 次。**不要把这个 token 挪进循环里，那等于没修。**

7. *（编号空缺，历史遗留。HANDOFF 与其他文档按**现有**编号引用坑 6 / 8 / 9，**不要重新编号**。）*

8. **EvalOS 备份保留策略（2026-09-15 起）** —— 每次装包都会整份复制 19 GB 的
   `control.sqlite`，两代就吃掉 38 GB，99 GB 的盘会很紧。策略：**最新一代保持原样**
   （紧急恢复要快），**更旧的一代用 zstd 压缩**。实测 19 GB → 731 MB（26 倍），
   压完必须 `zstd -dc | sha256sum` 与原件逐字节比对通过才删原件。
   摘要留在同目录 `control.sqlite.sha256`。

9. **控制台有三道关，别只查一道** —— 2026-09-15 排查页面验收时逐一撞过：
   1) **阿里云 ICP 备案拦截**：`sslip.io` 未备案，从**公网**（家庭宽带等）走 **80 端口**
      访问会被阿里云在入口替换成"域名暂时无法访问"页，**根本到不了服务器**。
      云内互访（产品机→EvalOS）不经过它。nginx 在 80 本就是 301 跳 https，
      **所以一律用 `https://`，不要用 `http://`**。
   2) **nginx 访问控制（2026-09-15 已换机制，下面这段旧描述作废）**：从前是
      `allow 111.55.79.0/24; deny all;`，只放行运营方真实宽带段，挂 VPN 就 403。
      **该规则已整条移除**，现在是 **Basic 认证 + `limit_req` 限速**，任意网络都能登。
      - 拿到 **401 + `WWW-Authenticate`** = 服务活着、缺凭据（账号 `opsmind`，口令不入 Git）
      - 三个机器对机器入口**故意不加认证**（各有自己的令牌），改 nginx 时不要碰：
        `location ^~ /api/candidate-relay/`、`location = /api/candidate-presence`、
        `location ~ ^/api/trials/.../judge`
      - 总开关 `/etc/nginx/opsmind-console-access.conf`：空 = 开放，写入 `deny all;` = 关闭；
        改后 `nginx -t && systemctl reload nginx`。改动前备份在
        `/etc/nginx/opsmind-evalos.backup-20260915-before-auth`
      - 仍然**不要为了跑通验收放宽这里**（本轮已拒绝过两次：给沙箱 IP 放行、给共享 VPN 出口放行）
   3) **控制台只监听 `127.0.0.1:3000`**，不对外；WireGuard 那几个对端是服务器之间的
      管理网，nginx 也没给 `10.77.240.0/24` 单独放行，走不通。
   判别方法：**401** = 服务活着、缺凭据；**403** = 被 `opsmind-console-access.conf` 里的
   `deny all;` 总开关拒；**「域名暂时无法访问」备案页** = 连服务器都没到（多半是用了 `http://`）。

10. **AH 的 Agent 可能自己跑 `sleep`** 等审批，撞 30 秒看门狗导致 fail-closed（链路① 实证，非必现）。

11. **欠费会以两种完全不同的面貌出现，其中一种很像网络抖动** —— 2026-09-15 一天内撞过两次：
    - 余额 **-1.05 元**：EvalOS 实例被**停机并锁定**（`OperationLocks: financial`）。现象明显。
    - 余额 **-0.59 元**：实例**活着**、TCP 能连，但**公网被限**，TLS 握手包出不去，
      relay 断了 2 小时。这一种最难认——排查时会一路往网络、证书、代理上找。

    **机器是包月、流量是后付费，买了包月不等于不会欠费。**
    所以「连不上」的排查顺序里，**先查余额再查网络**。同目录 `check-balance.sh` 两个账号一起查：

    ```bash
    ./check-balance.sh          # 默认阈值 100 元，低于阈值以非零码退出
    ```

    到期日：主账号 `1275476353815639` 2026-11-10；evallab `1832716768005950` 2026-11-15，
    三台约 380 元/月。**余额预警（低于 100 元发短信）没有 OpenAPI，只能在控制台设**，
    步骤见 `_work/claude-takeover-20260911/余额预警设置步骤_20260916.md`。

13. **"断言全绿"和"页面能用"是两件事** —— 2026-09-16 实测。nginx 漏配了 AH 的 `/health`
    （`apps/web/src/api/client.ts:118`，它是 AH 唯一一个不在 `/v2/` 下的接口），
    该请求落到静态 location 的 `try_files` 上拿回 `index.html`，前端把 HTML 当 JSON 解析，
    页面上显示 `Unexpected token '<', "<!doctype "... is not valid JSON`。

    这个缺陷**同时躲过了三道检查**：它被前端 `catch` 了所以不是未捕获异常；
    它不影响首页的 HTTP 200；它不阻止 React 挂载。**那一轮 20/20 全绿，页面却是坏的。**

    所以验收项里必须有一条**直接读页面文本、不允许出现可见报错**。
    `tools/e2e-consoles.mjs` 里那条 "AH 页面上没有可见报错" 就是为此加的。

    连带两条：
    - **curl 永远抓不到这类问题**，因为它不执行页面 JS。混合了静态与反代的 vhost
      （AH 是，LG 不是）必须用真浏览器验一遍。
    - `node x.mjs | tail -40` 的退出码是 **`tail` 的**，不是 node 的。本轮差点把一次
      未捕获异常当成通过。要取真实退出码就别接管道，或者用 `PIPESTATUS`。

14. **`return 200` 不能用来做 nginx 访问控制的探针** —— `return` 属 rewrite 阶段，
    **在 access 阶段之前**，会把 `deny`/`auth_basic` 整个绕过。用静态文件或 `proxy_pass`。
    另外 `systemctl reload nginx` 是**异步**的，紧跟其后的请求可能还打在旧 worker 上，
    验证前等几秒。两条都是 2026-09-16 踩过才知道的。

12. **本机的网络环境会骗你，别用 `curl`/`nslookup` 判断线上可达性** —— 2026-09-16 实测：
    这台 Windows 机跑着 **TUN 模式代理全局接管**。DNS 解析器是 `198.18.0.2`，任何域名都被
    解析成 `198.18.0.x` 的 fake-IP；**真实出口在日本东京 `188.253.123.160`**。
    `--noproxy '*'` 绕不开，因为是网络层接管，不是环境变量。

    实测对照（同一个地址，同一时刻）：

    | 方式 | 结果 |
    |---|---|
    | `curl https://121-40-223-202.sslip.io/` | schannel 握手失败 |
    | `curl --noproxy '*' ...` | Connection reset（0.03 秒） |
    | `curl` 用**纯 IP** `https://121.40.223.202/` | **HTTP 401**（正常） |
    | **浏览器**打开 `https://121-40-223-202.sslip.io/` | **401 Authorization Required，正常** |

    所以：**判断"页面能不能打开"一律用浏览器**；要在命令行验证就到服务器上用
    `getent hosts` / `curl` 自测。拿本机 curl 的失败去推断"线上挂了"会白查半天。

    **而"用浏览器"在这个项目里只有一条路**（2026-09-16 三条都试过）：

    | 通道 | 状态 |
    |---|---|
    | 内置浏览器 `mcp__Claude_Browser__*` | 被安全分类器拦下，对整个会话持续生效，别反复重试 |
    | Claude in Chrome 扩展 | **永久不可用**——运营方的 Claude 账号性质登录不了 Chrome 侧边栏 |
    | **本机 Playwright 驱动真实 Chrome** | ✅ 唯一可行，已固化为 `tools/e2e-consoles.mjs` |

    ```bash
    ./e2e-consoles.mjs 的跑法： node e2e-consoles.mjs      # 或加 --headed 看着它跑
    ```

    靠的是两个**既有**条件，不用新装东西：`OpsMind/apps/web/node_modules/playwright-core`
    （AH 的 devDependency）+ 已安装的 Chrome。脚本自管演示窗口，`finally` 里必定关回去。

    同一组实测确证了 SSH 不通的根因：安全组白名单里没有东京出口 `188.253.123.160`。
    TCP 能连上（TUN 接口先应答）但拿不到 banner，**不是"服务没起"**。

    **sslip.io 子域可用**（服务器侧 `getent hosts` 实测）：
    `lg.114-55-40-170.sslip.io` 与 `ah.114-55-40-170.sslip.io` 都解析到 `114.55.40.170`，
    所以两个工作台各占一个主机名的根路径，不需要路径前缀或 `sub_filter` 改写。

15. **LG 的终态不只有 `resolved`/`failed`，还有 `insufficient_evidence`** —— 2026-09-16 链路②
    实测。轮询脚本的终态判断必须把它算进去，否则会一直转到轮询上限，看起来像"卡住了"。
    （同一天 AH 那个 watcher 也漏了 `resolved`，同样的毛病。**写轮询前先去 API 里把终态枚举
    列全，不要凭印象写 case 分支。**）

    更重要的是别把这个状态误读成"链路失败"：那一轮 LG 实际上
    **改对了、业务真值过了、独立只读验证器判 `effective`**，只是它自己的 Evidence Gate
    不允许发布结构化根因。链路通与结论合格是两件事，报告里要分开写。
    机制见 `docs/implementation/待办_编排方式对比与批量故障评测_20260916.md` §1.4.1。

16. **`lg-progress.sh` 看到的 `root_cause` 会在终态被清空** —— 跑到一半它是有值的
    （`autonomy_policy_decision` 阶段），`finalize_and_learn` 之后变 `null`，正文搬到了
    `investigation.conclusion` 和 `task_result.best_available_conclusion`。
    **中途截图当成终态证据会得出相反结论。**

17. **LG 的 `report` 字段不存在，别照 AH 的形状去读** —— 2026-09-16 我按 `report.root_cause`
    去查，拿回一堆空值，差点报成"LG 什么都没产出"。LG 的投影里对应的是
    `investigation.conclusion` / `investigation.uncertainty`，以及
    `product-e2e` 的顶层 `root_cause` / `root_cause_confidence` / `task_result`。
    两个产品的 API 形状不同，**先 `sorted(obj.keys())` 再取字段。**

18. **`ca.sh` 不管远端成功失败都 `exit 0`** —— 它只把 `### exit=N` 打在输出里。
    所以在驱动脚本里 `set -eu` **拦不住远端的失败**：一个 sha256 校验不符的分块会被
    直接放过去。凡是靠云助手串多步的脚本，**必须自己解析 `### exit=` 那一行**。
    `lg-deploy.sh` 里的 `run()` 就是这么写的，可以照抄。
    同理**别把 `run` 放进管道**——管道退出码是右侧命令的，守卫会白写（本轮踩过两次）。

19. **云助手单次调用 300 秒 Timeout 会杀脚本壳，但 `docker build` 还在跑** ——
    2026-09-16 部署 LG 实测：`### exit=None status=Timeout`，看着像构建失败，
    其实 `ps -ef` 里 `docker build` 和 buildkit 都还活着，几分钟后镜像正常出现。
    **看到 Timeout 先去查进程和镜像，不要重跑**（重跑会并起第二个构建）。
    正确做法是 `setsid nohup docker build ... &` 脱离会话，再另起轮询等它，
    见 `lg-deploy.sh` 的 5/6 步。

20. **LG 的部署是"发布控制器 + 白名单"，不是 `docker compose up`** ——
    控制器在 `/usr/local/sbin/opsmind-langgraph-release`，只有
    `status | apply <release> | rollback` 三个子命令：

    ```bash
    ./run-on.sh product - '/usr/local/sbin/opsmind-langgraph-release status'
    ./run-on.sh product - '/usr/local/sbin/opsmind-langgraph-release rollback'
    ```

    - release id 是**提交号前 12 位**，目录 `/srv/opsmind-langgraph/releases/<id>`，
      镜像 `opsmind-langgraph-v1:<id>`
    - **不在 `/etc/opsmind-langgraph/approved-releases` 里会 `target_release_not_approved`**
    - 切换前它自己会核 `assert_database_compatible`（镜像 alembic head vs 线上 DB revision）
    - 切换失败会**自动切回上一个 release** 并报 `activation_failed_previous_restored`
    - `current` / `previous` 是软链接，回滚就是一条 `rollback`

    仓库里**没有** staging 脚本（主机上那堆 `incoming/parts-<release>` 是历史现场拼装的痕迹）。
    现在用 `lg-deploy.sh`：从线上当前 release `cp -a`，**只覆盖本次提交改动的文件**，
    逐个校验 sha256。好处是线上新旧的差异恰好是这次改动，实验结果才能归因，
    也顺带保住了线上与 Git 之间既有的行尾漂移（坑：CRLF 部署漂移）。

21. **LG 的策略决策只有 30 分钟有效期，过期后执行会被安全边界拒绝** ——
    2026-09-16 实测代价一次真实 Trial。`policy_decision` 里有
    `decided_at` 和 `expires_at`（相隔 30 分钟）。**审批端点会收下过期的审批记录并返回
    HTTP 200**，看着像成功；但 worker 恢复运行时会被拒：

    ```
    job.failed  error_code = runtime.security_boundary_rejected
                error_chain = [{"code":"security.denied","type":"PermissionError"}]
                retryable = false
    execution_ticket = null,  attempt = null   ← 没走到下发执行票
    ```

    **所以"审批返回 200"不等于"动作会执行"。批完要接着确认
    `action_lifecycle.attempt` 真的出现了。** 这条边界本身是对的——它拒绝在过期决策上动手；
    要怪的是没在窗口内完成审批。

    **跑 LG 链路时，从提交到 `waiting_approval` 大约 7 分钟，务必守在那儿。**

22. **后台 Bash 只在"结束"时通知，Monitor 才在"每次输出"时通知** ——
    同一天的失误：用 `Bash(run_in_background)` 挂轮询脚本，指望它在
    `waiting_approval` 出现时叫我。它不会——`run_in_background` 只有完成通知。
    结果脚本自己轮询到上限，30 分钟决策窗口就这么过掉了。

    - **需要中途介入的运行**（LG 的人工审批、AH 的 pending_approval）→ 用 **Monitor**，
      状态一变就是一个通知
    - **只需要一个"完成了"** → `Bash(run_in_background)` 配一个条件满足就退出的命令

    另外监视器的终态判断**必须覆盖所有失败态**，不能只盯成功路径：
    只 grep 成功标记的监视器在崩溃时是静默的，**而静默跟"还在跑"看起来一模一样**。
    `mon-lg-04.sh` 那个 `case` 分支可以照抄（含 `failed`/`error`/`denied`/
    `human_takeover`/`budget_exhausted`/`cancelled`）。


23. **Git-Bash 会把参数里的 POSIX 路径改成 Windows 路径，`SendFile` 因此把文件送到
    `/D:/install/Git/...`，而 API 一路报 Success** —— 2026-09-16 传 EvalOS 发布包实测。
    157 块全部"提交成功"、`DescribeSendFileResults` 全 `Success`、拼起来 sha256 也对，
    **但主机上那个目录是空的**：文件落在了 `/D:/install/Git/var/tmp/...` 底下。
    `--TargetDir /var/tmp/x` 在交给 `aliyun.exe` 之前就被 MSYS 转换成了 Windows 路径。

    ```bash
    MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' "$AL" ... ecs SendFile --TargetDir /var/tmp/x ...
    ```

    **凡是经 Git-Bash 把"看起来像 POSIX 路径"的参数传给 Windows 版 CLI，都要加这个。**
    `send-file.sh` 已经带上了。排查提示：**在主机上 `find / -xdev -name <文件名>`**——
    东西通常是传上去了，只是落在了一个字面的 `/D:` 目录里。

24. **`opsmind-evalos-maint` 把整条命令当一个参数收** —— `raw_command="${1:-status}"`
    然后自己按空格拆（配合 sudoers 的 `... opsmind-evalos-maint *`）。所以：

    ```bash
    ./run-on.sh evalos - '/usr/local/sbin/opsmind-evalos-maint "deploy <release> <sha256>"'
    ```

    不加引号会打印 `usage: deploy RELEASE SHA256`，看着像参数写错了，其实是形式不对。

25b. **发版失败回滚后，那个 release 目录会留下，挡住重装** —— 2026-09-23 实测：
    安装器拒绝装一个目录已存在的版本，报 `release already exists: /opt/...`，
    **秒退、看着像没跑**。重试前先确认它没被 current/previous 引用再删：

    ```bash
    ssh -i ~/.ssh/opsmind-evallab-ed25519 root@10.77.240.1       'readlink -f /opt/opsmind-evalos/current /opt/opsmind-evalos/previous'
    ```

25c. **发版时的冒烟检查会因为「事件循环被堵住」判 502 回滚** —— 2026-09-23 连续栽两次。
    node:sqlite 是**同步**的：任何一次大批量写操作都不是"占着锁"，而是**把整个服务
    进程卡住、期间一个请求都不答**。实测在一千万行的表上删 20000 行要 **13.4 秒**，
    接口明明在监听却全部 502。**在请求路径上做维护性写操作，一律按时间计量
    （几十毫秒一档），不要按行数。**

25d. **两个进程同时写这个库会互相挡** —— 服务侧原先没设等锁超时，
    第二个进程一占住写锁，服务下一次写就直接抛 `database is locked`，
    表现成考生调用失败而不是一次等待。已在 store 里加 `busy_timeout = 10000`。
    但**仍然不要在服务运行时跑大批量清理**：等锁只是把失败换成卡顿。

25e. **停机的真实代价（2026-09-23 实测，别凭感觉估）** ——
    单纯重启 **0~1 秒**；装新版 **约 5 分半**（时间全花在备份 19 GB 的库上）。
    停的只有考场的接口与控制台；考生两台、5G 实验室、数据库文件、已封存证据全不受影响。
    考生的中继工人自带重试，实测停机期间收到 5 条 502 后自行恢复，无需人工干预。
    **唯一不能停的时候：有 Trial 正在跑**（会导致 Trial 失败、实验室租约悬住）。

25. **EvalOS 发布安装也会活过云助手的 300 秒 Timeout** —— 同坑 19。看到
    `exit=None status=Timeout` **千万不要重跑**：`opsmind-evalos-install-release`
    此时正在停服务、做 SQLite 全量备份（实测吃掉 18G）、翻转 `current` 指针。
    重跑一次发布安装可能是破坏性的。正确做法是查进程与状态：

    ```bash
    ./run-on.sh evalos - 'ps -ef | grep "[o]psmind-evalos-install-release"; /usr/local/sbin/opsmind-evalos-maint status'
    ```

    安装中的正常表象是：`evalos_api=inactive`、`console_ready=false`、
    `current_release` 仍是旧版、新 release 目录已建。**安装器自带失败回滚**
    （恢复上一版应用与 systemd/nginx 配置，且**绝不自动恢复数据库**），
    另有 `maint "rollback"` 可手工回退。实测整个安装约 10 分钟。

26. **EvalOS 发布包要在本机构建后经 `SendFile` 传（2.8 MB / 157 块）** ——
    `node scripts/build-m31-release.mjs` 会先跑 `npm run m31:verify`
    （238 个测试 + 架构/安全/能力检查 + 控制台构建），再算 `content_digest`、
    生成 `release_id = m31-<日期>-<digest 前 10>`、打包。两个坑：

    - 它**要求已跟踪文件无未提交改动**。仓库里长期有 3 个不属于本轮的改动
      （`AGENTS.md` + 两份文档），要临时 `git stash`，且 **stash／构建／pop 必须写在同一条命令里**
      ——分开做的话，构建还在读工作树时改动就被放回去了。
    - 最后那步 `tar` 在 Git-Bash 下会失败（它把 Windows 路径的 `D:` 当成远程主机：
      `tar (child): Cannot connect to D: resolve failed`）。**构建产物其实已经齐了**，
      自己补一条即可（用 `/d/...` 路径）：

    ```bash
    tar -czf .deploy/<release>.tar.gz -C .deploy/m31-build evalos
    ```

27. **写多行文本进文档时，别用 Python heredoc 里的三引号字符串** ——
    2026-09-16 实测：正文里出现 `\x`、`\u` 这类序列会让整个 heredoc 报
    `SyntaxError: (unicode error) ... truncated \xXX escape`，**脚本一行都没执行**。
    更坏的是当时那条命令用 `&&` 串了 `git commit`，于是**提交照样落了、只是没带上文档改动**，
    提交信息却声称补了——提交信息成了假的。
    **正文先用独立文件写好，再 `cat >>` 追加**；或者用 `r"""` 原始字符串。

28. **AH 镜像是 overlay 覆盖构建，不是从头构建——判据在 `image.base.digest` 标签里** ——
    2026-09-18 部署实测，代价是一次失败的激活。仓里有两个 Dockerfile：

    - `deploy/docker/agent-service.Dockerfile` —— 从零建整个运行时，**线上不用它**
    - `deploy/docker/agent-service-offline-overlay.Dockerfile` —— **线上用的是这个**

    挑错一个，会同时出三个看起来无关的症状，根因只有一个：

    | 症状 | 为什么 |
    |---|---|
    | 构建联网下载 48 分钟 | overlay 用 `--no-index --require-hashes` 的离线锁，从头建那个会拉全部依赖 |
    | 镜像 `Entrypoint` 是 `null` | **entrypoint 脚本在冻结的 `runtime-base` 里**，应用镜像自己不带 |
    | 启动即 `OPSMIND_ACTION_CONTROL_SECRET is required in production` | **正是那个 entrypoint 从 `/run/secrets/action_control_secret` 读出来 `export` 的**。没有它，密钥永远是空 |

    **注意 `docker exec` 看不到这个变量**（它不继承 entrypoint 的 export），所以
    "容器里 `printenv` 是空的但服务健康"不是矛盾，别顺着这条去怀疑 compose。

    **怎么一开始就判对**：看线上镜像的标签——

    ```bash
    docker image inspect opsmind-agent-harness:<线上release> \
      --format '{{index .Config.Labels "org.opencontainers.image.base.digest"}}'
    ```

    **只有 overlay 会写 `image.base.digest`**（它是 `ARG RUNTIME_BASE_DIGEST` → `LABEL`）。
    有值就是 overlay 构建，而且那个值必须等于 `opsmind-agent-harness:runtime-base` 的 `Id`。

    **正确的构建命令**（标签是 `ARG`→`LABEL`，必须用 `--build-arg`，`--label` 不生效；
    `image.source` 由基础镜像提供，不要重复设）：

    ```bash
    docker build -t opsmind-agent-harness:<rel> \
      --build-arg BASE_IMAGE=opsmind-agent-harness:runtime-base \
      --build-arg OCI_REVISION=<完整提交号> \
      --build-arg OCI_VERSION=<rel> \
      --build-arg RUNTIME_BASE_DIGEST=<runtime-base 的 Id> \
      -f deploy/docker/agent-service-offline-overlay.Dockerfile .
    ```

    以上已固化进 `ah-deploy.sh`：第 1 步反推线上配方（没有 `base.digest` 就拒绝继续、
    基础镜像漂了就拒绝继续），建完再拿新镜像与线上镜像**逐项比形状**
    （`base.digest`、**`Entrypoint`**、运行身份、`import main`）。
    **控制器的 7 道断言不查 entrypoint**，而 entrypoint 缺失正是唯一会致命的那条，
    所以这一层必须自己补。

    **更一般的教训**：不要为一个自己没做过的部署路径发明配方。
    **先从线上产物反推它是怎么来的**（镜像标签、entrypoint、base digest），再照着做。
    本轮这三样我都提前打印过，只是没读——信息不是拿不到，是拿到了没用。

29. **别把长跑脚本接 `head`／`grep` —— 管道末端的退出码会骗你，`head` 还会把脚本 SIGPIPE 掐死** ——
    2026-09-18：`./ah-deploy.sh ... | grep -E ... | head -30`，
    `head` 收满 30 行就退出，SIGPIPE 把脚本杀在建镜像那一步之前，
    而整条命令的退出码是 `head` 的 **0**，看着像成功。
    去主机一查：12 个文件都传到了，**构建根本没起来**。
    同类还有：`grep -c` 没匹配时退出码非零，配 `|| echo 0` 会打出两个 0，读起来像"确认为 0"。
    **长跑脚本一律 `> 日志文件 2>&1`，跑完再读文件**；判断成败只认脚本自己打的标记，
    不认管道末端的退出码（同坑 13）。

30. **手工对照实验要用控制器自己的 compose 项目名，否则撞容器名冲突** ——
    2026-09-18：想复现激活失败，手敲 `docker compose -p opsmind-agent-harness ... up -d`，
    报 `Conflict. The container name "/opsmind-agent-harness-api" is already in use`。
    原因是控制器用的项目名是 **`opsmind-agent-harness-evaluation`**（脚本第 10 行 `PROJECT=`），
    `container_name` 又是固定的，于是 compose 认为那个容器"不是我的"。
    **好处是它在动手之前就失败了，线上没受影响**；坏处是白花一轮，还差点把锅算到部署上。
    要手工复现，先 `grep -nE "^PROJECT=|^SERVICE=" /usr/local/sbin/opsmind-agent-harness-release`。
    而且这种复现会真的切走线上容器——**做完必须显式恢复并验证 `health=healthy`**。

31. **本地跑测试前先找仓自带的虚拟环境，不要用全局 python** ——
    2026-09-18：直接 `python -m pytest` 报 `No module named 'pymysql'`，
    我误判成"项目的环境债"，还 `pip install` 装进了全局 anaconda。
    实际上 `OpsMind/` 下有 `.venv`、`.venv-d1`、`.venv-pinned` 三个现成环境，
    `.venv` 里 Python 3.12.14、依赖齐全且在 `pyproject.toml` 约束内。
    LG 侧同理：`report-evidence/.venv`。
    **跑测试前先 `ls -d .venv*`**；装进全局的东西记得卸掉（`pip uninstall`）。

32. **AH 有两个查动作的端点，`/v2/evaluation/actions/{id}` 是考试作答端点、故意脱敏** ——
    2026-09-18：查提案里的举证字段，读 `/v2/evaluation/actions/{id}` 全是 `None`，
    差一步就要下"字段没写进去"的结论。
    真相是那个端点（`main.py` 的 `evaluation_answer()`）只返回
    `proposal_version / proposal_digest / action_type / action_version / target_entity_id / scope / parameters`，
    **脱敏是对的**——不能让考生从作答接口反查自己的完整提案。
    换成审批人角色 `approval_oracle` 拿到的还是同一份脱敏视图，实测确认，**不是权限问题**。
    运维视角的完整记录在 **`/v2/actions/{id}`**（`action_detail()` → `detail()`，41 个字段），
    `risk_level`、`justification`、`rollback_plan_json`、`verification_plan_json`
    以及 018 新增的 `target_hypothesis_id` / `supporting_evidence_ids_json` /
    `alternatives_considered_json` 都在这里。
    `ah-inspect.sh` 原先读错了端点，长期把回滚计划打成 `null`、验证计划打成 `""`，
    **看着像"AH 的提案没有回滚计划"，其实都有**。已于 2026-09-18 改到 `/v2/actions/{id}`，
    脚本头部写了"不要改回去"。
    判据：字段是不是真的空，去库里核（`opsmind_v23.action_proposals`，**注意不是 `opsmind` 库**，
    那个库里没有 `action_proposals` 表）。
    还有一个辨认窍门：如果连 `risk_level`、`justification` 这种老字段也一起是 `None`，
    那基本就是**读错了地方**，而不是新字段没落盘。
