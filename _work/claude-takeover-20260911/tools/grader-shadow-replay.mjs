#!/usr/bin/env node
// 影子模式离线回放：新老判据并行跑，只记录差异，不改任何东西。
//
// 回放四组语料，全部本地、只读、秒级：
//   A  30 次历史 AH 调查（2026-09-01 起，含 122 条假设）—— 老数据没有新字段
//   B  2026-09-18 两条真实链路的封存答卷 —— 同上
//   C  160 道题 × 3 个基线考生 —— 新答卷，两套判据都真的在判
//   D  对抗集：句子对但事实错、事实对但句子怪 —— 判据是否变松的决定性一组
//
// 语料 A/B 是从服务器只读取回的精简包，放在同目录 shadow-20260919/。
//
// 用法（EvalOS 仓根目录）： node _work/claude-takeover-20260911/tools/grader-shadow-replay.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalRootCauseMatch, gradeObservableOutcome, gradeRootCauseFacts }
  from "../../../packages/kernel/src/grader.mjs";
import { M3_CASES } from "../../../packages/kernel/src/m3-cases.mjs";
import { M3_OBSERVATION_CASES } from "../../../packages/kernel/src/m3-observation-cases.mjs";
import { buildBaselineSubmission } from "./grader-baseline-agents.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKS = path.join(HERE, "shadow-20260919");
const OBS = M3_OBSERVATION_CASES["M3-OBS-001"];
const RULE = "policy:sctp:38412:drop-rule-present";

function readPack(name) {
  return JSON.parse(readFileSync(path.join(PACKS, name), "utf8"));
}

function compare(caseSpec, outcome, trace = [], options = {}) {
  const text = canonicalRootCauseMatch(caseSpec, outcome, options).matched;
  const fact = gradeRootCauseFacts(caseSpec, outcome, options);
  const active = gradeObservableOutcome(caseSpec, outcome, trace, options).rootCauseHit;
  return { text, fact_verdict: fact.verdict, fact: fact.gate_passed, active,
    declared: fact.verdict !== "not_declared" && fact.applicable };
}

const summary = [];

// ---------------------------------------------------------------- A 历史调查
{
  const pack = readPack("history-30-pack.json");
  let hypotheses = 0, declared = 0, disagreements = 0;
  const rows = [];
  for (const run of pack.rows) {
    for (const hypothesis of run.hypotheses) {
      hypotheses += 1;
      if (hypothesis.root_cause_fact_refs) declared += 1;
      if (String(hypothesis.status ?? "").toLowerCase() !== "leading") continue;
      const outcome = { status: "resolved", root_cause: hypothesis.cause,
        evidence_refs: [], exclusions: [],
        recommendation_evaluation: { hypothesis_context: {
          leading_hypothesis_ids: [hypothesis.hypothesis_id], hypotheses: [hypothesis] } } };
      const result = compare(OBS, outcome, [], { remediationObserved: true });
      if (result.text !== result.active) disagreements += 1;
      rows.push({ id: run.investigation_id, ...result });
    }
  }
  console.log("#".repeat(96));
  console.log("A 组：30 次历史 AH 调查（" + pack.selection + "）");
  console.log("#".repeat(96));
  console.log(`  调查数 ${pack.rows.length}，假设数 ${hypotheses}，其中带 root_cause_fact_refs 的 ${declared}`);
  console.log(`  按 M3-OBS-001 的真值重判领先假设 ${rows.length} 条，老判据认 ${rows.filter((r) => r.text).length} 条`);
  console.log(`  >>> 新老判据分歧 ${disagreements} 条`);
  console.log("  （老数据一条都没有新字段，新判据必然退回文本判据，所以分歧只可能是 0；");
  console.log("    这一组量的是「换判据不会动历史结论」，不是「新判据更准」。）");
  summary.push(["A 历史 30 次调查", rows.length, disagreements]);
  console.log();
}

// ------------------------------------------------------------ B 封存真实答卷
{
  const pack = readPack("sealed-20260918-pack.json");
  const rows = [];
  const ahLeading = pack.ah.hypotheses.filter((item) => item.status === "leading");
  const lgLeading = pack.lg.hypotheses.filter((item) => item.status === "supported");
  for (const [product, leading, fallback] of [["AH", ahLeading, pack.ah.report_root_cause],
    ["LG", lgLeading, pack.lg.root_cause ?? pack.lg.conclusion]]) {
    for (const hypothesis of leading.length ? leading : [{ cause: fallback }]) {
      const outcome = { status: "resolved",
        root_cause: hypothesis.cause ?? hypothesis.statement ?? fallback,
        evidence_refs: [], exclusions: [],
        recommendation_evaluation: { hypothesis_context: {
          leading_hypothesis_ids: [hypothesis.hypothesis_id], hypotheses: [hypothesis] } } };
      rows.push({ product, id: hypothesis.hypothesis_id,
        ...compare(OBS, outcome, [], { remediationObserved: true }) });
    }
  }
  console.log("#".repeat(96));
  console.log("B 组：2026-09-18 两条真实链路的封存答卷");
  console.log("#".repeat(96));
  for (const row of rows) {
    console.log(`  ${row.product} ${String(row.id).padEnd(24)} 老判据=${String(row.text).padEnd(5)}`
      + ` 新判据=${String(row.fact).padEnd(5)}(${row.fact_verdict}) 实际生效=${row.active}`);
  }
  const disagreements = rows.filter((row) => row.text !== row.active).length;
  console.log(`  >>> 新老判据分歧 ${disagreements} 条；带 root_cause_fact_refs 的假设 `
    + `${rows.filter((row) => row.declared).length} 条`);
  summary.push(["B 封存真实答卷", rows.length, disagreements]);
  console.log();
}

// ------------------------------------------------------------ C 三个基线考生
{
  const cases = [...Object.values(M3_CASES), ...Object.values(M3_OBSERVATION_CASES)];
  const counters = { empty: [0, 0], reference: [0, 0], parrot: [0, 0] };
  const examples = [];
  for (const caseSpec of cases) {
    for (const kind of ["empty", "reference", "parrot"]) {
      const { outcome, trace, context } = buildBaselineSubmission(caseSpec, kind);
      const options = { remediationObserved: (context.environmentState?.remote?.changes ?? []).length > 0 };
      const textOnly = gradeObservableOutcome(caseSpec, outcome, trace,
        { ...options, rootCauseCriterion: "text" }).rootCauseHit;
      const factOnly = gradeObservableOutcome(caseSpec, outcome, trace, options).rootCauseHit;
      counters[kind][0] += 1;
      if (textOnly !== factOnly) {
        counters[kind][1] += 1;
        if (examples.length < 6) examples.push({ id: caseSpec.id, kind, textOnly, factOnly });
      }
    }
  }
  console.log("#".repeat(96));
  console.log("C 组：160 道题 × 3 个基线考生（新答卷，两套判据都真的在判）");
  console.log("#".repeat(96));
  for (const [kind, [total, differ]] of Object.entries(counters)) {
    console.log(`  ${kind.padEnd(10)} ${String(total).padStart(4)} 份 | 新老判据分歧 ${differ} 份`
      + ` (${((differ / total) * 100).toFixed(1)}%)`);
  }
  for (const item of examples) {
    console.log(`    例：${item.id.padEnd(16)} ${item.kind.padEnd(10)} 老=${item.textOnly} 新=${item.factOnly}`);
  }
  const total = Object.values(counters).reduce((sum, [n]) => sum + n, 0);
  const differ = Object.values(counters).reduce((sum, [, d]) => sum + d, 0);
  console.log(`  >>> 合计 ${total} 份，分歧 ${differ} 份`);
  summary.push(["C 基线考生", total, differ]);
  console.log();
}

// ----------------------------------------------------------------- D 对抗集
{
  const rows = [
    ["句子对、事实也对", "到 AMF 38412 端口的 SCTP 流量被阻断。", [RULE], "应该都过"],
    ["句子对、但事实提名错元件", "到 AMF 38412 端口的 SCTP 流量被阻断。",
      ["process:amf-healthy"], "老判据会放过，新判据必须拦"],
    ["句子对、但把编号全填一遍", "到 AMF 38412 端口的 SCTP 流量被阻断。",
      [...OBS.ground_truth.required_evidence], "老判据会放过，新判据必须拦"],
    ["句子对、但只说到接口层", "到 AMF 38412 端口的 SCTP 流量被阻断。", ["n2"],
      "老判据会放过，新判据必须拦（半分不过门）"],
    ["句子换了说法、事实对", "到 AMF 38412 端口的 SCTP 报文被丢弃。", [RULE],
      "老判据判否，新判据放过——这是本次要修的那个毛病"],
    ["句子只说 N2、事实对", "N2 接口被阻断。", [RULE],
      "同上：措辞不再决定判定"],
    ["句子彻底错、事实也错", "AMF 进程已停止。", ["process:open5gs-amfd-inactive"], "应该都拦"],
  ];
  console.log("#".repeat(96));
  console.log("D 组：对抗集 —— 新判据会不会比老判据更松");
  console.log("#".repeat(96));
  let looser = 0, stricter = 0;
  for (const [label, root_cause, refs, expectation] of rows) {
    const outcome = { status: "resolved", root_cause, root_cause_fact_refs: refs,
      evidence_refs: [], exclusions: [] };
    const result = compare(OBS, outcome, [], { remediationObserved: false });
    if (!result.text && result.fact) looser += 1;
    if (result.text && !result.fact) stricter += 1;
    console.log(`  老=${result.text ? "过" : "拦"} 新=${result.fact ? "过" : "拦"}`
      + ` | ${result.fact_verdict.padEnd(22)} | ${label}`);
    console.log(`        预期：${expectation}`);
  }
  console.log(`  >>> 新判据比老判据更严的 ${stricter} 条，更松的 ${looser} 条`);
  console.log("  （更松的每一条都必须能逐条说明为什么是改进，不能只看总数。）");
  summary.push(["D 对抗集", rows.length, `严 ${stricter} / 松 ${looser}`]);
  console.log();
}

console.log("#".repeat(96));
console.log("影子模式汇总");
console.log("#".repeat(96));
for (const [name, total, differ] of summary) {
  console.log(`  ${name.padEnd(20)} 样本 ${String(total).padStart(4)} | 差异 ${differ}`);
}
