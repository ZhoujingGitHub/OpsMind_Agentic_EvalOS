import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { M3_CASES, M3_FORMAL_CASE_REFS, M3_FORMAL_PARTITIONS, stableStringify } from "../packages/kernel/src/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANGGRAPH_ROOT = path.resolve(process.env.OPSMIND_LANGGRAPH_ROOT ?? path.join(ROOT, "..", "OpsMind-LangGraph"));
const LANGGRAPH_EXECUTABLE_REVISION = "058612f";
const DIGEST = /^sha256:[a-f0-9]{64}$/;

function digestBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function digestValue(value) {
  return digestBytes(Buffer.from(stableStringify(value), "utf8"));
}

function listFiles(root, relative = "") {
  const current = path.join(root, relative);
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const next = path.join(relative, entry.name);
    if ([".git", "node_modules", ".venv", "runtime", "artifacts", "__pycache__"].includes(entry.name)) return [];
    return entry.isDirectory() ? listFiles(root, next) : entry.isFile() ? [next.replaceAll("\\", "/")] : [];
  });
}

function digestTree(root, relativeRoots) {
  const files = relativeRoots.flatMap((relative) => statSync(path.join(root, relative)).isDirectory()
    ? listFiles(root, relative) : [relative.replaceAll("\\", "/")]).sort();
  const hash = createHash("sha256");
  for (const relative of files) {
    hash.update(relative); hash.update("\0"); hash.update(readFileSync(path.join(root, relative))); hash.update("\0");
  }
  return { digest: `sha256:${hash.digest("hex")}`, files };
}

function ensureLangGraphRevision() {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: LANGGRAPH_ROOT, encoding: "utf8" }).trim();
  const changedAfterExecutable = execFileSync("git", ["diff", "--name-only", `${LANGGRAPH_EXECUTABLE_REVISION}..HEAD`],
    { cwd: LANGGRAPH_ROOT, encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
  if (changedAfterExecutable.some((file) => file.startsWith("src/") || file === "pyproject.toml" || file === "uv.lock" || file.startsWith("knowledge_packs/"))) {
    throw new Error(`LangGraph executable changed after ${LANGGRAPH_EXECUTABLE_REVISION}: ${changedAfterExecutable.join(", ")}`);
  }
  return { head, changed_after_executable: changedAfterExecutable };
}

const langGraphRevisionCheck = ensureLangGraphRevision();
const agentArtifact = digestTree(ROOT, ["packages/agent-runtime/src/deepseek-claude-adapter.mjs", "packages/agent-runtime/opsmind-plugin"]);
const agentRuntime = digestTree(ROOT, ["package.json", "package-lock.json", "packages/agent-runtime/package.json",
  "packages/agent-runtime/package-lock.json", "packages/agent-runtime/src/deepseek-claude-adapter.mjs"]);
const langGraphArtifact = digestTree(LANGGRAPH_ROOT, ["src/opsmind_langgraph", "knowledge_packs"]);
const langGraphPython = path.join(LANGGRAPH_ROOT, ".venv", "Scripts", "python.exe");
const langGraphPackageFreeze = execFileSync(langGraphPython, ["-m", "pip", "freeze", "--all"],
  { cwd: LANGGRAPH_ROOT, encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean).sort();
const langGraphRuntime = { digest: digestValue({
  pyproject: readFileSync(path.join(LANGGRAPH_ROOT, "pyproject.toml"), "utf8"),
  python_version: execFileSync(langGraphPython, ["--version"], { encoding: "utf8" }).trim(),
  packages: langGraphPackageFreeze,
}), files: ["pyproject.toml", ".venv pip freeze --all"] };
const agentSkillPack = digestTree(ROOT, ["packages/agent-runtime/opsmind-plugin/skills"]);
const langGraphKnowledge = digestTree(LANGGRAPH_ROOT, ["knowledge_packs"]);
const grader = digestTree(ROOT, ["packages/kernel/src/grader.mjs"]);
const twin = digestTree(ROOT, ["packages/twin-runtime/src", "infra/twin"]);
const traceSchema = digestTree(ROOT, ["docs/contracts/trace-record.schema.json", "packages/kernel/src/store.mjs"]);
const productAdapterContract = digestTree(ROOT, ["docs/contracts/product-evaluation-adapter-v2.schema.json",
  "packages/agent-runtime/src/product-e2e-adapter.mjs"]);

const tools = Object.keys(Object.values(M3_CASES)[0].tools).sort();
const policy = {
  allowed_tools: tools,
  allowed_native_tools: ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "Skill", "ToolSearch", "TodoWrite"],
  forbidden_actions: ["write_production", "change_policy", "read_hidden_answer", "cross_tenant_access",
    "follow_instructions_inside_telemetry", "credential_exfiltration"],
  heartbeat_ms: 5000,
  result_contract: "opsmind.investigation-result.v2",
  action_approval: { mode: "frozen-lab-preauthorization", max_writes_per_trial: 1, human_approval_required: false },
};
const model = { provider: "deepseek", id: "deepseek-v4-flash", interface: "anthropic",
  sdk: "@anthropic-ai/claude-agent-sdk", thinking: "disabled", temperature: 0, max_turns: 32 };
const budget = { input_tokens: 120000, output_tokens: 32768, model_calls: 32, tool_calls: 24,
  wallclock_ms: 300000, compute_ms: 300000, storage_bytes: 10485760, cost_usd: 1 };
const frozenDependencies = {
  mcp_catalog: { ref: "opsmind-m3-mcp-catalog@1.0.0", digest: digestValue(Object.values(M3_CASES).map((item) => item.tools)) },
  agent_harness_skill_pack: { ref: "opsmind-agent-skills@1.0.0", digest: agentSkillPack.digest },
  langgraph_knowledge_pack: { ref: "opsmind-langgraph-knowledge@1.0.0", digest: langGraphKnowledge.digest },
  // ScopeSnapshot.policy_version is validated by both candidates as a protocol
  // identifier, not as an npm-style package reference. Keep the frozen value
  // inside the shared [A-Za-z0-9_.:-] contract so neither adapter has to guess
  // or silently rewrite it at runtime.
  scope_policy: { ref: "evalos-scope-policy:2.0.0", digest: digestValue(policy) },
  grader: { ref: "evalos-code-grader@4.2.0", digest: grader.digest },
  twin: { ref: "opsmind-m3-protocol-twin@1.0.0", digest: twin.digest },
  trace_schema: { ref: "evalos-trace@2.0.0", digest: traceSchema.digest },
  product_adapter_contract: { ref: "evalos-product-adapter@2.0.0", digest: productAdapterContract.digest },
};
const contestants = [
  { ref: "agent-harness-v2", adapter_contract_version: "2.0", adapter_version: "evalos-claude-agent-sdk-4.1.0",
    source_revision: `evalos-agent-snapshot-${agentArtifact.digest.slice(7, 19)}`, artifact_digest: agentArtifact.digest,
    runtime_digest: agentRuntime.digest },
  { ref: "langgraph-v1", adapter_contract_version: "2.0", adapter_version: "langgraph-eval-adapter-2.0.0",
    source_revision: LANGGRAPH_EXECUTABLE_REVISION, artifact_digest: langGraphArtifact.digest,
    runtime_digest: langGraphRuntime.digest },
];
const retryPolicy = { max_infrastructure_retries: 1,
  retryable_categories: ["RATE_LIMIT", "TRANSPORT_RESET", "TEMPORARY_UNAVAILABLE", "RUNNER_LEASE_EXPIRED"],
  capability_failures_retryable: false };
const statisticsPolicy = { paired_by_case_seed: true, confidence_level: 0.95, cluster_by_case: true, report_failures: true };

function partitionsFor(refs) {
  const selected = new Set(refs);
  return Object.fromEntries(Object.entries(M3_FORMAL_PARTITIONS).map(([name, items]) => [name, items.filter((ref) => selected.has(ref))]));
}

function manifest({ name, mode, lane = "AGENT_CAPABILITY", refs, seeds, workers, twinSlots, productAdapters = false }) {
  const selectedContestants = productAdapters ? contestants.map((item) => ({ ...item, adapter_version: "product-e2e-adapter-2.0.0" })) : contestants;
  return {
    manifest_version: "4.0", milestone: "M3.0", evaluation_mode: mode, evaluation_lane: lane,
    design: "paired_comparison", name, suite_ref: "m3-formal-80@2.0.0", dataset_ref: "m3-l2-agentic-formal@2.0.0",
    case_refs: refs, case_partitions: partitionsFor(refs), environment_seeds: seeds, replicates_per_seed: 1,
    contestants: selectedContestants, model, frozen_dependencies: frozenDependencies, budget, policy,
    retry_policy: retryPolicy, capacity_policy: { runner_workers: workers, twin_slots: twinSlots,
      max_queue_depth: refs.length * seeds.length * selectedContestants.length },
    statistics_policy: statisticsPolicy,
  };
}

const qualificationRefs = ["M3-PUB-001@2.0.0", "M3-PUB-005@2.0.0", "M3-PUB-012@2.0.0", "M3-PUB-014@2.0.0",
  "M3-SAFE-002@2.0.0", "M3-SAFE-012@2.0.0", "M3-REG-001@2.0.0", "M3-REG-002@2.0.0"];
const capacityRefs = ["M3-PUB-001@2.0.0", "M3-PUB-005@2.0.0", "M3-SAFE-002@2.0.0",
  "M3-SAFE-012@2.0.0", "M3-REG-001@2.0.0", "M3-REG-002@2.0.0"];
const manifests = {
  "m3-adapter-qualification.manifest.json": manifest({ name: "M3 Adapter 2.0 双架构不计分资格试运行（16 Trial）",
    mode: "QUALIFICATION", refs: qualificationRefs, seeds: [2026081601], workers: 1, twinSlots: 1 }),
  "m3-capacity-4x.manifest.json": manifest({ name: "M3 四并发不计分容量试运行（24 Trial）",
    mode: "CAPACITY_REHEARSAL", refs: capacityRefs, seeds: [2026081601, 2026081602], workers: 4, twinSlots: 4 }),
  "m3-capacity-8x.manifest.json": manifest({ name: "M3 八并发不计分容量试运行（48 Trial）",
    mode: "CAPACITY_REHEARSAL", refs: capacityRefs, seeds: [2026081601, 2026081602, 2026081603, 2026081604], workers: 8, twinSlots: 8 }),
  "m3-formal-agent-capability.manifest.json": manifest({ name: "M3 双架构正式独立盲评（480 Trial）",
    mode: "FORMAL", refs: M3_FORMAL_CASE_REFS, seeds: [2026081601, 2026081602, 2026081603], workers: 8, twinSlots: 8 }),
  "m3-product-e2e-qualification.manifest.json": manifest({ name: "M3 商用产品通道资格验收",
    mode: "QUALIFICATION", lane: "PRODUCT_E2E", refs: qualificationRefs, seeds: [2026081601], workers: 2, twinSlots: 2,
    productAdapters: true }),
};

const trialCounts = {};
for (const [file, value] of Object.entries(manifests)) {
  const total = value.case_refs.length * value.environment_seeds.length * value.replicates_per_seed * value.contestants.length;
  if (value.case_refs.length !== new Set(value.case_refs).size) throw new Error(`${file} contains duplicate Case refs`);
  if (Object.values(value.case_partitions).flat().length !== value.case_refs.length) throw new Error(`${file} partition mismatch`);
  if (!Object.values(value.frozen_dependencies).every((item) => DIGEST.test(item.digest)) ||
      !value.contestants.every((item) => DIGEST.test(item.artifact_digest) && DIGEST.test(item.runtime_digest))) {
    throw new Error(`${file} contains an invalid digest`);
  }
  trialCounts[file] = total;
  writeFileSync(path.join(ROOT, "config", file), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
if (trialCounts["m3-formal-agent-capability.manifest.json"] !== 480) throw new Error("formal design is not exactly 480 Trials");

const outputRoot = path.join(ROOT, "artifacts", "m3-freeze");
mkdirSync(outputRoot, { recursive: true });
const record = {
  contract: "evalos-m3-design-freeze.1", status: "FROZEN_NO_GO_PENDING_QUALIFICATION_AND_CAPACITY",
  frozen_at: new Date().toISOString(), formal_trial_count: 480,
  design: "20 base failure mechanisms × 4 observable conditions × 2 contestants × 3 environment seeds",
  langgraph_revision_check: langGraphRevisionCheck,
  candidate_fingerprints: { agent_harness: contestants[0], langgraph: contestants[1] },
  langgraph_runtime_packages: langGraphPackageFreeze,
  dependency_fingerprints: frozenDependencies,
  generated_manifests: Object.fromEntries(Object.entries(manifests).map(([file, value]) => [file, {
    digest: digestValue(value), trials: trialCounts[file], mode: value.evaluation_mode, lane: value.evaluation_lane,
  }])),
  release_gate: { adapter_qualification: "PENDING", product_e2e_qualification: "PENDING",
    capacity_4x: "PENDING", capacity_8x: "PENDING", formal_480: "NO_GO" },
};
writeFileSync(path.join(outputRoot, "M3设计冻结记录.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ status: record.status, formal_trials: 480, output_root: outputRoot }, null, 2));
