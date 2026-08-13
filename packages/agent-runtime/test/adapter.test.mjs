import assert from "node:assert/strict";
import test from "node:test";
import { BLIND_JUDGE_RUNTIME, DEEPSEEK_AGENT_RUNTIME, LANGGRAPH_RUNTIME, blindJudgePromptMaterial, deepSeekEnvironment } from "../src/index.mjs";
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

test("V1 comparison adapter is explicitly a real LangGraph StateGraph runtime", () => {
  assert.equal(LANGGRAPH_RUNTIME.architecture, "LANGGRAPH_V1");
  assert.equal(LANGGRAPH_RUNTIME.orchestration, "real-stategraph");
  assert.equal(LANGGRAPH_RUNTIME.model, "deepseek-v4-flash");
});

test("DeepSeek environment keeps credentials in memory and maps the exact model", () => {
  const env = deepSeekEnvironment({ apiKey: "test-runtime-only", model: "deepseek-v4-flash" });
  assert.equal(env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "test-runtime-only");
  assert.equal(env.ANTHROPIC_MODEL, "deepseek-v4-flash");
  assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, "max");
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

test("blind Judge prompt omits contestant architecture identity", () => {
  const material = blindJudgePromptMaterial(CASES["PILOT-REG-001"], {
    status: "resolved",
    root_cause: "udm-subscriber-provisioning",
    evidence_refs: ["log:amf-reg-101"],
  });
  const text = JSON.stringify(material);
  assert.equal(text.includes("agent-harness-v2"), false);
  assert.equal(text.includes("langgraph-v1"), false);
  assert.equal(BLIND_JUDGE_RUNTIME.blind, true);
  assert.deepEqual(BLIND_JUDGE_RUNTIME.tools, []);
});
