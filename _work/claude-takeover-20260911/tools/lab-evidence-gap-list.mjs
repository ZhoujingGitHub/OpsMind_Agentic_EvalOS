#!/usr/bin/env node
// 只读清单：考生答不出的那些证明，缺在哪一层？
//
// 这份清单是第四批（扩充实验室能开的证明种类）的工期输入。它回答一个问题：
// 每一种发不出来的证明，究竟是「实验室根本没采」，还是「采了但没透给考生」。
//
// 2026-09-20 实测结论（这一条推翻了之前的假设，别再按老说法估工期）：
//   37 种全部**已经**由底座孪生控制器 opsmind_twinctl.py 的 observed_evidence()
//   发出来，一种都不缺。缺的不是采集能力，是这些编号**发到考生侧了没有**——
//   考生走的是 opsmind_harness_labctl.py / opsmind_langgraph_labctl.py，
//   那两个控制器有自己的一套能力表，底座发的这 37 个编号一个都没透出去。
//
// 但「只差接线」这句话不能照字面执行，原因写在下面 B 组：
//   底座是**按本题是哪个故障**来决定发哪些编号的（observed_evidence 里
//   一连串 `if scenario == ...`，外面还套一层 SCENARIO_EVIDENCE[scenario] 过滤）。
//   直接把它接到考生侧，等于把答案发给考生。
//
// 用法（EvalOS 仓根目录）： node _work/claude-takeover-20260911/tools/lab-evidence-gap-list.mjs

import { readFileSync } from "node:fs";
import { M3_OBSERVATION_CASES } from "../../../packages/kernel/src/m3-observation-cases.mjs";
import { mintableEvidenceRef } from "../../../packages/kernel/src/live-evidence-mintability.mjs";

const TWIN = "infra/twin/opsmind_twinctl.py";
const CANDIDATE_SIDE = ["infra/twin/opsmind_harness_labctl.py",
  "infra/twin/opsmind_langgraph_labctl.py"];

// B 组：底座发这条编号时**没有读任何现场观测**，只看本题是哪个故障。
// 逐条从 observed_evidence() 读出来的，不是猜的。接线之前必须先改写成
// 「看到什么才发什么」，否则编号本身就是答案。
const SCENARIO_ONLY = new Map([
  ["state:allowed-nssai-mismatch", "if scenario == \"slice-mismatch\"，无任何观测条件"],
  ["error:amf-log-source-unavailable", "if scenario == \"observability-gap\"，无条件"],
  ["state:protocol-symptom-ambiguous", "if scenario == \"observability-gap\"，无条件"],
  ["metric:pcap-growth-high", "if scenario == \"pcap-capacity-risk\"，无条件"],
  ["state:disk-current-safe", "if scenario == \"pcap-capacity-risk\"，无条件"],
  ["forecast:disk-threshold-breach", "if scenario == \"pcap-capacity-risk\"，无条件"],
]);

const twin = readFileSync(TWIN, "utf8");
const candidate = CANDIDATE_SIDE.map((path) => readFileSync(path, "utf8")).join("\n");

const missing = new Map();
for (const item of Object.values(M3_OBSERVATION_CASES)) {
  const refs = [...(item.ground_truth.required_evidence ?? []),
    ...(item.ground_truth.root_cause_fact_refs ?? [])];
  for (const ref of refs) {
    if (mintableEvidenceRef(ref)) continue;
    const entry = missing.get(ref) ?? { ref, cases: new Set(), scenarios: new Set() };
    entry.cases.add(item.id);
    entry.scenarios.add(item.environment.scenario_id);
    missing.set(ref, entry);
  }
}

const rows = [...missing.values()].map((entry) => ({
  ...entry,
  inBase: twin.includes(entry.ref),
  onCandidateSide: candidate.includes(entry.ref),
  scenarioOnly: SCENARIO_ONLY.has(entry.ref),
})).sort((left, right) => left.ref.localeCompare(right.ref));

const bucket = (row) => !row.inBase ? "要加采集能力"
  : row.onCandidateSide ? "已经透给考生了（清单有误，去查）"
    : row.scenarioOnly ? "B 只差接线，但先要改写成按观测发" : "A 只差接线";

console.log(`发不出来的证明种类: ${rows.length}`);
console.log(`其中底座 ${TWIN} 已经会发的: ${rows.filter((row) => row.inBase).length}`);
console.log(`其中已经透到考生侧的: ${rows.filter((row) => row.onCandidateSide).length}`);
console.log();
console.log("=== 逐条清单 ===");
console.log(`  ${"证明种类".padEnd(36)} 影响题数  归类`);
for (const row of rows) {
  console.log(`  ${row.ref.padEnd(38)} ${String(row.cases.size).padStart(4)}    ${bucket(row)}`);
}
console.log();

const groups = {};
for (const row of rows) (groups[bucket(row)] ??= []).push(row);
console.log("=== 按归类汇总 ===");
for (const [name, group] of Object.entries(groups).sort()) {
  console.log(`  ${name.padEnd(30)} ${String(group.length).padStart(3)} 种，`
    + `影响 ${new Set(group.flatMap((row) => [...row.cases])).size} 道题`);
}
console.log();
console.log("=== B 组：为什么不能直接接线 ===");
for (const row of rows.filter((item) => item.scenarioOnly)) {
  console.log(`  ${row.ref.padEnd(38)} ${SCENARIO_ONLY.get(row.ref)}`);
}
console.log();
console.log("注：A 组那些也不是无脑接线——底座整体还套着 SCENARIO_EVIDENCE[scenario] 这层");
console.log("    按题号的过滤，只是 A 组每一条自己还额外读了现场（进程、防火墙、会话、");
console.log("    连通性、日志文本、抓包计数），改写成「按观测发」的成本明显低于 B 组。");

const wrong = rows.filter((row) => !row.inBase || row.onCandidateSide);
if (wrong.length) {
  console.log();
  console.log(">>> 与本清单的前提不符，需要重新核对：");
  for (const row of wrong) console.log(`    ${row.ref}`);
  process.exit(1);
}
