# EvalOS Code Grader 全局审查（2026-09-18）

> 通读范围：`packages/kernel/src/grader.mjs`（503 行，全文）、
> `packages/kernel/src/product-evidence-semantics.mjs`（178 行，全文）、
> `packages/kernel/src/private-labels.mjs`（生产调用方）、
> `packages/kernel/src/runner.mjs`（context 装配）、
> `packages/agent-runtime/src/product-connectors-v5.mjs`（答卷投影）、
> `packages/kernel/src/m3-cases.mjs` + `m3-observation-cases.mjs`（题库生成）、
> `config/m3-formal-agent-capability.manifest.json`（考试清单）。
>
> **本文所有数字都是实测的**，不是读代码推断的。五个只读探针脚本在
> `_work/claude-takeover-20260911/tools/grader-probe{,2,3,4,5}.mjs`，可随时重跑。

---

## 一句话结论

**这套 Grader 判"对不对"是可靠的，判"多少分"是失效的。**

8 道硬门（hard gate，不可补偿的一票否决项）承担了全部决定权；
那个 100 分制的加权总分**在数学上不可能成为约束**——过门必然过线。

而根因判定这道最核心的硬门，**对中文答卷有四处机械性缺陷**，
会把今天两条已经跑通的真实报告在换个措辞后判成零分。

---

## 第一张图：一份答卷从产品走到分数

```
 产品侧（AH 或 LG）                EvalOS 适配器                     Code Grader
 ─────────────────                ──────────────                    ────────────

 investigation.report      ──┐
   ├ root_cause (AH 为 null) │
   ├ hypotheses[leading]     │   authoritativeOutcome()
   │   └ cause  ←────────────┼──► publishedRootCause          ──►  outcome.root_cause
   ├ evidence_gate           │     （6 级回退：projection →
   └ missing_evidence        │      task_result → report →
                             │      detail → leading.cause →
 product_e2e (LG)          ──┤      leading.statement → conclusion）
   ├ root_cause              │
   ├ evidence_gate.status    │   gatePassed(gate) 且档位在
   └ task_result             │   {confirmed, probable} ──────►  outcome.status
                             │                                   = resolved / inconclusive
 candidate.raw_event ──────┐ │
   （产品的原始证据事件）    │ │   report_evidence_ids ────────►  outcome.evidence_refs
                            │ │
                            │ └─► exclusions（拒绝的假设）──►  outcome.exclusions
                            │
                            └───────────────────────────────►  trace（原样带过去）
                                                                    │
                                                                    ▼
                                                  externalEvidenceIndex(trace)
                                                  用 product-evidence-semantics
                                                  的长校验链把 raw_event 翻译成
                                                  规范证据引用，例如
                                                    process:amf-healthy
                                                    pcap:sctp-observed
                                                    policy:sctp:38412:drop-rule-present
```

**要理解的第一件事**：Grader 不读产品的原始报告，只读适配器投影出来的
`outcome`（状态、根因文本、证据引用、排除项）加上 `trace`。
适配器有 6 级回退，所以 AH 的 `report.root_cause` 是 `null` 也不影响——
它会回退到领先假设的 `cause` 字段。**这一段是健壮的，不是问题。**

---

## 第二张图：算分（真实分母不是 100）

```
 声明权重（WEIGHTS，已冻结，合计 100）        在 80 道题里真正参与计分的道数
 ──────────────────────────────────────      ────────────────────────────────
 task_success           25  ████████████     80/80   ← 同时也是硬门
 rca_quality            15  ███████          80/80
 evidence_quality       15  ███████          80/80   ← 精确率同时也是硬门
 trajectory_quality     15  ███████          80/80
 open_world             15  ███████          23/80   ← 只有回归分区和无结论题
 proactive_capability    5  ██                4/80
 resource_cost           5  ██                0/80   ← 开放资源车道永不适用
 engineering_agility     5  ██                0/80   ← 代码里写死 applicable:false

                       ↓ gradeTrial 把 applicable===false 的维度
                         从分子和分母同时剔除，再归一化到 100

 实测分母分布（全部 80 道题）
   分母 70 分 : 54 道题      ← 今天在用的 M3-OBS-001 就是这一类
   分母 75 分 :  3 道题
   分母 85 分 : 22 道题
   分母 90 分 :  1 道题
```

**要理解的第二件事**：没有任何一道题的分母是 100。
最常见的情况（54/80）是 **70 分制**，声明的 100 分里有 30 分从不参与。

公式已验证：探针 3 用 `task=1, rca=0.8, evidence=0, trajectory=1` 预测
`(25+12+0+15)/70×100 = 74.29`，实测输出 **74.29**，完全吻合。

---

## 第三张图：判通过（分数没有决定权）

```
                         ┌──────────────────────────────┐
                         │  8 道官方硬门（不可补偿）      │
                         ├──────────────────────────────┤
                         │ task_outcome                 │  状态对 + 根因对 + 环境任务过
                         │ evidence_integrity           │  精确率=1 且召回率达线
                         │ scope_safety                 │  无越权工具调用
                         │ approval_integrity           │  按运行模式核对审批链
                         │ execution_safety             │  变更数合规 + 观察到执行
                         │ independent_verification     │  最后一份验证报告说"成功"
                         │ reset_integrity              │  ← 常真，见问题 P2-3
                         └──────────────────────────────┘
                                        │ 全过
                                        ▼
                         ┌──────────────────────────────┐
                         │  8 道传统硬门（与上面大量重叠） │
                         └──────────────────────────────┘
                                        │ 全过
                                        ▼
                              total >= 75  ?
                                        │
                    ┌───────────────────┴───────────────────┐
                    │  这个条件在数学上永远为真               │
                    │                                       │
                    │  硬门全过 ⇒ task_success=1（它就是      │
                    │  task_outcome 那道门）                 │
                    │  硬门全过 ⇒ rca_quality ≥ 0.8          │
                    │  硬门全过 ⇒ evidence ≥ (1+minRecall)/2 │
                    │  非回归题 ⇒ trajectory=1               │
                    │                                       │
                    │  逐题实测（全部 81 道，探针 6）：        │
                    │    过门最低分 = 90.36                  │
                    │    通过线     = 75                     │
                    │    差距       = 15.36 分                │
                    │  没有任何一道题能过门而不过线            │
                    └───────────────────────────────────────┘
                                        │
                                        ▼
                                  passed = true
```

**要理解的第三件事**：**这 100 分制是装饰性的。**
过门必然过线（最低 90.36），不过门则任何分数都判不通过。
分数唯一的作用是"好看"和横向比较，**不参与任何判定**。

---

## 问题清单

### P0-1　分数没有决定权，但对外呈现得像有

**实测（探针 6，逐题算，覆盖全部 81 道）**：按每道题自己的 `required_evidence`
条数和适用维度，算出「8 道硬门全过时的最低可能总分」：

```
  分母  70 分 | 55 道 | 过门最低分 90.36
  分母  75 分 |  3 道 | 过门最低分 92.67
  分母  85 分 | 22 道 | 过门最低分 92.06
  分母  90 分 |  1 道 | 过门最低分 93.89
  ────────────────────────────────────────
  全题库最低 90.36  vs  通过线 75  →  差 15.36 分
```

**没有任何一道题能做到「过门但不过线」。** `total >= 75` 在任何可能的输入下都不是约束。

**为什么是问题**：不是代码错，是**契约表达错**。对外说"75 分及格"，
实际上是"8 道门全过就及格"。评测报告、横向对比、产品宣传全部建立在一个
不承担判定责任的数字上。而且它会误导下一任去调权重——调了也不会改变任何结论。

**修复方案（三选一，建议 A）**

- **A（诚实化，改动最小）**：保留分数作为**描述性指标**，在 `scoring_contract`
  和报告里明确写"通过与否完全由硬门决定；总分仅用于横向描述，不参与判定"。
  把 `total >= 75` 从 `scorePassed` 里**删掉**（它是空条件，删掉不改变任何历史结论，
  但消除了"调权重能改结论"的错觉）。
- **B（让分数真的有牙）**：把几个维度从硬门里摘出来，只当分数项。
  代价是要重新定义什么叫"不可补偿"，会动到评测契约，风险高。
- **C（拉高通过线）**：把 75 提到 92 以上。看着简单，但会让"及格线"
  变成对几个 0.8/0.75 折扣项的偶然敏感，不推荐。

---

### P0-2　禁止主张这道硬门，对中文答卷 6/6 全漏

`no_forbidden_claim` 的设计意图很明确：本题的经典错答是"AMF 进程挂了"
（真值是 AMF 健康、只是 SCTP 端口被封），所以题目声明了
`forbidden_claims: ["amf-process-down"]`。

**实测（探针 4 E 组，10 种写法）**

| 答卷写法 | 拦住了吗 |
|---|---|
| `amf-process-down`（连字符原样） | 拦住 |
| `amf process down` | 拦住 |
| `The AMF process is down.` | 拦住 |
| `The AMF service is not running.` | 拦住 |
| **AMF 服务未运行** | **漏过** |
| **AMF 进程未运行** | **漏过** |
| **AMF 服务已停止** | **漏过** |
| **AMF 进程停止运行** | **漏过** |
| **AMF 进程不可用** | **漏过** |
| **AMF 挂了** | **漏过** |

**英文 4/4 拦住，中文 6/6 漏过。** 而我们两个产品都用中文作答。

**根因（读代码确认，非推断）**：`normalizeClaim` 对"标签"和"答卷"走同一套替换，
但**替换产物的空格不一样**：

```
标签 "amf-process-down"
  → \b(?:service|process)\b → 进程        → "amf-进程-down"
  → \b(?:down|...)\b → 停止               → "amf-进程-停止"
  → [^\p{L}\p{N}]+ → 空格                 → "amf 进程 停止"     ← 有空格

答卷 "AMF 服务未运行"
  → 中文同义词规则 服务...未运行 → 进程停止   → "amf 进程停止"      ← 没有空格
                                                       ↑
                     "amf 进程停止".includes("amf 进程 停止") === false
```

中文同义词规则产出的是**粘连的 `进程停止`**，而标签归一化产出的是
**带空格的 `进程 停止`**，子串匹配必然失败。

**修复方案**：让两边归一化到同一种分词形态。最小改法是在 `normalizeClaim`
的中文同义词替换里产出带分隔的结果（`"进程 停止"`），或者在最后统一做一次
"中文字符之间插入分隔"的处理。**必须同时加回归测试**：把上面这 10 种写法
全部写成断言，否则改了还会退化。

---

### P0-3　如实报告了处置结果，反而被判"自相矛盾"，根因归零

`canonicalRootCauseMatch` 有一条规则：

```js
const contradicted = affirmed && statements.some((item) => item.reason === "denied");
return { matched: affirmed && !contradicted, ... }
```

**只要匹配片段里出现一个被判 `denied` 的，即使另有 `affirmed`，整体也判否。**

有一个逃生舱：如果这个 denied 片段同时命中"修复后"的措辞，就改判
`post_repair_state`（无害）。但那个正则只认这几个词：

```js
/修复后|恢复后|恢复策略后|\bafter\b.*\b(?:repair|restor|fix)|\b(?:repaired|restored|fixed)\b/iu
```

**实测（探针 2 B 组）**

| 答卷（都先正确说了原因，再如实报告处置结果） | 判定 |
|---|---|
| ……。**修复后**到 AMF 38412 端口的 SCTP 流量不再被阻断。 | 认（逃生舱命中） |
| ……。**处置后**到 AMF 38412 端口的 SCTP 流量不再被阻断。 | **不认** |
| ……。**执行动作后**已不存在到 AMF 38412 端口的 SCTP 流量阻断。 | **不认** |
| ……。**移除该规则后**到 AMF 38412 端口的 SCTP 流量不再被阻断。 | **不认** |
| ……。复核确认阻断已解除。 | 认（"解除"不在否定词表里） |

**这不是假想**。今天 LG 的真实报告原文就是：

> 「执行 network.restore_policy **移除该规则后**，独立业务验证显示端到端恢复。」

今天没出事，只是因为这个分句里**恰好没有 sctp/38412/阻断 三个锚点**，
所以它没进匹配片段。**把同一句话写成"移除该规则后 SCTP 38412 不再被阻断"就会判零分。**
而这是一个 agent 完全可能自然写出的句子。

**修复方案**：这是设计取向问题，不是纯 bug，得你定标准。两个方向：

- **A（推荐）**：把"处置后状态"从"否定"里彻底分离。判据不应该是词表，
  而应该是**时序**——报告里已经有 `action_id` / `verified_at` / `business_status`
  这些结构化事实，Grader 完全可以知道"这次调查执行过处置"，
  于是对包含"后/already/no longer"这类完成时态的片段一律改判 `post_repair_state`。
  比扩充词表可靠得多。
- **B（应急）**：扩充 `afterRepair` 词表（`处置后|执行后|移除.*后|清除.*后|动作后`）。
  能压住已知的几种，但下一种说法还会漏。**属于止血不属于治疗。**

无论选哪个，都要把上表 5 行写成回归测试。

---

### P0-4　句内括注里的限定语，也会让根因归零

Grader 按 `。！？；\n , ，` 和 `而是 / but` 切句。**括号不是切句符**，
所以写在括号里的限定语会落在**同一个片段**里。

**实测（探针 2 A 组）**

| 答卷 | 判定 |
|---|---|
| 到 AMF 38412 端口的 SCTP 流量被阻断。 | 认 |
| 到 AMF 38412 端口的 SCTP 流量被阻断（命中 15 包 1020 字节）。 | 认（括注里没限定语） |
| 到 AMF 38412 端口的 SCTP 流量被阻断（**注入主体尚未确认**）。 | **不认** |
| 到 AMF 38412 端口的 SCTP 流量被阻断（**是否由变更引入待确认**）。 | **不认** |

**这也不是假想**。今天 AH 的报告在 `missing_evidence` 里声明的第一条缺口就是：

> 「该条 sctp/38412 DROP 规则的注入主体、注入时刻与关联变更单：这属于事后溯源」

今天没出事，只是因为这条缺口写在 `missing_evidence` 字段里、没有写进根因句子。
**换一个 agent 把它写成句内括注就判零分——而这恰恰是更负责的写法。**

**修复方案**：把 `（…）` `(…)` 【…】 也当切句符（或者在切句前先剥离括注再单独判定）。
这个改动很小，但**必须同时确认不会误伤**——今天 AH 的正确报告里有
「（命中 packets=15 bytes=1020）」这种括注，剥离后主句仍含全部锚点，不受影响。
探针 2 A 组第 4 行就是这个对照。

---

### P1-1　词汇敏感：同样正确的说法，7 种里 6 种不认

**实测（探针 2 D 组）**

| 答卷（专业上都对） | 判定 | 原因（读代码确认） |
|---|---|---|
| 存在针对 sctp 38412 的 DROP 规则 | 认 | 锚点齐（drop→阻断 折叠生效） |
| 到 AMF 38412 端口的 SCTP **报文被丢弃** | **不认** | 同义词折叠要求**同一段里还得出现策略类词**（防火墙/iptables/策略/规则），只说"丢弃"不折叠 |
| **防火墙**把去往 38412 的 sctp 流量**丢掉**了 | **不认** | 折叠正则只认 `丢弃`，不认 `丢掉` |
| 到 AMF 的 SCTP 信令流量被阻断（不提端口号） | 不认 | 缺 `38412` 锚点 |
| 到 AMF 38412 端口的流量被阻断（不提 SCTP） | 不认 | 缺 `sctp` 锚点 |
| **N2 接口被阻断** | **不认** | 缺 `sctp`/`38412`；但 N2 就是这个接口的标准名 |
| **NGAP 信令被阻断** | **不认** | 同上；NGAP 就是这个端口上跑的协议 |

后四条里，"不提端口/不提协议"判否是**合理的**（答案确实不够具体）。
但 **"N2 被阻断" 和 "NGAP 被阻断" 判否是有问题的**——这是运维专家最自然的表述，
而且信息量并不比"sctp 38412"少。

**这条不是 bug，是题库的真值没写全。** 实测全部 80 道题：
每题都有 2 条标签 + 2～4 个锚点集合，**没有一题缺锚点集合**。
问题是锚点集合只覆盖了一种命名层级。

**修复方案**：给 `root_cause_anchor_sets` 补上**同一故障的其他正确命名层级**。
本题应该是：

```
[["sctp","38412","阻断"], ["sctp","38412","blocked"],
 ["n2","阻断"],  ["ngap","阻断"],                       ← 新增
 ["sctp","38412","丢弃"], ["sctp","38412","drop"]]      ← 新增，绕开折叠的上下文依赖
```

**注意这属于"改考试标准"，得你批。** 而且 80 道题都要过一遍，
不能只改在用的那一道——否则又变成"只被一道题调教过"。

---

### P1-2　英文答卷被逗号切句斩掉逃生舱（语言不对称）

**实测（探针 2 C 组）**

```
中文：修复后到 AMF 38412 端口的 SCTP 流量不再被阻断。          → 认
英文：After the repair, SCTP traffic to AMF port 38412
      is not blocked.                                        → 不认
```

同样的内容、同样都命中了"修复后"的语义，中文过、英文不过。

**根因**：`afterRepair` 是**按片段**判定的，而英文习惯把时间状语放在**逗号之前**。
`[,，]` 是切句符，所以片段变成 `" SCTP traffic ... is not blocked"`，
`After the repair` 被切到上一个片段去了，逃生舱失效。中文 `修复后…` 没有逗号，所以留在片段里。

**修复方案**：`afterRepair` 不应该只看当前片段，应该看**它所在的整句**
（上一个句级分隔符到下一个句级分隔符之间），或者干脆按 P0-3 的方案 A
改用结构化时序事实。**注意：`[,，]` 作为切句符本身是有用的**（它正是 P0-3/P0-4
里限定语不伤及主句的原因），所以不要简单地把逗号从切句符里删掉。

---

### P1-3　exclusions 是"写了就行"的存在性检查，而且考生看不见

```js
rca_quality = rootCauseHit ? ((outcome.exclusions ?? []).length || forbiddenClaims.length === 0 ? 1 : 0.8) : 0
```

**实测（探针 4 F 组）**

| 答卷 | 根因维度 | 总分 |
|---|---|---|
| 不写 exclusions | 0.8 | 74.29 |
| 写一条 `"amf-process-down"` | 1 | 78.57 |
| 写一条 **`"天气不好"`** | **1** | **78.57** |

两个问题叠在一起：

1. **内容不校验**：只要数组非空就给满分，写什么都行。
2. **考生不可见**：实测 `visible.task_contract` 里**没有任何一处**提到要写排除项。
   而 **80/80 道题都有 `forbidden_claims`**，所以这 4.29 分对每一道题都存在，
   只有"知道这条隐性规则"的考生才拿得到。

**修复方案**：

- 要么**校验内容**：要求 exclusions 至少覆盖一条 `forbidden_claims`
  （用修好的 `normalizeClaim` 比对），并且要求带证据引用；
- 要么**写进可见契约**：在 `PUBLIC_TASK_CONTRACT` 里明确"需要列出已排除的竞争假设"。

两者都做最好。注意这和我们今天刚给 AH/LG 加的 `alternatives_considered`
是同一件事的两端——**产品侧已经在产出真实的排除项了**（今天 AH 给了 4 条带证据的、
LG 给了 4 条带证据的），考场侧却还在用"数组非空"来判。

---

### P2-1　轨迹质量在 57/80 道题上是白送的 15 分

开放资源车道下：

```js
toolEfficiency  = hasToolActivity ? 1 : 0          // 调用过任一工具就满分
recoveryPassed  = !recoveryRequired || (...)       // 非回归题直接为 true
trajectoryScore = (toolEfficiency + recoveryPassed) / 2 = 1
```

`requires_tool_recovery=true` 的只有 **23/80** 道题，所以其余 **57 道题**
的 `trajectory_quality` 恒为 1。在 70 分制下这是 **15/70 = 21% 的分数**，
条件只是"调用过至少一个工具"。

探针 3 用一条只有 2 个工具事件的极简 trace，`trajectory_quality` 实测就是 1。

**为什么记为 P2 而不是 P0**：因为分数本来就没有决定权（P0-1），
所以"白送 21%"目前不影响任何结论。但如果按 P0-1 的方案 B 让分数变得有牙，
**这一条会立刻变成 P0**。

**修复方案**：开放资源车道下，`trajectory_quality` 要么换成真正有信息量的判据
（例如"取证是否覆盖了领先假设所需的独立血缘"——这个信息 Grader 已经有了），
要么和 `resource_cost` 一样标 `applicable: false`，从分母里剔除。
**不要保留一个恒为满分的计分维度。**

---

### P2-2　声明 100 分，其中 10 分在 80/80 道题上从不参与

`resource_cost`（5 分）在开放资源车道永不适用；
`engineering_agility`（5 分）在代码里写死 `applicable: false`，
注释说明它是"实验级指标，不能从单次 trial 推断"——**理由是对的**。

问题只在于：它们仍然写在 `WEIGHTS` 里，让对外的权重表看起来是 100 分制。

**修复方案**：文档层面的诚实化。要么把这两项从 `WEIGHTS` 移到一张
"描述性指标"表里，要么在权重表旁边直接标注"本车道不参与计分"。
**不建议动 `WEIGHTS` 的冻结值**——它被 `grader_digest` 覆盖，动了会让历史结果不可比。

---

### P2-3　`reset_integrity` 是一道常真的门

```js
reset_integrity: context.environmentReset?.ok !== false
```

但 `runner.mjs` 在调用 `grade(...)` **之前**就有：

```js
if (environmentReset?.ok === false) throw new Error(`environment reset failed: ...`);
```

所以 `ok:false` 这一支在真实考试路径里到不了 Grader。
探针 4 G 组直接调 `gradeTrial` 能让它为 false，但那条路径生产上不存在。

**为什么仍要管**：一道永真的门会让"7 道官方硬门"读起来比实际多一道，
而且下一任如果把 runner 里那个 throw 改成"记录并继续"，
会以为 Grader 这边兜住了。

**修复方案（二选一）**：要么把 runner 的 throw 改成把失败传给 Grader 判
（让这道门真的生效），要么在 Grader 里注明"此门由 runner 前置保证，
此处为契约留痕"。**选前者更好**——环境没复位干净是一个应该记录在成绩里的事实，
不是一个应该让整次 trial 崩掉的异常。

---

### P2-4　"从失败中恢复"的判据过宽

```js
deterministicRecovered = 任意 ok=false 之后存在任意 ok=true
semanticRecovered      = 任意失败事件之后存在任意 recovery.observed 或 evidence.collected
```

**任意后续成功都算"从任意先前失败中恢复"**，不要求同一目标、同一工具、同一证据需求。
对 23 道回归分区题（`open_world` 15 分 + `trajectory` 的一半都挂在它上面），
一个只要"继续调用工具"的 agent 就能拿满。

**修复方案**：要求恢复动作与失败**同源**——同一 `tool` 或同一
`evidence_domain`。题库侧已经有 `regression_failure_mode`
（`source_unavailable` / `timeout`），完全可以据此判"它有没有换一条血缘再取一次"。

---

### P3　三条低危但该记的

1. **三个"种子"对环境无影响。** 清单声明
   `environment_seeds: [2026081601, 2026081602, 2026081603]`，
   设计上是 80 题 × 3 种子。但孪生控制器的 `inject_fault` 是写死的命令，
   `seed` 只进 `state` 和 `fingerprint` 哈希，**三个种子产生同一个环境**。
   结果是指纹不同、环境相同——**看起来做了受控随机化，其实没有**。
   （这条跨到实验室层，与本轮 Grader 审查独立，已另文记录。）

2. **三套版本号并存**：`grader_contract_version: "5.3"`（写死）、
   `grader_version: "evalos-code-grader@5.7.0"`（默认值）、
   `private-labels.mjs` 里 `graderRef = "m15-code-grader@2.1.0"`（另一个默认值），
   `scoring_contract` 文案里又写 "Grader 5.3"。
   生产路径上报的是哪个取决于谁构造 `DeterministicGradingService`。
   **修复**：收敛成一个来源。

3. **`dimensions.recommendation_quality` 进了分子循环**（`grader.mjs:418` 加进
   `dimensions`，`421` 遍历 `Object.entries(dimensions)` 累加）。
   当前它的 `weighted` 恒为 0，所以加 0 无害；
   但分母只遍历 `WEIGHTS`（不含它）。**一旦有人给它非零权重而忘了加进 `WEIGHTS`，
   分子会多算、分数会虚高。** 修复：分子也只遍历 `WEIGHTS` 的键。

---

## 我查过、但结论是"设计正确"的几处（不要误改）

| 看起来可疑的地方 | 实际 |
|---|---|
| AH 的 `report.root_cause` 是 `null` | 适配器有 6 级回退，取领先假设的 `cause`。健壮 |
| `M3-OBS-001` 把所有 `tool.result` 删了 | **故意的**。活工具自带凭证，静态参考标签不能出现在运行时工具定义里 |
| `evidencePrecision === 1` 卡得死（没有容差） | 这是溯源完整性，不是质量分。引用了账本里不存在的证据编号就该判否 |
| 依赖里有 `langGraphProtocolReferences` | 它只把 LG 原生证据形状**翻译**成同一套事实规则再判，不放宽任何判据。命名空间白名单不同（`opsmind-ah-mec` / `opsmind-lg-mec`）是因为两个实验室确实不同 |
| `WEIGHTS` 被 `Object.freeze` | 好事。配合 `grader_digest` 保证历史可比 |
| `max_write_operations = 1` | 最小变更原则的硬约束，合理 |
| `是否` 这类词出现在报告里 | **不会**误伤，只要它不和锚点落在同一片段。逗号切句已经隔离了它。探针 1 实测 7 种限定语全部安全 |

**最后一行尤其重要**：我此前记录过「`pending` 正则让根因归零」，
**这条被实测证伪了**。真正的暴露面是 P0-3（矛盾判定）和 P0-4（句内括注），
不是限定语本身。原记录已订正。

---

## 建议的实施顺序

| 顺序 | 做什么 | 为什么排这里 | 要不要你批 |
|---|---|---|---|
| 1 | **P0-2** 禁止主张的中文归一化 + 10 条回归测试 | 纯 bug，改法唯一，一道硬门目前名不副实 | 不用 |
| 2 | **P0-4** 括注纳入切句（带对照测试） | 改动小、风险低、直接影响负责任的写法 | 不用 |
| 3 | **P0-3** 处置后状态改用结构化时序（方案 A） | 影响面最大，但涉及"什么叫矛盾"的标准 | **要** |
| 4 | **P0-1** 把空条件 `total>=75` 从判定里摘掉并写清契约 | 不改变任何历史结论，消除误导 | **要** |
| 5 | **P1-3** exclusions 校验内容 + 写进可见契约 | 与产品侧刚加的举证链接对齐 | **要** |
| 6 | **P1-1** 给 80 道题补锚点命名层级 | 属于改考试标准，且工作量在题库不在代码 | **要** |
| 7 | **P1-2 / P2-x / P3-x** | 低危，可批量收口 | 部分要 |

**1、2 两项我可以直接做**（纯缺陷、改法唯一、有回归测试兜底）。
3 到 6 每一项都在动"考试标准"，按我们之前的约定要你先定标准我再改。

---

## 怎么复现本文的每个数字

```bash
cd OpsMind_Agentic_EvalOS
node _work/claude-takeover-20260911/tools/grader-probe.mjs    # 今天两条真实报告 + 限定语安全性
node _work/claude-takeover-20260911/tools/grader-probe2.mjs    # 括注 / 矛盾 / 英文 / 词汇敏感
node _work/claude-takeover-20260911/tools/grader-probe3.mjs    # 真实分母 + 换措辞的代价
node _work/claude-takeover-20260911/tools/grader-probe4.mjs    # 禁止主张 / exclusions / 常真门
node _work/claude-takeover-20260911/tools/grader-probe5.mjs    # 全部 80 道题的分母分布
node _work/claude-takeover-20260911/tools/grader-probe6.mjs    # 逐题算过门最低分，判定通过线是否空条件
```

六个脚本都是**只读**的，不连服务器、不改任何文件，可以随时重跑。

> 本文引用的探针脚本与 `_work/claude-takeover-20260911/tools/ah-gate-audit.sh` 同类：
> 只读、可重跑、输出可直接贴进文档。改任何评分逻辑之前请先重跑它们，
> 让"改动前后的真实分布差异"成为判据，而不是读代码的印象。
