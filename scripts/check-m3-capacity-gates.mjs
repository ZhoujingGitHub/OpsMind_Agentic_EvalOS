import { availableParallelism, freemem, totalmem } from "node:os";
import { mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SshTwinClient } from "../packages/twin-runtime/src/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.resolve(process.env.M3_CAPACITY_OUTPUT ?? path.join(ROOT, "artifacts", "m3-capacity-preflight"));
mkdirSync(outputRoot, { recursive: true });

for (const name of ["EVALOS_TWIN_HOST", "EVALOS_TWIN_SSH_KEY", "EVALOS_TWIN_KNOWN_HOSTS"]) {
  if (!process.env[name]) throw new Error(`缺少 ${name}`);
}

const manifests = ["m3-capacity-4x.manifest.json", "m3-capacity-8x.manifest.json"].map((name) => ({
  name, value: JSON.parse(readFileSync(path.join(ROOT, "config", name), "utf8")),
}));
const health = await new SshTwinClient().invoke({ operation: "health" });
if (!health.ok || health.status !== "ready") throw new Error("Twin 健康检查未通过，不能进行容量试运行");
const twinSlots = Number(health.capacity?.max_parallel_trials ?? 1);
const activeTwinTrials = Number(health.capacity?.active_trials ?? (health.active_trial ? 1 : 0));
const disk = statfsSync(ROOT);
const host = {
  logical_cpus: availableParallelism(), total_memory_bytes: totalmem(), free_memory_bytes: freemem(),
  workspace_free_bytes: Number(disk.bavail) * Number(disk.bsize),
};
const gates = manifests.map(({ name, value }) => {
  const requiredSlots = Number(value.capacity_policy.twin_slots);
  const requiredWorkers = Number(value.capacity_policy.runner_workers);
  const expectedTrials = value.case_refs.length * value.environment_seeds.length * value.replicates_per_seed * value.contestants.length;
  const checks = {
    manifest_is_unscored_capacity_rehearsal: value.evaluation_mode === "CAPACITY_REHEARSAL",
    exact_trial_count: expectedTrials === (requiredWorkers === 4 ? 24 : 48),
    twin_reports_explicit_isolation_capacity: Number.isInteger(twinSlots) && twinSlots > 0,
    twin_is_idle_before_rehearsal: activeTwinTrials === 0 && !health.active_trial,
    enough_real_twin_slots: twinSlots >= requiredSlots,
    enough_evalos_memory_headroom: host.free_memory_bytes >= 2 * 1024 ** 3,
    enough_workspace_disk: host.workspace_free_bytes >= 5 * 1024 ** 3,
  };
  return { manifest: name, requested_workers: requiredWorkers, requested_twin_slots: requiredSlots,
    expected_trials: expectedTrials, checks, ready: Object.values(checks).every(Boolean) };
});
const result = {
  contract: "evalos-m3-capacity-preflight.1", checked_at: new Date().toISOString(),
  status: gates.every((item) => item.ready) ? "PASSED" : "BLOCKED",
  paid_trials_started: false,
  reason: gates.every((item) => item.ready) ? "所有硬门禁通过，可以按 4 并发再 8 并发顺序执行不计分容量 Trial。"
    : "现有环境没有足够的真实隔离 Twin 槽位；为避免并发 Trial 互相污染，容量门禁在模型调用前安全停止。",
  twin: { status: health.status, active_trial: health.active_trial ?? null,
    capacity: health.capacity ?? { max_parallel_trials: 1, active_trials: activeTwinTrials, isolation_mode: "legacy-serial-runtime" } },
  evalos_host: host,
  gates,
};
writeFileSync(path.join(outputRoot, "M3容量试运行前置门禁.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
writeFileSync(path.join(outputRoot, "M3容量试运行前置门禁.md"), [
  "# M3 容量试运行前置门禁", "", `- 结论：**${result.status}**`, `- 是否启动付费 Trial：**否**`,
  `- Twin 真实并发槽位：${twinSlots}`, `- 说明：${result.reason}`, "", "## 4 并发与 8 并发", "",
  ...gates.flatMap((item) => [`### ${item.manifest}`, "", `- 要求：${item.requested_workers} Worker / ${item.requested_twin_slots} Twin 槽位 / ${item.expected_trials} Trial`,
    ...Object.entries(item.checks).map(([name, passed]) => `- ${passed ? "通过" : "未通过"}：${name}`), ""]),
].join("\n"), "utf8");
console.log(JSON.stringify(result, null, 2));
if (result.status !== "PASSED") process.exitCode = 2;
