# LG Evidence Gate 发布链路：三处缺陷与修复方案

> 2026-09-16。来源是四条链路重新验收里 ②④ 的结论质量不合格
> （见 `四条链路重新验收_20260916.md`）。本文是**方案**，尚未实施。
>
> 结论先行：**问题不是"Gate 只有两把章、缺第三条路"——PROBABLE 档在契约和 Gate 里
> 都已经存在。真正的缺陷是三处具体的断点，各自都能指到行。②④ 也不是同一个原因。**

## 0. 先订正我此前两个说错的判断

| 我说过的 | 实际 | 依据 |
|---|---|---|
| "引擎自己算好了缺什么，`remaining_evidence_opportunities` 第一项正是 Gate 要的 `capture_protocol_summary`" | **说重了。** 那是**全部 32 个授权工具的字母序清单**，`capture_protocol_summary` 排第一只因为字母序。引擎并**没有**算"缺什么" | `builder.py:685` 的 docstring 明写 "without guessing that prior calls closed a gap"；实测 len=32 |
| "②④ 是同一个原因" | **错。** ② 的 Gate **没过**（`insufficient_evidence`）；④ 的 Gate **过了**（`passed:true`、`status:probable`、`report_evidence:published`），`root_cause` 仍然是 null。两个不同的断点 | ④ 封存件里 `evidence_gate_passed: true` |
| "Gate 能说不行、能说再复核，但说不出去补 X（所以缺第三条路）" | **方向对，落点错。** PROBABLE 档存在且 `passed=True`；缺的不是"发布概然结论"这条路，而是下面 D1/D2/D3 三个断点 | `evidence.py:222`、`execution.py:83` |

## 1. D1 · 独立验证器的证据从未进入证据索引，一条外来引用连坐整个假设（链路② 的原因）

**现象链条**（链路②，逐条复刻 Gate 的过滤器跑出来的）：

`h3-n2-policy-drop` 满足**除一项外的全部**实质要求——
`status=supported`、`conclusion_level=probable`、`causal_component`/`causal_mechanism`/`statement` 齐全、
`directly_verified=True`、来源数 3（需 ≥2）、无反证。它引用了 5 条证据，其中 4 条干净，第 5 条是：

```
protocol-lab:business-verification:832169f3d5eae410ea38
```

这条**是真的**——它是修复后那个独立只读验证器（`digital-twin-readonly-verifier`）出的业务复测证据。
但它在整份快照里只出现在三个地方：`repair_delivery.task_verification.evidence_ids`、
`repair_delivery.actions[0].verification.evidence_ids`、`verification_report.evidence_ids`。
**`evidence[]` 里没有它。**

于是 `governance/evidence.py:85-96` 那条防伪造过滤器命中：

```python
# A valid ID elsewhere cannot cover a missing, partial or foreign citation.
if (... or any(str(ref) not in substantive_by_id ... for ref in declared_support)):
    continue          # ← 整个假设被丢掉，不是只忽略那一条引用
```

`h1` 同样引用了它，同样被丢。→ `supported_hypotheses == []`
→ `root_cause_supported` 不过 → `base_supported` False → **PROBABLE 不可达** → `INSUFFICIENT_EVIDENCE`。

**根因不在 Gate，在于没人把验证证据并进索引。** `state["evidence"]` 是
`Annotated[list, operator.add]`（`state.py:49`），**唯一的写入者是 `normalize_evidence`**
（`builder.py:1147`），它只把 MCP 只读工具结果转成证据。`verify_effect`（`builder.py:1956`）
只写 `verification_report`，不往 `evidence` 追加。

### 修复 F1：把验证器的观测作为一等证据并入索引

在 `verify_effect` 的返回里追加一条 `Evidence`：

- `evidence_id` = **原样沿用验证器自己的 ID**（`Identifier` 正则 `^[A-Za-z0-9_.:-]+$`
  允许冒号，已核）——这样模型写的引用天然能解析，不需要任何 ID 映射层
- `evidence_type="action.verification"`、`source_system="protocol-lab.business-verification"`
- `tool_call_id=f"verify:{attempt_id}"`、`observed_at=verification.observed_at`
- `quality=verified`、`partial=False`、`freshness=live`、`coverage="complete"`
- `records` = 验证报告的实质载荷（`outcome`/`reason_codes`/`before_digest`/`after_digest`）
- `authority_refs` = `verification.evidence_ids`
- `summary` = `verification.public_summary`

**这一处修复不放宽任何一条 Gate 检查。** 防伪造过滤器原样保留——模型仍然不能引用它没采到的东西；
区别只是"验证器采到的东西"从此真的在索引里。这条边界很重要：
**不是为了跑通验收去松安全控制，而是把一份本来就存在的权威观测接进来。**

修完的预期效果（按现有 Gate 逻辑推演）：`supported_hypotheses = [h3, h1]`
→ `root_cause_supported` 过 → `confirmed_hypotheses` 仍为空（h3 的
`blocking_evidence_gaps` 非空、`conclusion_level` 是 probable）→ **PROBABLE，不是 CONFIRMED**。
**这正是诚实的档位**，没有把概然抬成确认。

## 2. D2 · Gate 批过的 probable 结论，在出口被丢掉（链路④ 的原因）

链路④ 的 Gate **过了**：`passed: true`、`status: "probable"`、`accepted_conclusion` 有值、
`report_evidence.status: "published"`、`recommendation_delivery.status: "published"`。
`H1-control-plane-n2` 是 `supported`/`probable`，3 条干净的 `ev-` 引用，没有 D1 那个问题。

然而 `builder.py:2268`：

```python
"root_cause": confirmed_conclusion or None,
```

`confirmed_conclusion` 来自 `_parallel_conclusions`（`evidence.py:279`），
只取 **CONFIRMED 档**假设的 statement。PROBABLE 档时它是 `None`。于是：

- `root_cause` → **None**
- `outcome` → 硬编码 `"safe_stop_without_confirmed_root_cause"`（`builder.py:2262`）
- 正文被塞进 `best_available_conclusion`——一个**字符串字段，不是根因字段**

**Gate 批准发布的概然根因，在产品的结构化出口上没有任何落点。**

### 修复 F2：给 probable 档一个明确的结构化落点

在 `finalize_and_learn` 的 `terminal_result` 里：

```python
gate_status = str(gate.get("status") or "")
probable = gate_passed and gate_status == "probable" and str(final_conclusion or "").strip()

"conclusion_level": "confirmed" if gate_confirmed else ("probable" if probable else "insufficient_evidence"),
"root_cause": confirmed_conclusion or (final_conclusion if probable else None),
"probable_root_causes": list(gate.get("accepted_hypothesis_ids") or ()) if probable else [],
"outcome": ("root_cause_confirmed" if gate_confirmed
            else "root_cause_probable" if probable
            else "safe_stop_without_confirmed_root_cause"),
```

**守住的两条线：**

1. `builder.py:2238` 那句注释的约束原样成立——只发布 **Gate 自己产出的**
   `gate["accepted_conclusion"]`，**绝不**去取模型的 `decision.conclusion`。
   Gate 之后不引入新根因这条规则不动。
2. **档位随结论一起走。** `conclusion_level` 显式写 `probable`，`open_issues` 继续并排发布。
   不是把概然说成确认，是把概然**说出来**。

## 3. D3 · EvalOS 适配器对 AH 和 LG 用了两套判定（④ 真正的扣分开关）

`packages/agent-runtime/src/product-connectors-v5.mjs:731-733`：

```js
const rootCauseConfirmed = gatePassed(gate) && (product === "agent-harness"
    ? ["confirmed", "probable"].includes(gateConclusion)      // AH：直接读 Gate 档位，probable 算命中
    : ["root_cause_confirmed", "resolved", "completed", "success"].includes(taskOutcome));  // LG：只读 outcome 字符串
```

链路④ 的完整扣分链条，**全部由 `terminal_result.outcome` 这一个值决定**：

```
outcome="safe_stop_without_confirmed_root_cause"
  → rootCauseConfirmed=false （尽管 gatePassed(gate)=true）
  → root_cause: null                      （:767）
  → taskResolved: false                   （:760）
  → status: "inconclusive"                （:762）
  → grader 三道硬门同时挂：expected_status / root_cause_or_justified_inconclusive / task_outcome
```

对应 `packages/kernel/src/grader.mjs:157/424/425/459`——本题 `expected_status` 是 `resolved`，
所以 `root_cause_or_justified_inconclusive` 要的是 `rootCauseHit`，`task_outcome` 要
`statusHit && rootCauseHit && environmentTaskPassed`。**三门都被同一个值掀掉。**

> ⚠️ **必须说清楚的事实：这条不对称在本次并没有偏袒 AH。**
> 链路③ AH 的 `effective_conclusion_status` 是 **`confirmed`**，不是 `probable`——
> AH 是过了更高的门，不是靠 probable 捡的分。所以 D3 是**潜在**不对称，
> 不是"考场本次放了 AH 一马"。别把这条讲成考场不公。

### 修复 F3：一条对称规则（**需要产品经理决策，我不擅自改**）

```js
const rootCauseConfirmed = gatePassed(gate) &&
  (["confirmed", "probable"].includes(gateConclusion) ||
   ["root_cause_confirmed", "root_cause_probable", "resolved", "completed", "success"].includes(taskOutcome));
```

**为什么这件事必须你定，不该我定：**

- 它**会改变链路④ 的分数**。F1+F2 只修 LG 自己扔掉结论的毛病，**单独做完并不会让 ④ 得分**
  ——因为 LG 分支读的还是 `outcome`，而 `"root_cause_probable"` 不在那个白名单里。
  **要 ④ 真的过，F3 是必需的。**
- 它等于确定一条**考试标准**：概然档的根因算不算"给出了根因"。
  - 支持：`rootCauseMatch` 仍然要逐字匹配真值机制，错的概然根因照样不过；
    而且本题真值就是 `resolved` + 特定机制，环境也确实恢复并被独立验证过。
  - 反对：这把认知门槛从"确认"降到"概然"。AH 是按"确认"过的，
    改标准等于让两个考生在不同认知档位上拿同一个结果。
- **一旦改，必须对称改、并重跑链路③ 证明 AH 不受影响**（推演上不受影响：AH 是 confirmed）。

我的建议：**先做 F1+F2+F4，不动 F3。** 理由见下。

## 4. 治本的那一条：让 LG 真的去补证据、够到 CONFIRMED（F4）

这是最该做的一条，而且**资源上完全可行**——链路② 的 `effective_budget` 六项全是
`null`（无上限），`budget_exhausted` 从未置位。**它停下来跟预算一点关系都没有，纯粹是 Gate 判的。**

实测路径（事件 80–86）证明**图能回头，而且真的回头了**：

```
81 investigation.reopened
83 revise_hypotheses      finalize              ← 模型说：发布
84 quality_gate           continue → adjudicate ← 引擎推翻，强制复核一次
85 adjudicate_hypotheses  finalize              ← 模型又说：发布
86 quality_gate           insufficient_evidence ← 引擎再次推翻，判停
```

`quality_gate`（`builder.py:1197`）里 `CONTINUE → reason_and_select_tools` 这条路**是通的**。
模型有权说 `continue`，它自己选了 `finalize`。而 Gate 不过时，
`builder.py` 最后那个 `else` 只有两个去处：`adjudicate`（复核，不采新证据）
或 `INSUFFICIENT_EVIDENCE`（出门）。**没有一条通向"去采那份缺的证据"。**

而 h3 自己已经把缺什么写得很清楚了（`blocking_evidence_gaps`）：

> 动作后未重新采集 SCTP 关联状态和 NGAP 帧，不能直接证明控制面握手已从 COOKIE_WAIT 变为 ESTAB。

### F4a（模型侧）：把缺口和剩余手段摆到 REVISE 那一轮面前

`AgentTurn`（`agent.py:72`）只带 `stage` / `objective` / `public_state` / `tools` / `knowledge`。
待确认 `compact_public_state` 有没有把 `blocking_evidence_gaps` 与
`evidence_gate.reasons` 带进 `public_state`；没有就补上，并在动作后那一轮明确给出
"这些缺口现在可采、预算无上限"。

### F4b（引擎侧兜底）：Gate 不过时增加一条"补证据"出口

在 `quality_gate` 里，当**同时**满足：

- Gate 不过，且不过的检查**只落在** `root_cause_supported` / `causal_confirmation`
- 存在非空 `blocking_evidence_gaps`
- 预算有余（`budget_reason is None and not budget_exhausted`）
- 本轮动作之后**还没有**为这些缺口发起过采集（用一个 `post_action_gap_fetch_count` 计数器守住，**只给一次**）

则 `decision = CONTINUE`、`gate_route = "decision"`（即走 `reason_and_select_tools`），
`gate_override_reason = "evidence_gate.gap_collection_allowed"`。

**这一条同样不放宽任何 Gate 标准**——判定门槛一个字不改，只是允许这次运行在停之前
把自己点名的缺口补掉。计数器防死循环；补完再判，过不过还是 Gate 说。

**F4 成功的话 ②④ 都能自然走到 CONFIRMED，D3 那个考试标准问题就不用碰了。**
这是我建议先做 F4 而不是先做 F3 的原因：**让考生够到门槛，而不是把门槛挪下来。**

## 5. 实施与验证顺序

| 步 | 内容 | 风险 | 验证 |
|---|---|---|---|
| 1 | **F1** 验证证据入索引 | 低。新增一条证据，不改任何判定 | 单测：带外来引用的假设不再被整条丢弃；Gate 从 `insufficient_evidence` 升到 `probable` |
| 2 | **F2** probable 档有落点 | 低。只发布 Gate 产出的结论，附带 `conclusion_level` | 单测：probable 时 `root_cause` 非空且 `conclusion_level=="probable"`；confirmed 行为不变 |
| 3 | **F4a+F4b** 补证据出口 | 中。会改变运行时长与成本；靠计数器防循环 | 单测：只触发一次；预算耗尽时不触发；只在两个指定检查失败时触发。之后**真跑链路②** |
| 4 | 重跑链路② → 若到 CONFIRMED，再跑链路④ | 中。占用单一物理租约，串行 | 看 `evidence_gate.status` 与 `terminal_result.conclusion_level` |
| 5 | **F3 暂不做**，等你拍板 | 高（改考试标准） | 若要做：对称改 + 重跑 ③ 证 AH 不受影响 |

## 6. 实施状态（2026-09-16 已落地 F1+F2+F4，未部署、未重跑链路）

LG 仓提交 `200af9a`，分支 `codex/langgraph-feature-business-truth-contract-20260914`。
`+292 / -4`，6 个文件。ruff 全过；全量 pytest 与基线**逐条一致**
（0 failed；47 个 error 是 Windows 下 `--basetemp` 清理的 `PermissionError`，
`ERROR at setup` 的 `tmp_path` fixture，干净检出一样报，与代码无关）。

| 项 | 落点 | 新增测试 |
|---|---|---|
| F1 | `builder.py` 新增 `_verification_evidence`，接到 `verify_effect` 返回的 `evidence` 键 | Gate 级 2 个 + builder 级 2 个（含重放幂等） |
| F2 | `builder.py` `terminal_result` 增 `conclusion_level` / `probable_root_causes`，`root_cause` 与 `outcome` 分档 | 改写 `test_failure_recovery` 的断言 + 图级 2 个 |
| F4b | `builder.py` `quality_gate` 新增 `gap_collection_allowed` 出口 + `_only_causal_gate_checks_failed` / `_blocking_evidence_gaps`；`state.py` 增 `gap_collection_grants` | 图级 2 个（授权生效 / 一次性防循环）+ helper 单测 2 个 |
| F4a | `deepseek.py` REVISE 提示词；`investigation_memory.py` 补 `gate_override_reason` 与 `gap_collection_grants` | 由 F4b 的图级测试间接覆盖 |

### 实施中发现的两件事，都推翻了本文原先的写法

1. **F4b 在链路② 不会被触发。** F1 之后 Gate 在 PROBABLE **通过**，
   于是走的是 `evidence_gate.publication_allowed` 分支，根本到不了那个判停的 `else`。
   **所以 F1+F2 把链路② 收在 `probable` + 非空 `root_cause`，而不是 `confirmed`。**
   F4b 是"Gate 真判不过时别只剩出门"这个独立缺陷的修复，不是链路② 的解药。
   要够到 CONFIRMED，靠的是 F4a 让模型自己选 `continue`——引擎不该去推翻一个
   Gate 已经批准的停止决定，那正是把原问题反向再犯一次。
2. **原文 F4a 写的"待确认 `compact_public_state` 有没有带 `blocking_evidence_gaps`"——
   它带了。** `hypotheses` 是完整 dict，`evidence_gate`（含 reasons）、
   `available_evidence_opportunities`、`budget_headroom` 也都在。
   **所以不是"模型没被告知缺口"，是它拿到了这些仍然选了 finalize。**
   真正缺的两样：REVISE 提示词里没有一句讲"能补的缺口就该补"
   （泛化指引反而说那些机会"是选项不是清单"），以及
   **`gate_override_reason` / `gap_collection_grants` 根本没进 `public_state`——
   引擎改判了模型却不告诉它，模型只会重复刚被否掉的那个决定。** 两样都已补。

### 还没做的

- **未部署**，线上镜像仍是旧版；**未重跑链路②④**（产品经理决定先看代码与单测）
- **F3 未做**，等决策。注意：F1+F2 让链路② 能发出 probable 根因，但
  **链路④ 的分数不会变**——EvalOS 的 LG 分支读 `outcome`，
  而 `root_cause_probable` 不在它的白名单里

## 7. 明确不做的事

- **不改评分权重**，不动 `grader.mjs` 的维度与分值
- **不放宽 Gate 的任何一条检查**——D1 的防伪造过滤器原样保留
- **不把 probable 报成 confirmed**，`conclusion_level` 必须随结论走
- **不删链路②④ 已封存的失败证据**，修完是新增样本，不是覆盖旧结论
