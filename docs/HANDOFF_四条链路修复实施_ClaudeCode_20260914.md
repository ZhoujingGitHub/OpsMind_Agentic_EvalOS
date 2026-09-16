# 四条链路修复实施 HANDOFF（Claude Code 新会话）

> 生成时间：2026-09-14
> 性质：接续交接。**分析与方案已完成并获产品经理批准；代码改动尚未开始。**
> 前序会话完成了：四条链路真实验收、根因确证、修复总方案、磁盘治理（阶段0）、工具固化。

---

## 0. 三十秒上手

1. 读本文件
2. 读 `docs/implementation/四条链路修复总方案_20260914.md` ← **你要执行的方案**
3. 读 `_work/claude-takeover-20260911/tools/RUNBOOK_四条链路操作手册.md` ← **怎么驱动四条链路**
4. 读 `_work/claude-takeover-20260911/四条链路验收与问题分析_20260912.md` ← 结论的证据来源
5. 现场复核：三台 ECS 健康、实验室 idle、三个仓库工作区状态
6. 从**阶段 1（实验室层）**开始实施

---

## 1. 产品经理已批准的事项

原话："修复方案没问题"、"现在是开发阶段，必要情况可以breakchange，千万不要留技术债！"、"我需要四条链路尽快稳定跑通"。

**已获批：** 按总方案执行阶段 0–4；允许 break change；不保留兼容层。
**已明确要求：** 不留技术债；外围轻薄稳定。
**未改变的边界：** 不改评分权重、不删真实失败、不伪造根因/回滚/验证、不改写 Git 历史、不 force push、不删远端分支或标签。

---

## 2. 四条链路当前真实状态（2026-09-11 实测）

| 链路 | 结果 | 卡点 |
|---|---|---|
| ① AH → 5G | 未通过 | 业务 passed，但 Agent 自跑 `sleep 60` 撞 30 秒看门狗 fail-closed，报告根因空 |
| ② LG → 5G | 未通过 | 第二动作被 `policy.fault_no_longer_present` 阻止；root_cause 被压成 null |
| ③ AH → EvalOS → 5G | **通过 92.14 / 15门全过** | — |
| ④ LG → EvalOS → 5G | 未通过 39.29 / 12门 | expected_status、root_cause_or_justified_inconclusive、task_outcome |

**已确证的根因（非假设）：** 共享控制器全局装 `-s 10.45.0.0/16 ! -o ogstun -j MASQUERADE`；AH 拓扑脚本 prepare 时在 nat POSTROUTING 第1位插 ACCEPT 绕过，**LG 拓扑脚本只碰 filter 表、nat 表一条没有**。同轮三点抓包实证：UE `10.45.0.2` → 主机/MEC 侧变 `10.60.0.1`，31 包全出零回，MEC 无到 `10.60.0.1` 的路由。

**系统性病因：** LG 实验室适配层不在共享控制器的仓库 / 发布包 / 摘要清单 / 两代回退 / 测试覆盖内（AH 的在）。线上 `opsmind-langgraph-lab-topology` 时间戳停在 Aug 20。

**两个关键发现：**
1. `actions[-1]` 规则在同一轮内先假阳性（16:12 说恢复，实际 100% 丢包）后假阴性（16:22 说没恢复，实际 N2 修复有效）
2. **EvalOS 的 `environment_recovery` / `recovery` / `independent_verification` 三个硬门对 LG 全部放行**，而同一轮业务彻底不通。评分器 `grep business_verification` 为空——它从不读业务验证。AH 通过是因为业务**碰巧**真的好了，不是 EvalOS 查得更严。

---

## 3. 阶段 0（磁盘治理）—— 部分完成

**磁盘构成实测：**

| 项 | 占用 | 说明 |
|---|---|---|
| `/var/lib/opsmind-evalos/backups` | 36 GB | 两份未压缩全量备份（current + previous 各 18 GB） |
| `/var/lib/opsmind-evalos/control` | 19.8 GB | 活库 |
| `/opt/opsmind-evalos/releases` | 7.2 GB → **256 MB** | **已清理** |

**活库 19.8 GB 的构成：**

| 表 | 占用 | 行数 | 分类 |
|---|---|---|---|
| `candidate_relay_requests` | 16.72 GB | 124,963 | **受保护证据**（见下） |
| `candidate_relay_nonces` | 1.39 GB（含索引） | 7,198,833 | **受保护证据** |
| `ledger_entries` | 0.18 GB | **375,267** | 不可变审计账本 ← 用户曾误以为是案例库 |
| `trace_records` | 0.06 GB | 59,026 | Trial 轨迹 |
| `case_versions` | 0.01 GB | 359 个案例 | 案例库 |

**真正的评测数据（账本+轨迹+案例+Trial）合计仅约 0.25 GB。**

**已完成：** 删除 88 个陈旧发布包，磁盘 74% → 67%，空闲 25 GB → 32 GB。**构建部署阻塞已解除。**

**未完成且需产品经理决策：** relay 表被 `append-only` 触发器保护，不可删。详见第 9 节。

---

## 4. 准确版本与血缘

| 产品 | main = origin/main | 生产标签 | 线上候选 | 候选分支 |
|---|---|---|---|---|
| AH | `b13c5f54b94945d07f960a703a75b6a5d70eaa46` | `prod-agent-harness-20260907-evidence-delivery` → 同提交 | 同 main | — |
| LG | `f99d3775fb717435f9bfb5cd7b1f85bc389377f1` | `prod-langgraph-20260902-model-output-recovery` | `e34773bd0484b33bf0c101d70d1262fd67190447` | `codex/langgraph-feature-ah-tool-parity-20260908` |
| EvalOS | `006172e86b704f3740149372fd8756b62f5e718f` | `prod-evalos-20260907-evidence-grading` | `41d99bc40421e4ec4552a002b640487c342eafac` | `codex/evalos-feature-diagnosis-advice-grading-20260909` |
| 实验室控制器 | 源码在 EvalOS 仓库 | `prod-twin-20260907-network-evidence` → `8e859e82158479688f48efae0df04e353ffb5356` | release `twin-controller-20260907-13646b0db8` | — |

祖先关系已逐段 `merge-base --is-ancestor` 验证，全部成立。

### 正确工作目录

```
AH     : OpsMind
EvalOS : OpsMind_Agentic_EvalOS
LG     : OpsMind-LangGraph\runtime\codex-migration-20260903\candidates\report-evidence   ← 唯一正确
```

### ⚠ 必须避开的陷阱

`OpsMind-LangGraph` **顶层目录是一个废弃的独立 clone**（不是 worktree）：
- 它的 `main` = `origin/main` = `2b65a357`
- 对象库中**不存在** `f99d377` 和 `e34773b`
- 在其中执行 `git log` / `show` / `diff` 会**静默返回停在 9 月初的错误画面，不报错**

**处理（纯文件操作）：** 放置 `README_废弃_请勿使用.md` 说明正确路径。不删除、不重置、不动远端。

### 本次拟建分支

| 产品 | 中文名 | 分支 | 基线 |
|---|---|---|---|
| LG | 业务事实合同统一 | `codex/langgraph-feature-business-truth-contract-20260914` | `e34773b` |
| EvalOS | 业务事实接收与评分 | `codex/evalos-feature-business-truth-contract-20260914` | `41d99bc` |
| AH | 等待审批不再误判超时 | `codex/agent-harness-fix-approval-wait-watchdog-20260914` | `b13c5f5` |

实验室控制器改动走 EvalOS 分支（源码在该仓库），发布时用独立控制器版本号与标签线。

### 验收后收口四项
合入 `main` → 推 `origin/main` → 建不可变标签 `prod-<product>-202609XX-business-truth-contract` → 核对线上提交 = main 祖先 = 标签精确指向。

---

## 5. 要改的准确位置（阶段 1–4）

详见总方案。汇总如下：

**阶段 1 — 实验室层（EvalOS 仓库 `infra/twin/`）**
- LG 的 `opsmind_langgraph_labctl.py` + `opsmind-langgraph-lab-topology` 迁入，加进 `build-controller-release.py` 的 `RELEASE_FILES`
- LG 拓扑补 `iptables -t nat -I POSTROUTING 1 -s $UE_NET -d $SERVICE_NET -o lg-host-a -j ACCEPT`，teardown 对称删除
- `stack.manifest.json` 新增 `langgraph_network`；LG 侧删除两处硬编码，改为读 manifest + `ipaddress` 校验
- 补 UE 侧到服务网段路由
- `harness_probes.business_verification` 提升为公共 `business_verification(scope)`；新增 labctl 子命令 `business-verify`，两候选都能调
- LG 退役自己的 `deploy/protocol_lab/install-protocol-lab.sh`
- 扩 `test_harness_labctl.py` 覆盖 LG 适配层 + "业务健康独立于场景分"回归锁
- **不改** `recovery_view()` 的 `task_success` 定义与 `minimal_change`（AH 依赖，避免回归）

**阶段 2 — LG 层**
| 文件:行 | 动作 |
|---|---|
| `protocol_lab/actions.py:196` | 删 `health = "healthy" if task_success`，改调 `business-verify` 返回三态 |
| `actions/safety.py:744` | `verify()` 基于业务验证判定，修正误导文案 |
| `actions/safety.py:847` | `fault_still_present` 按当前提案目标的业务事实判定 |
| `actions/safety.py:~821` | `VerificationReport.evidence_ids` 改引用动作后新证据（现用执行前的） |
| `actions/delivery.py:44,51` | 删 `final = actions[-1]`，改任务级投影 |
| `graph/builder.py:2319-2320` | DIAGNOSIS_ONLY/DENY 回调查循环；仅安全停止类终止 |
| `graph/builder.py:2174,2194` | root_cause 支持 `confirmed_root_causes[]` + `open_issues[]` 并列 |

**阶段 3 — EvalOS 层**
| 文件:行 | 动作 |
|---|---|
| `packages/kernel/src/grader.mjs:366` | `environmentRecoveryPassed` 改读业务验证 |
| `grader.mjs:429,436` | `independent_verification` 硬门改校验报告内容（现仅看事件是否存在） |
| `packages/agent-runtime/src/langgraph-repair-delivery.mjs:12` | 删 `rows.at(-1)`，改接收 LG 任务级结论 + 完整历史，只校验不推断 |
| — | 新增 relay 保留策略 |

**阶段 4 — AH 层（P1）**
- 等审批不再依赖 Agent 自行 `Bash sleep`；由 Harness 提供等待原语，或对长阻塞工具放宽看门狗
- 动作 pending 时不冻结最终报告，或允许动作完成后补一次修订

---

## 6. 验收

顺序：**① AH→5G → ② LG→5G → ③ AH→EvalOS→5G → ④ LG→EvalOS→5G**，单一实验室独占串行，一轮一条，每轮封存证据 + 复位。

| 链路 | 通过标准 |
|---|---|
| ① | 业务 passed + Agent 运行正常完成 + 报告含根因 |
| ② | 业务 passed + 允许多动作 + 任务级结论与业务事实一致 |
| ③ | ≥ 92.14（不低于基线），15/15 硬门 |
| ④ | 15/15 硬门，分数达标 |

**必须覆盖的行为（测试下限）：**
1. 第一动作成功但业务未恢复 → 回调查，允许第二动作
2. 先失败后成功 + 业务验证通过 → 历史保留，任务"已恢复"
3. 最后提案未执行 → 不覆盖此前结果
4. 策略拒绝过时提案 → 回只读调查；安全停止仍终止
5. root_cause 能并列表达已确认与待确认
6. EvalOS 接收完整历史 + 唯一任务级结论
7. 多动作不因数量判失败
8. **AH 两条链路不回归**（阶段 3.1 改动后必须重跑）

**核心验证点（产品经理已认可）：** 加一轮**故意不修数据面的对照实验**，验证 `environment_recovery` 必须为 **false**。这是唯一能证明"评分体系有能力发现业务没好"的办法——否则只是让它再蒙对一次。

---

## 7. 风险

| 风险 | 应对 |
|---|---|
| 阶段 3.1 改动影响 AH 已通过的两条链路 | 必须重跑 AH 两条；不过则回滚该项 |
| 实验室控制器是共享组件 | 不改 `task_success` 定义，只新增公共探测入口与 LG 适配层 |
| VACUUM 需等量临时空间 | 执行前确认空闲 |
| 误删在途 relay 请求 | 只删 COMPLETED/FAILED/EXPIRED |

---

## 8. 材料入口

| 内容 | 路径 |
|---|---|
| **修复总方案** | `docs/implementation/四条链路修复总方案_20260914.md` |
| **操作手册 + 20 个脚本** | `_work/claude-takeover-20260911/tools/` |
| **验收与问题分析** | `_work/claude-takeover-20260911/四条链路验收与问题分析_20260912.md` |
| NAT 不对称决定性证据 | `_work/claude-takeover-20260911/DECISIVE-nat-asymmetry-live-proof.txt` |
| 链路②阻塞时刻捕获 | `_work/claude-takeover-20260911/chain2-lg-blocked-proposal-capture.json` |
| 四份封存包 | 见 RUNBOOK 第 4 节 |
| 总交接（历史） | `docs/HANDOFF_OpsMind三条端到端链路_开发期MVP修订版_20260831.md` |
| 全景交接（前序） | `docs/HANDOFF_智能运维Agent全景接管_ClaudeCode_20260911.md` |
| 工程规则 | 各仓库 `AGENTS.md` |

---

## 9. 阶段0 执行结果（2026-09-14）

### 已完成
- **删除 88 个陈旧发布包**，保留 current + previous + 1 个缓冲。
  `/opt/opsmind-evalos/releases`：91 个 / 7.2 GB → 3 个 / 256 MB
  **磁盘 74% → 67%，空闲 25 GB → 32 GB。已解除构建部署阻塞。**
  校验：current/previous 软链与 RELEASE.json 完好，服务 active，API 200。

### 重大发现：relay 记录是受保护的「证据」，不是日志垃圾

尝试清理 `candidate_relay_requests` 被**数据库触发器拒绝**：

```
Error: candidate relay records are append-only evidence   (SQLITE_CONSTRAINT_TRIGGER 1811)

CREATE TRIGGER candidate_relay_no_delete
BEFORE DELETE ON candidate_relay_requests
BEGIN SELECT RAISE(ABORT, 'candidate relay records are append-only evidence'); END
```

全库共 **29 张表**配有成对的 `no_update` / `no_delete` 触发器。
`candidate_relay_requests` 与 `ledger_entries`、`trace_records`、`grader_runs`、`artifacts`、`trial_results`
处于**同一保护等级**。EvalOS 设计上明确把 relay 记录归类为证据。

**因此前序会话未强行绕过，未删除任何一行。** 执行前后逐项核对完全一致：

```
ledger : valid, 375,267 条, head 550db25ecaad049f1e7a8a722e48b3537f3d46d6c15a2870c40e4db549301f0e
counts : 9 数据集 / 359 案例 / 131 实验 / 669 Trial / 55 已完成 / 10 分析 / 52 评测任务
DB     : 19,800,854,528 字节（未变）
```

服务在操作期间曾停止，已重启并验证健康。

### 待产品经理决策（不可由实施方单方决定）

`candidate_relay_requests` 占 16.72 GB / 124,963 行，**平均每行 140 KB**——因为它完整存储了
HTTP 请求体与响应体。这是磁盘的真正大头，但它被声明为证据。

三个方向，需要选择：

| 方案 | 省出 | 性质 | 风险 |
|---|---|---|---|
| **A. 只改写入路径**（推荐，符合"不留技术债"） | 未来不再增长 | 前向修复：不再存完整响应体，或超阈值只存摘要+哈希。**存量证据一行不动** | 低。需确认哪些字段是评分/审计真正需要的 |
| **B. 归档压缩** | 约 30 GB | 把两份 18 GB 未压缩备份按系统既有惯例转成 `.tar.zst`（`backup-archives` 里 8 月归档仅 284 MB）。**先验证可解压再删原件** | 低，但回滚步骤多一次解压（需 18 GB 临时空间） |
| **C. 修改 append-only 契约** | 约 18 GB | 加保留策略并放宽触发器 | **高。属于产品契约变更，改变 EvalOS 证据保全语义，需明确批准** |

**建议：A + B。** A 治本且不碰存量证据；B 是纯运维、遵循系统自有惯例。C 除非产品经理明确要求，否则不做。

> ### ✅ 产品经理已决定（2026-09-14）：**按 A + B 处理，不做 C。**
>
> **A（改写入路径，前向修复）**
> - 目标：relay 记录不再以每行 ~140 KB 的规模增长
> - 做法：超过阈值的 `request_body_json` / `response_body_json` 只存摘要 + SHA-256 + 原始长度，正文转存 artifacts 或直接不留
> - 阈值与字段取舍**必须先确认评分器与审计实际需要哪些字段**再定，不能拍脑袋砍
> - **存量证据一行不删、不改，append-only 触发器保持原样**
> - 需要同步更新相关测试，证明评分与审计不受影响
>
> **B（归档压缩，纯运维）**
> - 对象：`/var/lib/opsmind-evalos/backups/` 下两份未压缩全量备份（各 18 GB）
> - 惯例：遵循系统已有的 `backup-archives/*.tar.zst` + `*.files.sha256` 形式（8 月归档实测仅 284 MB）
> - **顺序不可颠倒：压缩 → 校验可解压 + 校验和比对 → 确认无误后才删原件**
> - 解压需约 18 GB 临时空间，执行前确认空闲（当前 32 GB）
> - 两代回滚能力必须保持：压缩后仍可恢复，只是多一步解压
>
> **明确不做：** 不放宽 append-only 触发器，不删除任何 relay 存量记录。

### 阶段0 剩余（新会话按上述决策执行）
- [ ] 按选定方案处理 relay 存量与写入路径
- [ ] 两份 18 GB 备份的归档压缩（若选 B）
- [ ] `/var/lib/opsmind-evalos/incoming` 211 MB、`backup-archives` 659 MB 视情况清理

### 硬性禁止（复述）
不删 `ledger_entries`；不删 trials / trace_records / case_versions / grader_runs / artifacts；
**不在拿到可用新备份前删旧备份**；不绕过 append-only 触发器除非产品经理明确批准。

