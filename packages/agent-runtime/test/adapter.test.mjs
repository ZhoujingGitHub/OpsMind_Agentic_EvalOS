import assert from "node:assert/strict";
import test from "node:test";
import { DEEPSEEK_AGENT_RUNTIME, deepSeekEnvironment } from "../src/index.mjs";

test("runtime uses Claude Agent SDK over DeepSeek Anthropic endpoint without a graph framework", () => {
  assert.equal(DEEPSEEK_AGENT_RUNTIME.sdk, "@anthropic-ai/claude-agent-sdk");
  assert.equal(DEEPSEEK_AGENT_RUNTIME.model, "deepseek-v4-flash");
  assert.equal(DEEPSEEK_AGENT_RUNTIME.baseUrl, "https://api.deepseek.com/anthropic");
  assert.equal(DEEPSEEK_AGENT_RUNTIME.orchestration, "model-driven-tool-loop");
  assert.equal(DEEPSEEK_AGENT_RUNTIME.graphFramework, null);
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
