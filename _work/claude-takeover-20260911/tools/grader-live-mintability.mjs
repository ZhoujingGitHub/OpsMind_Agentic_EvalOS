#!/usr/bin/env node
// 只读探针：80 道现场观测题里，有几道的必需证据活实验室真的发得出来？
//
// 这个问题决定「能不能先把题库修好再跑」。静态题面写的是人手编的标签，
// 活实验室只会发三种形态的事实；两者对不上的那部分，考生再强也拿不到。
//
// 判据不是猜的，来自三处代码：
//   process:<资源>-healthy       product-evidence-semantics.mjs 的 service_health
//                                （资源必须是 scope 里 resource_type=service 的那几个）
//   pcap:<协议>-observed          harness_diagnostics.py 里写死的白名单 sctp/ngap/pfcp/gtp
//   policy:<协议>:<端口>:drop-rule-present   network_policy 只读诊断
//
// 用法（EvalOS 仓根目录）： node _work/claude-takeover-20260911/tools/grader-live-mintability.mjs

import { M3_OBSERVATION_CASES } from "../../../packages/kernel/src/m3-observation-cases.mjs";

const SERVICE_IDS = new Set(["amf", "smf", "upf", "nrf", "mongodb", "dns"]);
const CAPTURE_PROTOCOLS = new Set(["sctp", "ngap", "pfcp", "gtp"]);
// opsmind_harness_labctl.py:90 RUNTIME_TARGETS —— 这几个守护进程停了的时候，
// 实验室会在 observe 的 evidence_refs 里直接回一条 process:<守护进程>-inactive。
// 这条通道不走 product-evidence-semantics，第一版探针把它漏了。
const INACTIVE_DAEMONS = new Set(["ueransim-gnb", "ueransim-ue", "open5gs-amfd",
  "open5gs-smfd", "open5gs-upfd", "open5gs-nrfd", "mongod"]);

function mintable(ref) {
  let match = /^process:([a-z0-9_.-]+)-healthy$/.exec(ref);
  if (match) return SERVICE_IDS.has(match[1]);
  match = /^process:([a-z0-9_.-]+)-inactive$/.exec(ref);
  if (match) return INACTIVE_DAEMONS.has(match[1]);
  match = /^pcap:([a-z][a-z0-9_]*)-observed$/.exec(ref);
  if (match) return CAPTURE_PROTOCOLS.has(match[1]);
  return /^policy:(?:sctp|udp|tcp):[0-9]{1,5}:drop-rule-present$/.test(ref);
}

const rows = Object.values(M3_OBSERVATION_CASES).map((item) => {
  const required = item.ground_truth.required_evidence ?? [];
  const live = required.filter(mintable);
  const minRecall = Math.min(1, 2 / Math.max(1, required.length));
  const best = required.length ? live.length / required.length : 1;
  const causeLive = (item.ground_truth.root_cause_fact_refs ?? []).every(mintable);
  return { id: item.id, scenario: item.environment.scenario_id,
    profile: item.environment.observation_profile,
    required, live, minRecall, best, causeLive,
    verdict: !causeLive ? "根因事实发不出来" : best < minRecall ? "证据召回够不着"
      : best === 1 ? "有富余" : "零余量" };
});

const byVerdict = {};
for (const row of rows) (byVerdict[row.verdict] ??= []).push(row);

console.log("现场观测题总数:", rows.length);
console.log();
console.log("=== 每道题在活实验室里能不能答得出来 ===");
for (const verdict of ["有富余", "零余量", "证据召回够不着", "根因事实发不出来"]) {
  const group = byVerdict[verdict] ?? [];
  console.log(`  ${verdict.padEnd(18)} ${String(group.length).padStart(3)} 道`);
}
console.log();

console.log("=== 按故障看（每个故障 4 道，四种考法各一）===");
const byScenario = {};
for (const row of rows) (byScenario[row.scenario] ??= []).push(row);
for (const [scenario, group] of Object.entries(byScenario).sort()) {
  const row = group[0];
  console.log(`  ${row.verdict.padEnd(18)} | ${scenario.padEnd(24)}`
    + ` | 活实验室能发 ${row.live.length}/${row.required.length}`
    + ` | 最低召回线 ${row.minRecall.toFixed(3)}`
    + ` | 根因事实${row.causeLive ? "发得出" : "**发不出**"}`);
}
console.log();

console.log("=== 发不出来的那些必需证据，缺在哪 ===");
const missing = new Map();
for (const row of rows) {
  for (const ref of row.required) {
    if (mintable(ref)) continue;
    missing.set(ref, (missing.get(ref) ?? 0) + 1);
  }
}
console.log(`  共 ${missing.size} 种，出现在 ${[...missing.values()].reduce((a, b) => a + b, 0)} 处：`);
for (const [ref, count] of [...missing.entries()].sort((a, b) => b[1] - a[1])) {
  const hint = /^process:.*(-inactive|-healthy)$/.test(ref) ? "名字不是 scope 里的单个网元/守护进程标识"
      : `${ref.split(":", 1)[0]}: 这一类实验室根本没有对应的只读诊断`;
  console.log(`    ${String(count).padStart(2)} 处  ${ref.padEnd(40)} ${hint}`);
}
console.log();

const runnable = (byVerdict["有富余"] ?? []).length + (byVerdict["零余量"] ?? []).length;
console.log(`>>> 现在就能在活实验室跑、且答得出来的: ${runnable}/${rows.length} 道`);
console.log(`>>> 其中有富余的只有 ${(byVerdict["有富余"] ?? []).length} 道`);
