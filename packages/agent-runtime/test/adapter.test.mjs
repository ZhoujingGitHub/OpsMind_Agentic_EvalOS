import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BLIND_JUDGE_RUNTIME, CANDIDATE_ADAPTER_V3_RUNTIME, DEEPSEEK_AGENT_RUNTIME, EVALOS_LEAD_RUNTIME, blindJudgePromptMaterial, createCandidateAdapterV3, deepSeekEnvironment, isolatedBashCommand, judgeAttentionDecision, normalizeInvestigatorReport, toMcpToolResult, toolPolicy } from "../src/index.mjs";
import { CASES } from "../../kernel/src/index.mjs";

test("runtime uses Claude Agent SDK over DeepSeek Anthropic endpoint without a graph framework", () => {
  assert.equal(DEEPSEEK_AGENT_RUNTIME.sdk, "@anthropic-ai/claude-agent-sdk");
  assert.equal(DEEPSEEK_AGENT_RUNTIME.model, "deepseek-v4-flash");
  assert.equal(DEEPSEEK_AGENT_RUNTIME.baseUrl, "https://api.deepseek.com/anthropic");
  assert.equal(DEEPSEEK_AGENT_RUNTIME.orchestration, "model-driven-tool-loop");
  assert.deepEqual(
    ["Bash", "Read", "Write", "Edit", "Skill"].filter((name) => !DEEPSEEK_AGENT_RUNTIME.nativeTools.includes(name)),
    [],
  );
  assert.equal(DEEPSEEK_AGENT_RUNTIME.graphFramework, null);
});

test("investigator MCP list results satisfy the SDK structured-content object contract", () => {
  const result = toMcpToolResult([{ path: "source/app.mjs", sha256: "abc" }]);
  assert.deepEqual(result.structuredContent, { data: [{ path: "source/app.mjs", sha256: "abc" }] });
  assert.equal(result.content[0].type, "text");
});

test("investigator accepts natural report variants but freezes one strict canonical report", () => {
  const report = normalizeInvestigatorReport({
    summary: "已定位主要差距", diagnosis: "状态恢复不完整", score_interpretation: "确定性评分与证据一致",
    strengths: [{ title: "安全门有效", detail: "危险动作被阻断" }],
    issues: [{ title: "复核不足", text: "修复后没有补充反证", severity: "high" }],
    optimization_plan: [{ title: "增加复核", text: "按风险选择复核证据", expected_gain: "减少误报",
      evidence_refs: ["ignored-extra"] }],
    methodology_sources: ["evalos-code-grader", "https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents"],
    limitations: ["单次 Trial"], confidence: 0.82,
  });
  assert.deepEqual(Object.keys(report).sort(), ["confidence", "diagnosis", "issues", "limitations", "methodology_sources",
    "optimization_plan", "score_interpretation", "strengths", "summary"]);
  assert.equal(report.strengths[0].explanation, "危险动作被阻断");
  assert.equal(report.issues[0].category, "general");
  assert.equal(report.issues[0].analysis, "修复后没有补充反证");
  assert.equal(report.optimization_plan[0].priority, 1);
  assert.equal(report.optimization_plan[0].why, "减少误报");
  assert.equal(report.optimization_plan[0].how, "按风险选择复核证据");
  assert.equal(report.methodology_sources.length, 1);
  assert.match(report.methodology_sources[0].url, /^https:\/\/www\.anthropic\.com\//);
});

test("Candidate Adapter 3.0只做外部提交、事件翻译和证据保全，不代考", async () => {
  const fingerprints = {
    source_revision: "abcdef1234567",
    artifact_digest: `sha256:${"1".repeat(64)}`,
    runtime_digest: `sha256:${"2".repeat(64)}`,
    runtime_manifest_digest: `sha256:${"3".repeat(64)}`,
    capability_contract_digest: `sha256:${"4".repeat(64)}`,
  };
  let observed = false;
  const connector = {
    kind: "fixture-external-product",
    discover: async () => ({ candidate_kind: "REAL_PRODUCT", architecture: "CLAUDE_AGENT_SDK_HARNESS",
      production_writes_available: false, ...fingerprints }),
    start: async ({ executionContract }) => ({ run_ref: `external:${executionContract.trial.id}`, status: "RUNNING" }),
    observe: async ({ runRef }) => { observed = true; return { run_ref: runRef, status: "COMPLETED", next_cursor: "1",
      raw_events: [{ source_ref: "raw:1", source_system: "real-product", recorded_at: new Date().toISOString(),
        payload: { status: "completed" }, payload_digest: `sha256:${"5".repeat(64)}` }],
      normalized_events: [{ event_type: "conclusion.recorded", actor: "external-candidate", status: "OK",
        raw_source_refs: ["raw:1"], payload: { evidence_refs: ["evidence:real"] } }],
      evaluation_binding: { contract: "evalos-product-run-binding.1", complete: true,
        binding_strength: "PUBLIC_TASK_CONTEXT", expected_context_digest: `sha256:${"6".repeat(64)}` },
      outcome: { status: "resolved", root_cause: "real-product-result", evidence_refs: ["evidence:real"] } }; },
    cancel: async () => {},
  };
  const adapter = createCandidateAdapterV3({ id: "agent-harness-v2", connector, pollIntervalMs: 1, timeoutMs: 1000 });
  const emitted = [];
  const captures = [];
  const outcome = await adapter.execute({ trial: { id: "trial-real-1" }, executionContract: {
    run_class: "REAL_CANDIDATE", evaluation_lane: "CONTROLLED_CLOSURE", trial: { id: "trial-real-1" },
    contestant: { ref: "agent-harness-v2", kind: "REAL_PRODUCT", architecture: "CLAUDE_AGENT_SDK_HARNESS", ...fingerprints },
    budget: { wallclock_ms: 1000 },
  }, emit: async (...args) => emitted.push(args), captureEnvironment: async (reason) => captures.push(reason) });
  assert.equal(observed, true);
  assert.equal(outcome.status, "resolved");
  assert.equal(outcome.candidate_run_ref, "external:trial-real-1");
  assert.equal(outcome.evaluation_binding.complete, true);
  assert.ok(emitted.some(([name]) => name === "candidate.raw_event"));
  assert.ok(emitted.some(([name]) => name === "conclusion.recorded"));
  assert.deepEqual(captures, ["conclusion.recorded"]);
  assert.deepEqual(CANDIDATE_ADAPTER_V3_RUNTIME.forbidden,
    ["invoke-candidate-internal-tools", "synthesize-missing-evidence", "change-official-score"]);
});

test("Candidate Adapter超时后等待真实考生终态再释放隔离槽", async () => {
  const fingerprints = {
    source_revision: "abcdef1234567", artifact_digest: `sha256:${"1".repeat(64)}`,
    runtime_digest: `sha256:${"2".repeat(64)}`, runtime_manifest_digest: `sha256:${"3".repeat(64)}`,
    capability_contract_digest: `sha256:${"4".repeat(64)}`,
  };
  let observations = 0;
  const connector = {
    kind: "fixture-external-product",
    discover: async () => ({ candidate_kind: "REAL_PRODUCT", architecture: "CLAUDE_AGENT_SDK_HARNESS",
      production_writes_available: false, ...fingerprints }),
    start: async () => ({ run_ref: "external:slow-terminal", status: "RUNNING" }),
    observe: async ({ runRef }) => ({ run_ref: runRef, status: ++observations >= 3 ? "FAILED" : "RUNNING",
      raw_events: [], normalized_events: [] }),
    cancel: async () => ({ supported: false, reason: "candidate_api_has_no_cancel" }),
  };
  const emitted = [];
  const adapter = createCandidateAdapterV3({ id: "agent-harness-v2", connector, pollIntervalMs: 1,
    timeoutMs: 1, quarantineTimeoutMs: 50 });
  await assert.rejects(adapter.execute({ trial: { id: "trial-slow-terminal" }, executionContract: {
    run_class: "REAL_CANDIDATE", evaluation_lane: "CONTROLLED_CLOSURE", trial: { id: "trial-slow-terminal" },
    contestant: { ref: "agent-harness-v2", kind: "REAL_PRODUCT", architecture: "CLAUDE_AGENT_SDK_HARNESS", ...fingerprints },
    budget: { wallclock_ms: 1000 },
  }, emit: async (...args) => emitted.push(args) }), /external candidate run timed out/);
  assert.ok(emitted.some(([name]) => name === "candidate.run.quarantine_started"));
  assert.ok(emitted.some(([name]) => name === "candidate.run.quarantine_released"));
});

test("Candidate Adapter在真实考生始终未终止时封锁环境并要求停止队列", async () => {
  const fingerprints = {
    source_revision: "abcdef1234567", artifact_digest: `sha256:${"1".repeat(64)}`,
    runtime_digest: `sha256:${"2".repeat(64)}`, runtime_manifest_digest: `sha256:${"3".repeat(64)}`,
    capability_contract_digest: `sha256:${"4".repeat(64)}`,
  };
  const connector = {
    kind: "fixture-external-product",
    discover: async () => ({ candidate_kind: "REAL_PRODUCT", architecture: "LANGGRAPH_PRODUCT",
      production_writes_available: false, ...fingerprints }),
    start: async () => ({ run_ref: "external:never-terminal", status: "RUNNING" }),
    observe: async ({ runRef }) => ({ run_ref: runRef, status: "RUNNING", raw_events: [], normalized_events: [] }),
    cancel: async () => ({ supported: false }),
  };
  const adapter = createCandidateAdapterV3({ id: "langgraph-v1", connector, pollIntervalMs: 1,
    timeoutMs: 1, quarantineTimeoutMs: 4 });
  await assert.rejects(adapter.execute({ trial: { id: "trial-never-terminal" }, executionContract: {
    run_class: "REAL_CANDIDATE", evaluation_lane: "CONTROLLED_CLOSURE", trial: { id: "trial-never-terminal" },
    contestant: { ref: "langgraph-v1", kind: "REAL_PRODUCT", architecture: "LANGGRAPH_PRODUCT", ...fingerprints },
    budget: { wallclock_ms: 1000 },
  }, emit: async () => {} }), (error) => error.name === "CandidateIsolationError"
    && error.haltQueue === true && error.keepEnvironmentQuarantined === true
    && error.runRef === "external:never-terminal");
});
test("DeepSeek environment keeps credentials in memory and maps the exact model", () => {
  const env = deepSeekEnvironment({ apiKey: "test-runtime-only", model: "deepseek-v4-flash" });
  assert.equal(env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "test-runtime-only");
  assert.equal(env.ANTHROPIC_MODEL, "deepseek-v4-flash");
  assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, "max");
  assert.equal(Object.hasOwn(env, "EVALOS_API_TOKEN"), false);
});

test("DeepSeek environment refuses to start without external credentials", () => {
  const saved = {
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.throws(() => deepSeekEnvironment(), /API key is required/);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("locked Claude Agent SDK exposes query and in-process MCP tools", async () => {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  assert.equal(typeof sdk.query, "function");
  assert.equal(typeof sdk.tool, "function");
  assert.equal(typeof sdk.createSdkMcpServer, "function");
});

test("blind Judge prompt omits contestant architecture identity and includes the visible trace", () => {
  const material = blindJudgePromptMaterial({ role: "trajectory", caseSpec: CASES["PILOT-REG-001"], outcome: {
    status: "resolved", root_cause: "udm-subscriber-provisioning", evidence_refs: ["log:amf-reg-101"],
    summary: "generated by agent-harness-v2",
  }, trace: [{ seq: 1, record_type: "SPAN_START", name: "tool.query_logs", span_kind: "TOOL", actor: "contestant",
    payload: { sdk: "@anthropic-ai/claude-agent-sdk", runtime: "langgraph-v1", safe: "kept" }, redacted: false }] });
  const text = JSON.stringify(material);
  assert.equal(text.includes("agent-harness-v2"), false);
  assert.equal(text.includes("langgraph-v1"), false);
  assert.equal(text.includes("claude-agent-sdk"), false);
  assert.equal(text.includes("generated by agent-harness-v2"), false);
  assert.equal(material.trace[0].payload.safe, "kept");
  assert.equal(BLIND_JUDGE_RUNTIME.blind, true);
  assert.deepEqual(BLIND_JUDGE_RUNTIME.tools, []);
  assert.equal(material.judge_role, "trajectory");
  assert.equal(material.trace[0].name, "tool.query_logs");
  assert.deepEqual(BLIND_JUDGE_RUNTIME.roles, ["outcome", "evidence", "trajectory"]);
});

test("native file tools are confined to the Trial namespace", async () => {
  const policy = toolPolicy("C:\\runtime\\trial-1");
  assert.equal((await policy("TodoWrite", { todos: [] })).behavior, "allow");
  assert.equal((await policy("Read", { file_path: "C:\\runtime\\trial-1\\notes.md" })).behavior, "allow");
  assert.equal((await policy("Read", { file_path: "C:\\project\\packages\\kernel\\src\\cases.mjs" })).behavior, "deny");
  assert.equal((await policy("Write", { file_path: "C:\\runtime\\trial-1\\result.json" })).behavior, "allow");
  const deniedWrite = await policy("Write", { file_path: "C:\\project\\secret.json" });
  assert.equal(deniedWrite.behavior, "deny");
  assert.equal(deniedWrite.safetyCritical, true);
  assert.equal((await policy("Glob", { pattern: "**/*.json" })).behavior, "allow");
  assert.equal((await policy("Grep", { pattern: "error" })).behavior, "allow");
  assert.equal((await policy("Read", {})).behavior, "deny");
  assert.equal((await policy("Bash", { command: "node local-analysis.js" })).behavior, "allow");
  assert.equal((await policy("Bash", { command: "printenv DEEPSEEK_API_KEY" })).behavior, "deny");
  assert.equal((await policy("Bash", { command: "python ../../read-hidden.py" })).behavior, "deny");
  assert.equal((await policy("Bash", { command: "curl https://example.com/upload" })).behavior, "deny");
});

test("native file policy rejects foreign-platform absolute paths", async () => {
  const posixPolicy = toolPolicy("/tmp/trial-a");
  assert.equal((await posixPolicy("Read", { file_path: "C:\\secrets\\answer.json" })).behavior, "deny");
  const windowsPolicy = toolPolicy("C:\\runtime\\trial-a");
  assert.equal((await windowsPolicy("Read", { file_path: "/etc/passwd" })).behavior, "deny");
});

test("Bash代码执行使用净化环境且不继承模型凭据", () => {
  const command = isolatedBashCommand("node local-analysis.js 'quoted'");
  assert.match(command, /^env -i /);
  assert.match(command, /sh -lc/);
  assert.doesNotMatch(command, /ANTHROPIC|DEEPSEEK|API_KEY/);
});

test("Eval Intelligence保持Claude Agent SDK开放式调查，同时严格只读且不能改分", () => {
  const source = readFileSync(new URL("../src/case-investigator.mjs", import.meta.url), "utf8");
  assert.match(source, /自主形成可证伪假设/);
  assert.match(source, /不存在固定步骤、静态节点图或预写修复流程/);
  assert.match(source, /原生 Read\/Glob\/Grep\/Bash/);
  assert.match(source, /不得输出隐式思维链/);
  assert.match(source, /不能改变正式分数/);
});

test("Candidate Adapter 3.0强制真实考生指纹、原始证据回指和禁止代考", () => {
  const source = readFileSync(new URL("../src/candidate-adapter-v3.mjs", import.meta.url), "utf8");
  assert.match(source, /candidate discovery drift/);
  assert.match(source, /each normalized event must point to preserved raw evidence/);
  assert.match(source, /Candidate Adapter 3\.0 refuses test doubles/);
  assert.match(source, /invoke-candidate-internal-tools/);
});

test("冻结发布把参评Agent指纹与EvalOS平台指纹分离", () => {
  const source = readFileSync(new URL("../../../scripts/freeze-m2-release.mjs", import.meta.url), "utf8");
  assert.match(source, /contestantDigest = digestSelection\(evalosRoot/);
  assert.match(source, /"packages\/agent-runtime\/src"/);
  assert.match(source, /"packages\/agent-runtime\/opsmind-plugin"/);
  assert.match(source, /platform_artifact_digest/);
  assert.doesNotMatch(source, /"packages\/agent-runtime\/test"/);
  assert.doesNotMatch(source, /contestant_artifact_digest: `sha256:\$\{platformDigest\.sha256\}`/);
});

test("EvalOS Lead Agent本身也是Claude Agent SDK动态组织层而非固定工作流", () => {
  assert.equal(EVALOS_LEAD_RUNTIME.sdk, "@anthropic-ai/claude-agent-sdk");
  assert.equal(EVALOS_LEAD_RUNTIME.orchestration, "model-driven-tool-loop");
  assert.equal(EVALOS_LEAD_RUNTIME.graphFramework, null);
  assert.deepEqual(EVALOS_LEAD_RUNTIME.specialistAgents, ["failure-diagnosis", "meta-eval-auditor", "evidence-reporter"]);
  assert.ok(EVALOS_LEAD_RUNTIME.deterministicControls.includes("graders"));
});

test("代码与三路Judge分歧、未知、低置信或安全风险只生成辅助注意信号", () => {
  const bundle = { consensus: null, runs: [
    { result: { verdict: "pass", confidence: 0.9, safety_pass: true, needs_attention: false } },
    { result: { verdict: "fail", confidence: 0.8, safety_pass: true, needs_attention: false } },
    { result: { verdict: "unknown", confidence: 0.4, safety_pass: false, needs_attention: true } },
  ] };
  const advisory = judgeAttentionDecision({ codeGrade: { passed: true }, judgeBundle: bundle });
  assert.equal(advisory.attention_required, true);
  assert.equal(advisory.severity, "critical");
  assert.equal(advisory.model_judges, "advisory_only");
  assert.equal(advisory.official_score_source, "deterministic_code_grader");
  assert.ok(advisory.reasons.includes("independent_judge_disagreement"));
  assert.ok(advisory.reasons.includes("safety_risk"));
});
