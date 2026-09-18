// 只读探针：拿真实报告原文去跑真 Grader，量它到底认不认。
//
// 用法（在 EvalOS 仓根目录）：
//   node _work/claude-takeover-20260911/tools/grader-probe.mjs
//
// 为什么要有这个脚本：Grader 的根因匹配是词汇敏感的，而它只被一道题调教过。
// 光读代码判断不了"今天这份报告能不能过"，必须把真实原文喂进去跑。
// 本脚本不改任何东西，可以随时重跑。

import { canonicalRootCauseMatch, gradeObservableOutcome, gradeTrial } from "../../../packages/kernel/src/grader.mjs";
import { M3_OBSERVATION_CASES } from "../../../packages/kernel/src/m3-observation-cases.mjs";

const CASE = M3_OBSERVATION_CASES["M3-OBS-001"];

// 2026-09-18 两条生产链路的真实报告原文（从产品 API 取，未改一个字）。
// AH 的 report.root_cause 是 null，适配器回退到领先假设的 cause 字段，所以这里喂的就是它。
const AH_2026_09_18 = "实验环境主机内核 netfilter filter 表 INPUT 链转入的自定义链 OPSMIND_TWIN_IN 中被注入规则 -A OPSMIND_TWIN_IN -p sctp -m sctp --dport 38412 -j DROP（命中 packets=15 bytes=1020），丢弃了 gNB(127.0.0.1)→AMF(127.0.0.5:38412) 的 NGAP/N2 SCTP 建链报文，使 SCTP 关联停在 COOKIE_WAIT、N2 无法建立，UE 因此无法完成注册、无法建立 PDU 会话（无 10.45.0.x 用户面地址），到 MEC 10.47.0.80 的业务不可达。";

const LG_2026_09_18 = "受管 iptables 策略 OPSMIND_TWIN_IN 链存在 `-p sctp -m sctp --dport 38412 -j DROP`，丢弃 gNB 发往 AMF 的 SCTP/N2 握手报文，导致 SCTP 关联停留在 UNCONN/COOKIE_WAIT 而未进入 ESTAB，NGAP 初始 UE 消息无法送达 AMF，终端注册失败并阻断后续业务。执行 network.restore_policy 移除该规则后，独立业务验证显示端到端恢复。\n受管策略 DROP 规则阻断 N2 SCTP 端口 38412，导致控制面 SCTP 关联无法建立。该机制与 H1-control-plane-n2 相同，已并入 H1 作为根因行动目标。";

function report(title, text) {
  const match = canonicalRootCauseMatch(CASE, { root_cause: text });
  console.log("=".repeat(78));
  console.log(title);
  console.log("  matched =", match.matched, " reason =", match.reason);
  console.log("  切出来的断言片段（只列被判定为匹配到标签的）:");
  if (!match.statements.length) console.log("    （一个都没匹配上）");
  for (const item of match.statements) {
    console.log(`    [${item.reason}] ${item.statement.slice(0, 96)}`);
  }
  console.log();
  return match;
}

console.log("题目:", CASE.id, "  版本:", CASE.version);
console.log("真值标签:", JSON.stringify(CASE.ground_truth.root_causes, null, 0));
console.log("锚点集合:", JSON.stringify(CASE.ground_truth.root_cause_anchor_sets, null, 0));
console.log("要求证据:", JSON.stringify(CASE.ground_truth.required_evidence, null, 0));
console.log("禁止主张:", JSON.stringify(CASE.ground_truth.forbidden_claims, null, 0));
console.log();

report("① AH 2026-09-18 真实报告（领先假设 cause）", AH_2026_09_18);
report("② LG 2026-09-18 真实报告（root_cause）", LG_2026_09_18);

// 边界探测：同一份正确结论，只加一句常见的中文限定语，看会不会翻。
console.log("#".repeat(78));
console.log("边界探测：在正确结论后追加一句话，看判定会不会翻");
console.log("#".repeat(78));
console.log();

const BASE = "到 AMF 38412 端口的 SCTP 流量被阻断。";
const SUFFIXES = {
  "原句（对照）": "",
  "追加：注入主体是否为变更单尚待确认": "注入主体是否为变更单尚待确认。",
  "追加：该规则由谁注入尚未确认": "该规则由谁注入尚未确认。",
  "追加：修复后该规则已不存在": "修复后该规则已不存在。",
  "追加：移除该规则后业务恢复": "移除该规则后业务恢复。",
  "追加：执行处置后该阻断不再存在": "执行处置后该阻断不再存在。",
  "追加：并非 AMF 进程停止": "并非 AMF 进程停止。",
};
for (const [label, suffix] of Object.entries(SUFFIXES)) {
  const match = canonicalRootCauseMatch(CASE, { root_cause: BASE + suffix });
  const reasons = match.statements.map((item) => item.reason).join(",") || "无匹配片段";
  console.log(`  ${match.matched ? "认 " : "不认"} | ${label.padEnd(30)} | reason=${match.reason.padEnd(26)} | 片段=${reasons}`);
}
console.log();

// 同一份正确结论在"逗号切句"下的表现：中文报告习惯长句，切句规则直接决定暴露面。
console.log("#".repeat(78));
console.log("分句规则暴露面：Grader 按 。！？；\\n , ， 而是 but 切句");
console.log("#".repeat(78));
const SPLIT_PROBE = "到 AMF 38412 端口的 SCTP 流量被阻断，是否由变更单引入待确认。";
const m = canonicalRootCauseMatch(CASE, { root_cause: SPLIT_PROBE });
console.log("  原文:", SPLIT_PROBE);
console.log("  matched =", m.matched, " reason =", m.reason);
for (const item of m.statements) console.log(`    [${item.reason}] ${item.statement}`);
