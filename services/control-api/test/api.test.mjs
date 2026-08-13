import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const manifest = JSON.parse(readFileSync(path.join(ROOT, "config", "m1-smoke.manifest.json"), "utf8"));

test("control API creates idempotent experiment, runs Trials, streams redacted Trace, and verifies Ledger", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-api-"));
  const app = createApp({ databasePath: path.join(root, "api.sqlite"), runtimeRoot: root, artifactsRoot: root });
  try {
    const health = await app.handler(new Request("http://local/health"));
    assert.equal(health.status, 200);
    const capabilities = await (await app.handler(new Request("http://local/api/runtime/capabilities"))).json();
    assert.equal(capabilities.runtime.model, "deepseek-v4-flash");
    assert.equal(capabilities.runtime.graphFramework, null);
    assert.equal(capabilities.live_deepseek_enabled, false);
    const create = () => app.handler(new Request("http://local/api/experiments", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "api-idem" },
      body: JSON.stringify({ manifest }),
    }));
    const first = await create();
    const firstBody = await first.json();
    assert.equal(first.status, 201);
    const second = await create();
    assert.equal(second.status, 200);
    assert.equal((await second.json()).created, false);

    const run = await app.handler(new Request(`http://local/api/experiments/${firstBody.experiment.id}/run`, { method: "POST" }));
    const runBody = await run.json();
    assert.equal(runBody.executed, 12);
    assert.equal(runBody.summary.completed_trials, 12);
    const detail = await (await app.handler(new Request(`http://local/api/experiments/${firstBody.experiment.id}`))).json();
    assert.equal(detail.trials.length, 12);
    assert.equal(Object.hasOwn(detail.trials[0], "contestant_id"), false);

    const trialId = detail.trials[0].id;
    const stream = await app.handler(new Request(`http://local/api/trials/${trialId}/trace`, { headers: { accept: "text/event-stream" } }));
    assert.match(stream.headers.get("content-type"), /text\/event-stream/);
    const streamText = await stream.text();
    assert.match(streamText, /event: trace/);
    assert.match(streamText, /event: heartbeat/);
    assert.doesNotMatch(streamText, /fixture-secret-must-not-persist/);
    const verify = await (await app.handler(new Request("http://local/api/ledger/verify"))).json();
    assert.equal(verify.valid, true);
  } finally {
    app.close();
  }
});

test("server entrypoint accepts environment-selected formal M1 storage", () => {
  const source = readFileSync(path.join(ROOT, "services/control-api/src/server.mjs"), "utf8");
  assert.match(source, /EVALOS_DATABASE_PATH/);
  assert.match(source, /EVALOS_RUNTIME_ROOT/);
  assert.match(source, /EVALOS_ARTIFACTS_ROOT/);
});
