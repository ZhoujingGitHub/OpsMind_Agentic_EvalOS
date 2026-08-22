import assert from "node:assert/strict";

const base = new URL(process.env.EVALOS_SMOKE_ORIGIN ?? "http://127.0.0.1:3000");
const checked = [];

async function get(pathname, expectedType = null) {
  const response = await fetch(new URL(pathname, base), { redirect: "manual" });
  assert.equal(response.status, 200, `${pathname} returned ${response.status}`);
  if (expectedType) assert.match(response.headers.get("content-type") ?? "", expectedType, `${pathname} content type`);
  checked.push(pathname);
  return response;
}

const health = await (await get("/health", /application\/json/)).json();
assert.equal(health.status, "ok");
assert.equal(health.milestone, "M3.1");
assert.equal(health.formal_run.enabled, false, "formal 480 Trial must remain disabled");

const overview = await (await get("/api/workbench/overview", /application\/json/)).json();
assert.equal(overview.contract, "evalos-workbench.4");
assert.equal(overview.platform.candidate_execution, "external-real-products-only");
assert.equal(overview.platform.workflow_graph, null);
assert.ok(overview.counts.datasets >= 1, "frozen datasets must be visible");
assert.ok(overview.counts.cases >= 1, "versioned cases must be visible");

const readiness = await (await get("/api/workbench/candidate-readiness", /application\/json/)).json();
assert.equal(readiness.contract, "evalos-candidate-readiness.1");
assert.equal(readiness.formal_480_enabled, false);
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

console.log(JSON.stringify({ status: "PASSED", milestone: "M3.1", origin: base.origin,
  checked: [...new Set(checked)], formal_480_enabled: false, candidate_execution: "external-real-products-only" }, null, 2));
