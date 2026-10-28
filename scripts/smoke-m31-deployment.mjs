import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const base = new URL(process.env.EVALOS_SMOKE_ORIGIN ?? "http://127.0.0.1:3000");
const checked = [];

async function get(pathname, expectedType = null) {
  const response = await fetch(new URL(pathname, base), { redirect: "manual" });
  assert.equal(response.status, 200, `${pathname} returned ${response.status}`);
  if (expectedType) assert.match(response.headers.get("content-type") ?? "", expectedType, `${pathname} content type`);
  checked.push(pathname);
  return response;
}

async function waitForHealthyPlatform(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastHealth = null;
  while (Date.now() < deadline) {
    const response = await fetch(new URL("/health", base), { redirect: "manual" });
    assert.equal(response.status, 200, `/health returned ${response.status}`);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/, "/health content type");
    lastHealth = await response.json();
    if (lastHealth.status === "ok") { checked.push("/health"); return lastHealth; }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  assert.fail(`platform did not recover to healthy state within ${timeoutMs}ms: ${JSON.stringify(lastHealth?.operations ?? lastHealth)}`);
}

const health = await waitForHealthyPlatform();
assert.equal(health.status, "ok");
const frozenManifest = JSON.parse(readFileSync(new URL("../config/m3-formal-agent-capability.manifest.json", import.meta.url), "utf8"));
assert.equal(health.milestone, frozenManifest.milestone);
assert.equal(typeof health.formal_run.enabled, "boolean", "the formal exam switch must be reported explicitly");

const overview = await (await get("/api/workbench/overview", /application\/json/)).json();
assert.equal(overview.contract, "evalos-workbench.4");
assert.equal(overview.platform.candidate_execution, "external-real-products-only");
assert.equal(overview.platform.workflow_graph, null);
assert.ok(overview.counts.datasets >= 1, "frozen datasets must be visible");
assert.ok(overview.counts.cases >= 1, "versioned cases must be visible");

const datasets = await (await get("/api/workbench/datasets", /application\/json/)).json();
const frozenBank = datasets.items.find((item) => item.dataset_ref === frozenManifest.dataset_ref);
assert.ok(frozenBank, "the frozen exam dataset must be visible after every deployment");
assert.equal(frozenBank.case_count, frozenManifest.case_refs.length, "the frozen dataset must expose every Case before the console starts");

const readiness = await (await get("/api/workbench/candidate-readiness", /application\/json/)).json();
assert.equal(readiness.contract, "evalos-candidate-readiness.1");
assert.equal(typeof readiness.formal_exam_enabled, "boolean");
assert.equal(readiness.items.length, 2);
assert.ok(readiness.items.every((item) => item.kind === "REAL_PRODUCT"), "formal candidates must be external real products");

for (const pathname of ["/", "/experiments", "/datasets", "/run-requests", "/traces", "/graders", "/analyses"]) {
  const html = await (await get(pathname, /text\/html/)).text();
  assert.match(html, /OpsMind|EvalOS/);
  assert.doesNotMatch(html, /Internal Server Error|Console upstream unavailable/);
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(scripts.length >= 2, `${pathname} must load browser bundles`);
  for (const script of scripts) await get(script, /javascript/);
}

console.log(JSON.stringify({ status: "PASSED", milestone: frozenManifest.milestone, origin: base.origin,
  checked: [...new Set(checked)], formal_exam_enabled: health.formal_run.enabled,
  candidate_execution: "external-real-products-only" }, null, 2));
