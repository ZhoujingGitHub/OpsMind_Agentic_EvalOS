import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("server-renders the complete four-product architecture atlas", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<html[^>]*lang="zh-CN"/i);
  assert.match(html, /OpsMind 四系统架构图谱/);
  assert.match(html, /四方协作总图/);
  assert.match(html, /30 个业务 MCP/);
  assert.match(html, /17 个 Skills/);
  assert.match(html, /14 个 StateGraph 节点/);
  assert.match(html, /general-investigation@1\.0\.0/);
  assert.match(html, /PreToolUse Hook/);
  assert.match(html, /Case AI 调查员：11 个 MCP/);
  assert.match(html, /8 类只读观测 MCP/);
  assert.match(html, /9 类通用参数化变更 MCP/);
  assert.match(html, /EvalOS 当前到 M2\.6/);
  assert.match(html, /480 Trial/);
  assert.doesNotMatch(html, /react-loading-skeleton|Your site is taking shape/);
});
