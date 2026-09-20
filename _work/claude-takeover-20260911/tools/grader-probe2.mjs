// 只读探针 2：判定只看「指认了哪一行观测记录」，中文那一栏写什么都不算数。
//
// 2026-09-19 这个探针有 A/B/B2/C/D 五组，量的全是"读中文句子"那套判据在各种
// 写法下的表现。那套判据 09-20 上午整个删掉了，只剩一组。
// 09-20 晚又换了一次：考场不再要求考生写任何编号，改成让它从自己的观测里
// 摘字段、指认那处被改动的状态。这个探针跟着换成量新判据。
//
// 它要说明两件事：
//   ① 措辞不参与判定——同一条指认配七种中文（含写错、写反、留空）结果一样
//   ② 指认的精度参与判定——摘得太笼统对得上好几条记录，同样算没指准
//
// 用法（EvalOS 仓根目录）： node _work/claude-takeover-20260911/tools/grader-probe2.mjs

import { gradeRootCauseState } from "../../../packages/kernel/src/grader.mjs";
import { observationRows } from "../../../packages/kernel/src/fault-delta.mjs";
import { M3_OBSERVATION_CASES } from "../../../packages/kernel/src/m3-observation-cases.mjs";

const CASE = M3_OBSERVATION_CASES["M3-OBS-HID-008"];

// 噪声题的内核快照：真正的故障规则（计数在涨）+ 一条无害的干扰规则（计数为零）。
const SNAPSHOT = {
  evidence_id: "ev-policy",
  raw_value_json: { records: [{ resource_id: "amf", diagnostic_profile: "network_policy",
    tables: [{ table: "filter", chains: [{ name: "OPSMIND_TWIN_IN" }], rules: [
      { chain: "OPSMIND_TWIN_IN", position: 1, protocol: "sctp", destination_port: "38412",
        target: "DROP", has_negation: false, packets: 15, bytes: 1020 },
      { chain: "OPSMIND_TWIN_IN", position: 2, protocol: "udp", destination_port: "9999",
        target: "DROP", has_negation: false, packets: 0, bytes: 0 },
    ] }] }] },
};
const EVIDENCE = new Map([["ev-policy", { rows: observationRows(SNAPSHOT) }]]);

function claim(fields, state = "present") {
  return { evidence_id: "ev-policy", state, fields };
}

function grade(prose, claims) {
  return gradeRootCauseState(CASE, { root_cause: prose,
    recommendation_evaluation: { hypothesis_context: { leading_hypothesis_ids: ["H1"],
      hypotheses: [{ hypothesis_id: "H1", status: "leading", cause: prose,
        root_cause_state_claims: claims }] } } }, { externalEvidence: EVIDENCE });
}

const RIGHT = [claim({ chain: "OPSMIND_TWIN_IN", protocol: "sctp",
  destination_port: "38412", target: "DROP" })];

console.log("#".repeat(96));
console.log("同一条指认，配上七种完全不同的中文（含以前会判否的那几种写法）");
console.log("#".repeat(96));
for (const prose of [
  "到 AMF 38412 端口的 SCTP 流量被阻断。",
  "到 AMF 38412 端口的 SCTP 流量被阻断（注入主体尚未确认）。",
  "处置后到 AMF 38412 端口的 SCTP 流量不再被阻断。",
  "SCTP traffic to AMF port 38412 is blocked.",
  "N2 接口被阻断。",
  "AMF 服务未运行。",
  "",
]) {
  const g = grade(prose, RIGHT);
  console.log(`  过门 ${g.gate_passed ? "✓" : "✗"} | ${g.verdict.padEnd(26)}`
    + ` | ${(prose || "（这一栏留空）").slice(0, 46)}`);
}
console.log();
console.log(">>> 中文那一栏写什么都不改变判定——包括写错、写反、或者根本不写。");
console.log();

console.log("#".repeat(96));
console.log("摘了几个字段，就决定指没指准（同一份快照里有两条 DROP 规则）");
console.log("#".repeat(96));
const LADDER = {
  "只说「有条 DROP 规则」": [claim({ target: "DROP" })],
  "只说「是 udp 的」": [claim({ protocol: "udp" })],
  "说到协议和动作": [claim({ protocol: "sctp", target: "DROP" })],
  "说到协议、端口、动作": [claim({ protocol: "sctp", destination_port: "38412", target: "DROP" })],
  "连链名一起摘下来": RIGHT,
  "指了那条干扰规则": [claim({ protocol: "udp", destination_port: "9999", target: "DROP" })],
  "两条都指": [...RIGHT, claim({ protocol: "udp", destination_port: "9999", target: "DROP" })],
  "什么都不指": [],
};
for (const [label, claims] of Object.entries(LADDER)) {
  const g = grade("到 AMF 38412 端口的 SCTP 流量被阻断。", claims);
  const resolution = g.resolutions?.map((item) => `${item.verdict}(${item.match_count})`).join(" ") || "（无）";
  console.log(`  ${String(Number((g.score * 40).toFixed(2))).padStart(5)} / 40`
    + ` | 过门 ${g.gate_passed ? "✓" : "✗"} | ${g.verdict.padEnd(26)} | ${label.padEnd(26)} | ${resolution}`);
}
console.log();
console.log(">>> 「恰好命中一条」是核心：对得上好几条 = 没指准，对不上任何一条 = 指不明。");
console.log(">>> 两条都指算「部分命中」，拿一半分、不过门——多指一条不是谨慎，是没缩小范围。");
