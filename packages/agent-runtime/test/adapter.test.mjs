import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";
import { BLIND_JUDGE_RUNTIME, DEEPSEEK_AGENT_RUNTIME, EVALOS_LEAD_RUNTIME, LANGGRAPH_RUNTIME, ProductToolBridgeRegistry, blindJudgePromptMaterial, createHarnessToolBridge, createProductE2EAdapter, deepSeekEnvironment, isolatedBashCommand, isLangGraphCapabilityFailure, judgeAttentionDecision, langGraphCapabilityFailureOutcome, normalizeInvestigatorReport, toMcpToolResult, toolPolicy } from "../src/index.mjs";
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

test("V1 comparison adapter is explicitly a real LangGraph StateGraph runtime", () => {
  assert.equal(LANGGRAPH_RUNTIME.architecture, "LANGGRAPH_V1");
  assert.equal(LANGGRAPH_RUNTIME.orchestration, "real-stategraph");
  assert.equal(LANGGRAPH_RUNTIME.model, "deepseek-v4-flash");
});

test("LangGraph Adapter 2.0 receives the frozen Manifest 4.0 Seed and replicate fields", () => {
  const adapterSource = readFileSync(new URL("../src/langgraph-adapter.mjs", import.meta.url), "utf8");
  const runnerSource = readFileSync(new URL("../python/langgraph_runner.py", import.meta.url), "utf8");
  assert.match(adapterSource, /environment_seed:\s*trial\.environment_seed/);
  assert.match(adapterSource, /replicate_id:\s*trial\.replicate_id/);
  assert.doesNotMatch(adapterSource, /trial\.seed/);
  assert.match(runnerSource, /trial\["environment_seed"\]/);
  assert.match(runnerSource, /trial\["replicate_id"\]/);
  assert.doesNotMatch(runnerSource, /trial\["seed"\]/);
  assert.match(runnerSource, /payload:\s*dict\[str, Any\],\s*\*,\s*latency_ms:\s*int\s*=\s*0/s);
  assert.match(runnerSource, /model_latency_ms=max\(0, int\(latency_ms\)\)/);
  assert.match(runnerSource, /evalos-scope-policy:2\.0\.0/);
  assert.doesNotMatch(runnerSource, /evalos-scope-policy@2\.0\.0/);
});

test("V1 comparison adapter obtains tool results through the live EvalOS Harness bridge", async () => {
  const calls = [];
  const bridge = await createHarnessToolBridge({ allowedTools: ["query_sessions"],
    toolExecutor: async (name, args) => { calls.push({ name, args }); return { ok: true, data: { registered: true }, evidence_refs: ["state:ue-registered"] }; } });
  try {
    const denied = await fetch(bridge.url, { method: "POST", headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      body: JSON.stringify({ tool_name: "query_sessions", arguments: {} }) });
    assert.equal(denied.status, 401);
    const response = await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ tool_name: "query_sessions", arguments: { tenant: "opsmind-m2-lab" } }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, data: { registered: true }, evidence_refs: ["state:ue-registered"] });
    assert.deepEqual(calls, [{ name: "query_sessions", args: { tenant: "opsmind-m2-lab" } }]);
  } finally { await bridge.close(); }
});

test("Product E2E Adapter 2.0调用真实队列接口并要求六类商用证据", async () => {
  const evidence = Object.fromEntries(["queue", "worker", "recovery", "persistence", "audit", "archive"]
    .map((name) => [name, { recorded: true, ref: `${name}:fixture` }]));
  const requests = [];
  const bridgeRegistry = new ProductToolBridgeRegistry();
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null });
    response.setHeader("content-type", "application/json");
    if (request.method === "POST") {
      const bridgeToken = requests.at(-1).body.tool_bridge.authorization.replace("Bearer ", "");
      requests.at(-1).bridgeResult = await bridgeRegistry.invoke(bridgeToken, { trial_id: "trial-product-1",
        contract_digest: "sha256:contract", tool_name: "query_logs", arguments: { tenant: "tenant-a" } });
      return response.end(JSON.stringify({ adapter_contract_version: "2.0",
        evaluation_lane: "PRODUCT_E2E", eval_run_id: "trial-product-1", status: "QUEUED" }));
    }
    return response.end(JSON.stringify({ adapter_contract_version: "2.0", evaluation_lane: "PRODUCT_E2E",
      eval_run_id: "trial-product-1", status: "COMPLETED", product_evidence: evidence,
      outcome: { status: "resolved", root_cause: "verified-product-result", evidence_refs: ["audit:fixture"] },
      trace_events: [{ name: "product.worker.completed", payload: { durable: true } }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const adapter = createProductE2EAdapter({ id: "agent-harness-v2", endpoint: `http://127.0.0.1:${address.port}`,
      token: "fixture-token", bridgeRegistry, bridgePublicOrigin: "http://127.0.0.1:8787",
      pollIntervalMs: 1, requestTimeoutMs: 5000 });
    const emitted = [];
    const outcome = await adapter.execute({ trial: { id: "trial-product-1" },
      executionContract: { evaluation_lane: "PRODUCT_E2E", contract_digest: "sha256:contract",
        tools: [{ name: "query_logs" }] }, toolExecutor: async (name, args) => ({ ok: true, name, args }),
      emit: async (...args) => emitted.push(args) });
    assert.equal(outcome.status, "resolved");
    assert.deepEqual(Object.keys(outcome.product_evidence).sort(), Object.keys(evidence).sort());
    assert.deepEqual(requests.map((item) => item.method), ["POST", "GET"]);
    assert.equal(requests.every((item) => item.authorization === "Bearer fixture-token"), true);
    assert.deepEqual(requests[0].bridgeResult, { status: 200,
      body: { ok: true, name: "query_logs", args: { tenant: "tenant-a" } } });
    assert.equal(JSON.stringify(emitted).includes("fixture-token"), false);
    assert.ok(emitted.some(([name]) => name === "product.e2e.evidence"));
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("V1参数化变更通过独立ActionRuntime调用Harness桥而不伪装成只读MCP", () => {
  const runnerSource = readFileSync(new URL("../python/langgraph_runner.py", import.meta.url), "utf8");
  assert.match(runnerSource, /ActionRuntime\(\)/);
  assert.match(runnerSource, /ActionHandler\(/);
  assert.match(runnerSource, /if definition\.get\("read_only", True\) is False:\s+continue/);
  assert.match(runnerSource, /call_harness_tool\(tool_name, dict\(proposal\.parameters\)\)/);
  assert.match(runnerSource, /deferred_to_harness_trial_reset/);
});

test("V1选错不存在工具被记录为能力失败而非Runner基础设施失败", () => {
  assert.equal(isLangGraphCapabilityFailure("ToolNotFoundError: query_probe"), true);
  assert.equal(isLangGraphCapabilityFailure("HTTP 503 connection reset"), false);
  const outcome = langGraphCapabilityFailureOutcome("ToolNotFoundError: query_probe", ["run_probe", "query_logs"]);
  assert.equal(outcome.status, "inconclusive");
  assert.match(outcome.root_cause, /invalid-tool-selection/);
  assert.deepEqual(outcome.evidence_refs, []);
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

test("Agent通用合同明确主动风险状态与Bash相对路径边界", () => {
  const source = readFileSync(new URL("../src/deepseek-claude-adapter.mjs", import.meta.url), "utf8");
  const langGraphSource = readFileSync(new URL("../python/langgraph_runner.py", import.meta.url), "utf8");
  assert.match(source, /risk_detected whenever a proactive future risk was established/);
  assert.match(source, /Use relative paths only; never reference an absolute path or '\.\.'/);
  assert.match(source, /Observe or change the Twin exclusively through the provided OpsMind MCP tools/);
  for (const contractSource of [source, langGraphSource]) {
    assert.match(contractSource, /最小处置并复核/);
    assert.match(contractSource, /root_cause 或 summary 使用了某个观测或数据源失败/);
  }
});

test("Adapter 2.0资格把能力、任务、安全、恢复和动作审批都设为硬门禁", () => {
  const source = readFileSync(new URL("../../../scripts/run-m3-adapter-qualification.mjs", import.meta.url), "utf8");
  assert.match(source, /all_capability_code_grades_passed/);
  assert.match(source, /all_environment_tasks_succeeded/);
  assert.match(source, /all_safety_hard_gates_passed/);
  assert.match(source, /tool_failure_recovery_proved/);
  assert.match(source, /timeout_recovery_proved/);
  assert.match(source, /frozen_harness_action_approval_proved/);
  assert.match(source, /twinPreflight\.active_trial/);
  assert.match(source, /未创建任何 Trial/);
  assert.doesNotMatch(source, /not_qualification_veto/);
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
