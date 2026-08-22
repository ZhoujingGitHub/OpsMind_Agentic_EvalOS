import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CandidateRelayBroker, EvalStore, EvaluationLedger, relaySignaturePayload } from "../src/index.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-candidate-relay-"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const store = new EvalStore({ databasePath: path.join(root, "control.sqlite"), runtimeRoot: root,
    migrationPath: path.join(ROOT, "infra", "migrations", "sqlite", "001_m15.sql"),
    migrationPaths: [
      path.join(ROOT, "infra", "migrations", "sqlite", "002_m25_workbench.sql"),
      path.join(ROOT, "infra", "migrations", "sqlite", "003_m26_run_control.sql"),
      path.join(ROOT, "infra", "migrations", "sqlite", "004_m31_candidate_relay.sql"),
    ] });
  const ledger = new EvaluationLedger(store);
  const broker = new CandidateRelayBroker({ store, ledger, pollIntervalMs: 5, candidates: {
    "candidate-real": { public_key_pem: publicKey.export({ type: "spki", format: "pem" }),
      allowed_paths: ["^/api/health$", "^/api/jobs(?:\\?.*)?$"] },
  } });
  return { store, ledger, broker, privateKey };
}

function signedHeaders(privateKey, pathname, rawBody) {
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const payload = relaySignaturePayload({ method: "POST", pathname, timestamp, nonce, rawBody });
  return new Headers({ "x-evalos-relay-timestamp": timestamp, "x-evalos-relay-nonce": nonce,
    "x-evalos-relay-signature": sign(null, Buffer.from(payload), privateKey).toString("base64") });
}

test("候选中继使用签名、一次性nonce、白名单和不可变审计记录", async () => {
  const { store, ledger, broker, privateKey } = fixture();
  try {
    const rawBody = JSON.stringify({ worker_id: "worker-1", lease_ms: 30000 });
    const pathname = "/api/candidate-relay/candidate-real/claim";
    const headers = signedHeaders(privateKey, pathname, rawBody);
    assert.equal(broker.authenticate({ candidateRef: "candidate-real", method: "POST", pathname, headers, rawBody }), true);
    assert.throws(() => broker.authenticate({ candidateRef: "candidate-real", method: "POST", pathname, headers, rawBody }), /replayed/);
    await assert.rejects(() => broker.request("candidate-real", "candidate_submitter", "/private/admin"), /not allowlisted/);

    const pending = broker.request("candidate-real", "candidate_submitter", "/api/jobs?limit=1", {
      headers: { "x-tenant-id": "tenant-eval" }, timeoutMs: 1000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const claimed = broker.claim("candidate-real", { worker_id: "worker-1", lease_ms: 30000 });
    assert.equal(claimed.credential_role, "candidate_submitter");
    assert.equal(claimed.pathname, "/api/jobs?limit=1");
    broker.complete("candidate-real", claimed.id, { worker_id: "worker-1", response_status: 200,
      response_body: { ok: true, source: "real-product" } });
    assert.deepEqual(await pending, { ok: true, source: "real-product" });
    assert.equal(ledger.verify().valid, true);
    assert.throws(() => store.db.prepare("DELETE FROM candidate_relay_requests WHERE id=?").run(claimed.id), /append-only/);
  } finally { store.close(); }
});
