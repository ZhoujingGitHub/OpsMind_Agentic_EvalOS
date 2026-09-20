// 只读探针 2：同一件事的七种说法，判定结果只由「填的事实编号」决定。
//
// 2026-09-20 精简：这个探针原先有 A/B/B2/C/D 五组，量的全是"读中文句子"那套判据
// 在各种写法下的表现——括注、时态、同义词、中英文。那套判据已经整个删掉了，
// 那五组测的东西不再存在，所以一起删掉，只留 D2 组。
//
// D2 组要说明的事只有一句：换措辞不再改变判定，填对编号的满分，
// 只说到接口层的拿一半分但不过门。
//
// 用法（EvalOS 仓根目录）： node _work/claude-takeover-20260911/tools/grader-probe2.mjs

import { gradeRootCauseFacts } from "../../../packages/kernel/src/grader.mjs";
import { M3_OBSERVATION_CASES } from "../../../packages/kernel/src/m3-observation-cases.mjs";

const CASE = M3_OBSERVATION_CASES["M3-OBS-001"];
const RULE = "policy:sctp:38412:drop-rule-present";

// 左边是中文写法（存档给人读，不参与判定），右边是这份答卷提名的事实编号。
const ANSWERS = {
  "丢弃而非阻断": { prose: "到 AMF 38412 端口的 SCTP 报文被丢弃。", refs: [RULE] },
  "DROP 规则": { prose: "存在针对 sctp 38412 的 DROP 规则，导致 N2 建链失败。", refs: [RULE] },
  "防火墙丢包": { prose: "防火墙把去往 38412 的 sctp 流量丢掉了。", refs: [RULE] },
  "不提端口号（只说到接口层）": { prose: "到 AMF 的 SCTP 信令流量被阻断。", refs: ["n2"] },
  "不提 SCTP（只说到接口层）": { prose: "到 AMF 38412 端口的流量被阻断。", refs: ["n2"] },
  "只说 N2 被阻断": { prose: "N2 接口被阻断。", refs: ["n2"] },
  "说 NGAP 被阻断（N2 上跑的协议）": { prose: "NGAP 信令被阻断。", refs: ["n2"] },
};

console.log("#".repeat(96));
console.log("七种同样正确的说法 + 各自提名的事实编号");
console.log("#".repeat(96));
for (const [label, { prose, refs }] of Object.entries(ANSWERS)) {
  const grade = gradeRootCauseFacts(CASE, { root_cause: prose, root_cause_fact_refs: refs });
  const points = Number((grade.fact_score * 30 + grade.entity_score * 10).toFixed(2));
  console.log(`  ${String(points).padStart(5)} / 40 | 过门 ${grade.gate_passed ? "✓" : "✗"}`
    + ` | ${grade.verdict.padEnd(22)} | ${label}`);
}
console.log();

console.log("#".repeat(96));
console.log("同一条编号，配上七种完全不同的中文（含以前会判否的那几种写法）");
console.log("#".repeat(96));
const PROSE_ONLY = [
  "到 AMF 38412 端口的 SCTP 流量被阻断。",
  "到 AMF 38412 端口的 SCTP 流量被阻断（注入主体尚未确认）。",
  "处置后到 AMF 38412 端口的 SCTP 流量不再被阻断。",
  "SCTP traffic to AMF port 38412 is blocked.",
  "N2 接口被阻断。",
  "AMF 服务未运行。",
  "",
];
for (const prose of PROSE_ONLY) {
  const grade = gradeRootCauseFacts(CASE, { root_cause: prose, root_cause_fact_refs: [RULE] });
  console.log(`  过门 ${grade.gate_passed ? "✓" : "✗"} | ${grade.verdict.padEnd(22)}`
    + ` | ${(prose || "（这一栏留空）").slice(0, 48)}`);
}
console.log();
console.log(">>> 七种说法没有一个是零分；只说到接口层的拿一半分但不过门。");
console.log(">>> 中文那一栏写什么都不改变判定——包括写错、写反、或者根本不写。");

console.log();
console.log("#".repeat(96));
console.log("不填事实编号会怎样（删掉兜底之后的新规矩）");
console.log("#".repeat(96));
const notDeclared = gradeRootCauseFacts(CASE, { root_cause: PROSE_ONLY[0] });
console.log(`  过门 ${notDeclared.gate_passed ? "✓" : "✗"} | ${notDeclared.verdict}`);
console.log(`  理由：${notDeclared.note}`);
