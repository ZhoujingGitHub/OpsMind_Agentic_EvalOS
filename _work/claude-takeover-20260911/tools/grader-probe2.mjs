// 只读探针 2：定位根因匹配真正的暴露面。
//
// 探针 1 证伪了"限定语会让根因归零"——因为逗号切句把限定语隔离到了不含锚点的片段，
// 那种片段不会进 statements。所以真正的风险只可能在两处：
//   A 括号不是切句符 → 句内括注里的限定语会落在同一个片段
//   B contradicted 规则：只要匹配片段里出现一个 denied，即使另有 affirmed 也整体判否
// 本脚本逐条量，不做推断。
//
// 用法（EvalOS 仓根目录）： node _work/claude-takeover-20260911/tools/grader-probe2.mjs

import { canonicalRootCauseMatch, gradeRootCauseFacts } from "../../../packages/kernel/src/grader.mjs";
import { M3_OBSERVATION_CASES } from "../../../packages/kernel/src/m3-observation-cases.mjs";

const CASE = M3_OBSERVATION_CASES["M3-OBS-001"];

function probe(group, cases, options = {}) {
  console.log("#".repeat(96));
  console.log(group);
  console.log("#".repeat(96));
  for (const [label, text] of Object.entries(cases)) {
    const match = canonicalRootCauseMatch(CASE, { root_cause: text }, options);
    const frags = match.statements.map((item) => item.reason).join(",") || "无匹配片段";
    console.log(`  ${match.matched ? "认  " : "不认"} | ${label.padEnd(34)} | ${match.reason.padEnd(24)} | ${frags}`);
    if (!match.matched) {
      for (const item of match.statements) console.log(`         └─ [${item.reason}] ${item.statement.slice(0, 80)}`);
    }
  }
  console.log();
}

probe("A 组：括注落在同一片段内（括号不是切句符）", {
  "对照：纯结论": "到 AMF 38412 端口的 SCTP 流量被阻断。",
  "括注：尚未确认注入主体": "到 AMF 38412 端口的 SCTP 流量被阻断（注入主体尚未确认）。",
  "括注：是否由变更引入待确认": "到 AMF 38412 端口的 SCTP 流量被阻断（是否由变更引入待确认）。",
  "括注：命中计数（无限定语）": "到 AMF 38412 端口的 SCTP 流量被阻断（命中 15 包 1020 字节）。",
  "句内直接带是否": "到 AMF 38412 端口的 SCTP 流量是否被阻断尚未确认。",
});

probe("B 组：contradicted —— 正确报告了处置结果反而被判否？", {
  "对照：只说原因": "到 AMF 38412 端口的 SCTP 流量被阻断。",
  "原因 + 修复后不再阻断（用「修复后」）": "到 AMF 38412 端口的 SCTP 流量被阻断。修复后到 AMF 38412 端口的 SCTP 流量不再被阻断。",
  "原因 + 处置后不再阻断（用「处置后」）": "到 AMF 38412 端口的 SCTP 流量被阻断。处置后到 AMF 38412 端口的 SCTP 流量不再被阻断。",
  "原因 + 执行后已不存在该阻断": "到 AMF 38412 端口的 SCTP 流量被阻断。执行动作后已不存在到 AMF 38412 端口的 SCTP 流量阻断。",
  "原因 + 移除规则后不再阻断": "到 AMF 38412 端口的 SCTP 流量被阻断。移除该规则后到 AMF 38412 端口的 SCTP 流量不再被阻断。",
  "原因 + 复核确认阻断已解除": "到 AMF 38412 端口的 SCTP 流量被阻断。复核确认到 AMF 38412 端口的 SCTP 流量阻断已解除。",
  "原因 + restore 后（英文 restored）": "到 AMF 38412 端口的 SCTP 流量被阻断。SCTP traffic to AMF port 38412 is no longer blocked after the policy was restored.",
});

probe("C 组：英文答卷走不走同一条路", {
  "英文纯结论": "SCTP traffic to AMF port 38412 is blocked.",
  "英文 + 括注未确认": "SCTP traffic to AMF port 38412 is blocked (injection source unconfirmed).",
  "英文 + 修复后不再阻断": "SCTP traffic to AMF port 38412 is blocked. After the repair, SCTP traffic to AMF port 38412 is not blocked.",
  "英文 + 处置后不再阻断（无 repair 词）": "SCTP traffic to AMF port 38412 is blocked. Following the action, SCTP traffic to AMF port 38412 is no longer blocked.",
});

// 2026-09-19：「处置后…不再阻断」到底算不算自相矛盾，取决于这次运行**有没有真的动过环境**。
// 没动过还说"处置后已恢复"，那就是在说一次没发生的修复，判否是对的；
// 动过了，那句话就是如实汇报，必须放过。下面两组是同一批句子跑两遍。
probe("B2 组：同样这批句子，但本次运行确实执行过处置（remediationObserved=true）", {
  "原因 + 处置后不再阻断（用「处置后」）": "到 AMF 38412 端口的 SCTP 流量被阻断。处置后到 AMF 38412 端口的 SCTP 流量不再被阻断。",
  "原因 + 执行后已不存在该阻断": "到 AMF 38412 端口的 SCTP 流量被阻断。执行动作后已不存在到 AMF 38412 端口的 SCTP 流量阻断。",
  "原因 + 移除规则后不再阻断": "到 AMF 38412 端口的 SCTP 流量被阻断。移除该规则后到 AMF 38412 端口的 SCTP 流量不再被阻断。",
  "LG 今天报告的原话形态": "受管策略 DROP 规则阻断 N2 SCTP 端口 38412。执行 network.restore_policy 移除该规则后，到 AMF 38412 端口的 SCTP 流量不再被阻断。",
  "英文：Following the action ...": "SCTP traffic to AMF port 38412 is blocked. Following the action, SCTP traffic to AMF port 38412 is no longer blocked.",
}, { remediationObserved: true });

probe("D 组：换一种同样正确的说法（词汇敏感度）", {
  "丢弃而非阻断": "到 AMF 38412 端口的 SCTP 报文被丢弃。",
  "DROP 规则": "存在针对 sctp 38412 的 DROP 规则，导致 N2 建链失败。",
  "防火墙丢包": "防火墙把去往 38412 的 sctp 流量丢掉了。",
  "不提端口号": "到 AMF 的 SCTP 信令流量被阻断。",
  "不提 SCTP": "到 AMF 38412 端口的流量被阻断。",
  "只说 N2 被阻断": "N2 接口被阻断。",
  "说 NGAP 被阻断": "NGAP 信令被阻断。",
});

// D2：同样这 7 种说法，改由「事实编号」判定。措辞不再进入判定，
// 具体到那条规则的给满分，只说到接口层的给半分（拓扑相邻，但不过门）。
console.log("#".repeat(96));
console.log("D2 组：同样 7 种说法 + 各自应有的事实提名（新判据）");
console.log("#".repeat(96));
const RULE = "policy:sctp:38412:drop-rule-present";
for (const [label, refs] of Object.entries({
  "丢弃而非阻断": [RULE],
  "DROP 规则": [RULE],
  "防火墙丢包": [RULE],
  "不提端口号（只说到接口层）": ["n2"],
  "不提 SCTP（只说到接口层）": ["n2"],
  "只说 N2 被阻断": ["n2"],
  "说 NGAP 被阻断（N2 上跑的协议）": ["n2"],
})) {
  const grade = gradeRootCauseFacts(CASE, { root_cause_fact_refs: refs });
  const points = Number((grade.fact_score * 30 + grade.entity_score * 10).toFixed(2));
  console.log(`  ${String(points).padStart(5)} / 40 | 过门 ${grade.gate_passed ? "✓" : "✗"}`
    + ` | ${grade.verdict.padEnd(22)} | ${label}`);
}
console.log();
console.log(">>> 7 种说法没有一个是零分；只说到接口层的拿一半分但不过门。");
