import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { relaySignaturePayload } from "../../../packages/kernel/src/index.mjs";
import { createApp } from "../src/app.mjs";

function signedRequest(url, body, privateKey) {
  const rawBody = JSON.stringify(body);
  const pathname = new URL(url).pathname;
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const payload = relaySignaturePayload({ method: "POST", pathname, timestamp, nonce, rawBody });
  const headers = { "content-type": "application/json", "x-evalos-relay-timestamp": timestamp,
    "x-evalos-relay-nonce": nonce, "x-evalos-relay-signature": sign(null, Buffer.from(payload), privateKey).toString("base64") };
  return new Request(url, { method: "POST", headers, body: rawBody });
}

test("产品侧出站中继只能以登记公钥签名领取任务，且签名不可重放", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-relay-api-"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const app = createApp({ databasePath: path.join(root, "control.sqlite"),
    privateLabelDatabasePath: path.join(root, "private.sqlite"), runtimeRoot: root, apiToken: "admin-secret",
    candidateRelayConfig: { candidates: { "agent-harness-v2": { tenant_id: "tenant-ctyun-ops-demo",
      public_key_pem: publicKey.export({ type: "spki", format: "pem" }),
      deployment_attestation: { contract_version: "evalos-deployment-attestation/1.0",
        source_revision: "a".repeat(40), artifact_digest: `sha256:${"b".repeat(64)}`,
        verification_method: "evalos_trusted_read_only_git_oci", verified_evidence_ref: "test-read-only-proof" },
    } } } });
  try {
    const url = "http://local/api/candidate-relay/agent-harness-v2/claim";
    const body = { worker_id: "product-worker-1", lease_ms: 30000 };
    const request = signedRequest(url, body, privateKey);
    const response = await app.handler(request.clone());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { request: null });
    const replay = await app.handler(request.clone());
    assert.equal(replay.status, 400);
    assert.match((await replay.json()).error, /replayed/);
    const forged = signedRequest(url, body, generateKeyPairSync("ed25519").privateKey);
    assert.equal((await app.handler(forged)).status, 400);
  } finally { app.close(); }
});
