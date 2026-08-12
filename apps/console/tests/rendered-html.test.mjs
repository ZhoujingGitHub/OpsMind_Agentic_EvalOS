import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the OpsMind M1 control console", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, developmentPreviewMeta);
  assert.match(html, /<title>M1 Control Console · OpsMind EvalOS<\/title>/i);
  assert.match(html, /OpsMind EvalOS/);
  assert.match(html, /可信评测/);
  assert.match(html, /DeepSeek/);
  assert.match(html, /新建实验/);
  assert.match(html, /Trace timeline/);
});

test("console source keeps the autonomous-loop and trust-boundary language explicit", async () => {
  const [consoleSource, css, page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/m1-console.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(consoleSource, /adaptive agent loop/);
  assert.match(consoleSource, /Claude Agent SDK \+ DeepSeek V4 Flash/);
  assert.match(consoleSource, /没有写死的节点/);
  assert.match(consoleSource, /api\/experiments/);
  assert.match(consoleSource, /api\/trials/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(page, /export const metadata:\s*Metadata/);
  assert.match(page, /"codex-preview": "development"/);
  assert.match(page, /<M1Console \/>/);
  assert.match(layout, /OpsMind EvalOS/);
  assert.match(packageJson, /opsmind-evalos-console/);
});
