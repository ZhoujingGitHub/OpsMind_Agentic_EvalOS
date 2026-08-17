import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { M2_CASES, sha256 } from "../packages/kernel/src/index.mjs";
import { SshTwinClient } from "../packages/twin-runtime/src/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.resolve(process.env.M2_ACCEPTANCE_OUTPUT ?? path.join(ROOT, "artifacts", "m2"));
const runId = process.env.M2_ACCEPTANCE_RUN_ID ?? `m2-twin-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
const capabilities = ["health", "logs", "sessions", "processes", "pcap_summary", "connectivity", "subscriber", "metrics"];
const client = new SshTwinClient({ timeoutMs: Number(process.env.M2_TWIN_TIMEOUT_MS ?? 180000) });
mkdirSync(outputRoot, { recursive: true });

function allTrue(value) {
  return value && Object.values(value).every((item) => item === true);
}

function protocolFrames(observations) {
  return observations.find((item) => item.capability === "pcap_summary")?.response?.data?.protocol_frames ?? {};
}

function metricData(observations) {
  return observations.find((item) => item.capability === "metrics")?.response?.data ?? {};
}

const startedAt = new Date().toISOString();
const initialHealth = await client.invoke({ operation: "health" });
const privateCases = [];
const publicCases = [];
const resetHashes = [];

for (const caseSpec of Object.values(M2_CASES)) {
  const trialId = `${runId}-${caseSpec.id.toLowerCase()}`;
  const observations = [];
  let prepared = null;
  let snapshot = null;
  let reset = null;
  let failure = null;
  try {
    prepared = await client.invoke({ operation: "prepare", trial_id: trialId,
      scenario_id: caseSpec.environment.scenario_id, seed: 20260814,
      baseline_ref: caseSpec.environment.baseline_ref });
    if (!prepared.ok) throw new Error(`prepare failed: ${JSON.stringify(prepared.error)}`);
    for (const capability of capabilities) {
      const response = await client.invoke({ operation: "observe", trial_id: trialId, capability });
      observations.push({ capability, response });
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

  const observed = [...new Set(observations.flatMap((item) => item.response.evidence_refs ?? []))];
  const missing = caseSpec.ground_truth.required_evidence.filter((ref) => !observed.includes(ref));
  const pcap = observations.find((item) => item.capability === "pcap_summary")?.response?.data ?? {};
  const frames = protocolFrames(observations);
  const checks = {
    prepared: prepared?.ok === true,
    isolated_namespace: prepared?.isolation === "serial-host-runtime+dedicated-artifact-namespace",
    pcap_written: Number(pcap.files) >= 1 && Number(pcap.bytes) > 24,
    protocol_observed: Object.values(frames).some((count) => Number(count) > 0),
    required_evidence_observed: missing.length === 0,
    snapshot_written: snapshot?.ok === true,
    reset_clean: reset?.ok === true && reset?.clean === true && allTrue(reset?.verification),
  };
  if (reset?.reset_hash) resetHashes.push(reset.reset_hash);
  const passed = !failure && Object.values(checks).every(Boolean);
  privateCases.push({ case_ref: `${caseSpec.id}@${caseSpec.version}`, scenario_id: caseSpec.environment.scenario_id,
    trial_id: trialId, passed, checks, failure, required_evidence: caseSpec.ground_truth.required_evidence,
    observed_evidence: observed, missing_evidence: missing, prepared, observations, snapshot, reset });
  publicCases.push({ case_ref: `${caseSpec.id}@${caseSpec.version}`, scenario_id: caseSpec.environment.scenario_id,
    passed, checks, observed_evidence_count: observed.length, failure: failure ? "Trial 基础设施失败" : null });
  process.stdout.write(`${caseSpec.id}: ${passed ? "PASS" : "FAIL"}\n`);
}

const finalHealth = await client.invoke({ operation: "health" });
const maxDiskPercent = Math.max(0, ...privateCases.map((item) => Number(metricData(item.observations).disk_percent ?? 0)));
const checks = {
  real_components_ready: initialHealth.ok === true && initialHealth.status === "ready",
  initial_baseline_clean: allTrue(initialHealth.baseline),
  all_20_cases_executed: publicCases.length === 20,
  all_20_cases_passed: publicCases.every((item) => item.passed),
  every_trial_has_pcap: publicCases.every((item) => item.checks.pcap_written),
  every_trial_reset_clean: publicCases.every((item) => item.checks.reset_clean),
  reset_hash_is_deterministic: resetHashes.length === 20 && new Set(resetHashes).size === 1,
  final_baseline_clean: finalHealth.active_trial === null && allTrue(finalHealth.baseline),
  disk_capacity_safe: maxDiskPercent < 80,
};
const status = Object.values(checks).every(Boolean) ? "PASSED" : "FAILED";
const conclusion = {
  contract: "evalos-m2-acceptance.1", gate: "M2", status, run_id: runId,
  execution: "真实 Open5GS + MongoDB + UERANSIM；由 EvalLab 经受限 SSH 调用；非确定性回放替身",
  started_at: startedAt, completed_at: new Date().toISOString(), checks,
  components: finalHealth.versions, case_count: publicCases.length,
  passed_cases: publicCases.filter((item) => item.passed).length,
  reset_hash: new Set(resetHashes).size === 1 ? resetHashes[0] : null,
  maximum_disk_percent: maxDiskPercent, cases: publicCases,
};
const detail = { ...conclusion, initial_health: initialHealth, final_health: finalHealth,
  cases: privateCases, private: true, sha256: null };
detail.sha256 = sha256({ ...detail, sha256: null });
writeFileSync(path.join(outputRoot, "M2验收结论.json"), `${JSON.stringify(conclusion, null, 2)}\n`, "utf8");
writeFileSync(path.join(outputRoot, "M2验收明细.private.json"), `${JSON.stringify(detail, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
const report = [
  "# OpsMind Agentic EvalOS M2 真实协议数字孪生验收报告", "",
  `- 结论：**${status}**`, `- 运行编号：\`${runId}\``,
  `- Case：${conclusion.passed_cases}/${conclusion.case_count} 通过`,
  `- 稳定基线哈希：\`${conclusion.reset_hash ?? "不一致"}\``,
  `- 最大磁盘占用：${maxDiskPercent}%`, "",
  "## 口径", "",
  "本报告只把真实 Open5GS、MongoDB、UERANSIM 组件运行、真实 PCAP、真实故障观测和清洁复位计入 M2。模拟脑与回放替身不计入。", "",
  "## 门禁", "",
  ...Object.entries(checks).map(([key, value]) => `- ${value ? "通过" : "失败"}：${key}`), "",
].join("\n");
writeFileSync(path.join(outputRoot, "M2真实协议数字孪生验收报告.md"), report, "utf8");
console.log(JSON.stringify({ status, checks, output_root: outputRoot }, null, 2));
if (status !== "PASSED") process.exitCode = 1;
