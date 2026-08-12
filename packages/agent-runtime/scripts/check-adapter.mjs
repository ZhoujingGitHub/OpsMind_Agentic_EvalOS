import { DEEPSEEK_AGENT_RUNTIME } from "../src/index.mjs";

const [sdk, zod] = await Promise.all([
  import("@anthropic-ai/claude-agent-sdk"),
  import("zod"),
]);

const checks = {
  query: typeof sdk.query === "function",
  tool: typeof sdk.tool === "function",
  createSdkMcpServer: typeof sdk.createSdkMcpServer === "function",
  zod: typeof zod.z.object === "function",
  model: DEEPSEEK_AGENT_RUNTIME.model === "deepseek-v4-flash",
  anthropicInterface: DEEPSEEK_AGENT_RUNTIME.baseUrl === "https://api.deepseek.com/anthropic",
  noGraphFramework: DEEPSEEK_AGENT_RUNTIME.graphFramework === null,
};

if (!Object.values(checks).every(Boolean)) {
  console.error(JSON.stringify({ status: "FAILED", checks }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ status: "PASSED", runtime: DEEPSEEK_AGENT_RUNTIME, checks }, null, 2));

