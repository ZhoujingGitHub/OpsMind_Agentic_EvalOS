import { M3_CASES } from "./m3-cases.mjs";

// An incident with symptoms only. Existing curated 3.1 cases remain immutable.
const item = structuredClone(M3_CASES["M3-PUB-008"]);
item.id = "M3-OBS-001";
item.version = "3.2.0";
item.goal = "调查当前5G实验环境中终端无法正常注册、业务访问失败的问题。请依据现场证据自主调查，说明根因与不确定性，提出符合当前授权范围的最小修复提案。修复须经独立审批，执行后以新的现场观测独立验证业务是否恢复，并提交有证据支持的正式报告和建议。证据不足时如实说明，不能把进程存活或动作返回成功直接当作业务恢复。";
delete item.visible.scope.evaluation_partition;
delete item.visible.scope.observation_profile;
delete item.visible.test_condition;
item.source.dataset = "m3-symptom-observations";
item.ground_truth.base_case_ref = "M3-PUB-008@3.1.0";
item.ground_truth.required_evidence = item.ground_truth.required_evidence.map((ref) =>
  ref === "state:firewall-sctp-drop" ? "policy:sctp:38412:drop-rule-present" : ref);
// Live tools supply their own receipts. Static reference labels must not be
// present in runtime tool definitions, even when the public view omits them.
for (const tool of Object.values(item.tools)) delete tool.result;

export const M3_OBSERVATION_CASES = Object.freeze({ [item.id]: Object.freeze(item) });
