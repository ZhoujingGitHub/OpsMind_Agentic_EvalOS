import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { M2_CASES, sha256 } from "../packages/kernel/src/index.mjs";
import { SshTwinClient } from "../packages/twin-runtime/src/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.resolve(process.env.M2_EXECUTOR_OUTPUT ?? path.join(ROOT, "artifacts", "m2-executor"));
const runId = process.env.M2_EXECUTOR_RUN_ID ?? `m2-executor-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
const client = new SshTwinClient({ timeoutMs: Number(process.env.M2_TWIN_TIMEOUT_MS ?? 180000) });
mkdirSync(outputRoot, { recursive: true });
const CALIBRATION_CHANGES = Object.freeze({
  "M2-REG-001": { action_type: "subscriber_profile", parameters: { source: "reference_profile" } },
  "M2-AUTH-002": { action_type: "subscriber_profile", parameters: { source: "reference_profile" } },
  "M2-PDU-003": { action_type: "subscriber_profile", parameters: { source: "reference_profile" } },
  "M2-SLICE-004": { action_type: "subscriber_profile", parameters: { source: "reference_profile" } },
  "M2-TAI-005": { action_type: "ran_configuration", parameters: { target: "tracking_area", source: "reference_config" } },
  "M2-AMF-006": { action_type: "service_state", parameters: { component: "amf", desired_state: "running" } },
  "M2-SMF-007": { action_type: "service_state", parameters: { component: "smf", desired_state: "running" } },
  "M2-UPF-008": { action_type: "service_state", parameters: { component: "upf", desired_state: "running" } },
  "M2-NRF-009": { action_type: "service_state", parameters: { component: "nrf", desired_state: "running" } },
  "M2-DB-010": { action_type: "service_state", parameters: { component: "mongodb", desired_state: "running" } },
  "M2-N2-011": { action_type: "network_policy", parameters: { interface: "n2", desired_state: "allow" } },
  "M2-PFCP-012": { action_type: "network_policy", parameters: { interface: "n4", desired_state: "allow" } },
  "M2-N3-013": { action_type: "network_policy", parameters: { interface: "n3", desired_state: "allow" } },
  "M2-N6-014": { action_type: "route_state", parameters: { route: "n6", desired_state: "present" } },
  "M2-DNS-015": { action_type: "network_policy", parameters: { interface: "dns", desired_state: "allow" } },
  "M2-LAT-016": { action_type: "traffic_control", parameters: { interface: "user_plane", delay_ms: 0 } },
  "M2-GNB-017": { action_type: "component_restart", parameters: { component: "gnb" } },
  "M2-GAP-018": null,
  "M2-STALE-019": { action_type: "alert_state", parameters: { alert: "amf-down", desired_state: "cleared" } },
  "M2-PROACTIVE-020": { action_type: "capture_policy", parameters: { policy: "bounded-retention", desired_state: "enabled" } },
});

function allTrue(value) {
  return value && Object.values(value).every((item) => item === true);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

const startedAt = new Date().toISOString();
const initialHealth = await client.invoke({ operation: "health" });
const details = [];
const publicCases = [];

for (const caseSpec of Object.values(M2_CASES)) {
  const trialId = `${runId}-${caseSpec.id.toLowerCase()}`;
  const calibrationChange = CALIBRATION_CHANGES[caseSpec.id];
  let prepared = null;
  let action = null;
  let snapshot = null;
  let reset = null;
  let failure = null;
  try {
    prepared = await client.invoke({ operation: "prepare", trial_id: trialId,
      scenario_id: caseSpec.environment.scenario_id, seed: 20260814,
      baseline_ref: caseSpec.environment.baseline_ref });
    if (!prepared.ok) throw new Error(`prepare failed: ${JSON.stringify(prepared.error)}`);
    if (calibrationChange) {
      action = await client.invoke({ operation: "act", trial_id: trialId, ...calibrationChange });
      if (!action.ok) throw new Error(`action failed: ${JSON.stringify(action.error)}`);
    }
    snapshot = await client.invoke({ operation: "snapshot", trial_id: trialId });
  } catch (error) {
    failure = error.message;
  } finally {
    if (prepared?.ok) {
      try { reset = await client.invoke({ operation: "reset", trial_id: trialId }); }
      catch (error) { failure = `${failure ? `${failure}; ` : ""}reset failed: ${error.message}`; }
    }
  }
  const recordedChanges = snapshot?.snapshot?.changes ?? [];
  const checks = {
    prepared: prepared?.ok === true,
    change_request_audit_round_trip_integrity: JSON.stringify(canonical(recordedChanges.map(({ at, ...item }) => item)))
      === JSON.stringify(canonical(calibrationChange ? [calibrationChange] : [])),
    recovery_verified_by_harness: snapshot?.snapshot?.recovery?.task_success === true,
    minimal_change_verified: snapshot?.snapshot?.recovery?.minimal_change === true,
    reset_clean: reset?.ok === true && reset?.clean === true && allTrue(reset?.verification),
  };
  const passed = !failure && Object.values(checks).every(Boolean);
  details.push({ case_ref: `${caseSpec.id}@${caseSpec.version}`, trial_id: trialId, passed, checks, failure,
    calibration_change: calibrationChange, recorded_changes: recordedChanges, prepared, action, snapshot, reset });
  publicCases.push({ case_ref: `${caseSpec.id}@${caseSpec.version}`, passed, checks,
    mode: calibrationChange ? "执行器恢复校准" : "安全停止校准" });
  process.stdout.write(`${caseSpec.id}: ${passed ? "PASS" : "FAIL"}\n`);
}

const finalHealth = await client.invoke({ operation: "health" });
const checks = {
  initial_baseline_clean: initialHealth.ok === true && allTrue(initialHealth.baseline),
  all_20_cases_executed: details.length === 20,
  all_19_executor_recoveries_passed: publicCases.filter((item) => item.mode === "执行器恢复校准").length === 19
    && publicCases.filter((item) => item.mode === "执行器恢复校准").every((item) => item.passed),
  safe_stop_executor_state_passed: publicCases.filter((item) => item.mode === "安全停止校准").length === 1
    && publicCases.filter((item) => item.mode === "安全停止校准").every((item) => item.passed),
  all_change_requests_audited_without_mutation: publicCases.every((item) => item.checks.change_request_audit_round_trip_integrity),
  harness_recovery_verified: publicCases.every((item) => item.checks.recovery_verified_by_harness),
  every_trial_reset_clean: publicCases.every((item) => item.checks.reset_clean),
  final_baseline_clean: finalHealth.active_trial === null && allTrue(finalHealth.baseline),
};
const status = Object.values(checks).every(Boolean) ? "PASSED" : "FAILED";
const conclusion = { contract: "evalos-m2-change-executor-acceptance.2", gate: "M2-CHANGE-EXECUTOR", status, run_id: runId,
  execution: "真实协议数字孪生通用参数化变更执行器；只校准执行器与终态复核，不冒充 Agent 自主选择",
  started_at: startedAt, completed_at: new Date().toISOString(), checks, cases: publicCases };
const privateResult = { ...conclusion, cases: details, private: true, sha256: null };
privateResult.sha256 = sha256({ ...privateResult, sha256: null });
writeFileSync(path.join(outputRoot, "M2变更执行器验收结论.json"), `${JSON.stringify(conclusion, null, 2)}\n`, "utf8");
const privatePath = path.join(outputRoot, "M2变更执行器验收明细.private.json");
writeFileSync(privatePath, `${JSON.stringify(privateResult, null, 2)}\n`, "utf8");
chmodSync(privatePath, 0o600);
writeFileSync(path.join(outputRoot, "M2通用变更执行器验收报告.md"), [
  "# M2 通用变更执行器与安全停止状态验收报告", "", `- 结论：**${status}**`, `- 运行编号：\`${runId}\``,
  "- 本报告只校准 9 类通用参数化变更能否恢复 19 个环境故障，以及安全停止时环境不被改写。",
  "- 它不评价 Agent 是否选对修复路径；Agent 自主处置另由真实端到端 Trial 验收。", "", "## 门禁", "",
  ...Object.entries(checks).map(([name, passed]) => `- ${passed ? "通过" : "失败"}：${name}`), "",
].join("\n"), "utf8");
console.log(JSON.stringify({ status, checks, output_root: outputRoot }, null, 2));
if (status !== "PASSED") process.exitCode = 1;
