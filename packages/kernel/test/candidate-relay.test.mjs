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
      path.join(ROOT, "infra", "migrations", "sqlite", "010_m32_relay_transport_buffer.sql"),
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

const largeBody = (fill) => ({ rows: Array.from({ length: 4000 }, (_, index) => ({ index, value: fill.repeat(64) })) });

async function leaseOne(broker, pathname) {
  const pending = broker.request("candidate-real", "candidate_submitter", pathname, { timeoutMs: 2000 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { pending, claimed: broker.claim("candidate-real", { worker_id: "worker-1", lease_ms: 30000 }) };
}

test("大响应正文走传输缓冲，证据行只留摘要与长度，取走后缓冲清空", async () => {
  const { store, ledger, broker } = fixture();
  try {
    const body = largeBody("x");
    const { pending, claimed } = await leaseOne(broker, "/api/jobs");
    const buffered = () => store.db.prepare(
      "SELECT * FROM candidate_relay_response_bodies WHERE request_id=?").get(claimed.id);
    // No await between completing and reading, so the consumer cannot have run yet.
    broker.complete("candidate-real", claimed.id, { worker_id: "worker-1", response_status: 200, response_body: body });
    const stored = buffered();
    const row = store.db.prepare("SELECT * FROM candidate_relay_requests WHERE id=?").get(claimed.id);
    assert.equal(stored.bytes > 16 * 1024, true);
    const envelope = JSON.parse(row.response_body_json);
    assert.equal(envelope.__relay_response_body, "candidate-relay-response-body/1.0");
    assert.equal(envelope.bytes, stored.bytes);
    assert.equal(envelope.sha256, stored.sha256);
    assert.equal(row.response_body_json.length < 256, true);
    assert.deepEqual(await pending, body);
    assert.equal(buffered(), undefined);
    assert.equal(ledger.verify().valid, true);
    // The boundary record itself is still append-only evidence.
    assert.throws(() => store.db.prepare("DELETE FROM candidate_relay_requests WHERE id=?").run(claimed.id), /append-only/);
  } finally { store.close(); }
});

test("小响应正文继续内联，不进传输缓冲", async () => {
  const { store, broker } = fixture();
  try {
    const body = { ok: true };
    const { pending, claimed } = await leaseOne(broker, "/api/health");
    broker.complete("candidate-real", claimed.id, { worker_id: "worker-1", response_status: 200, response_body: body });
    assert.equal(store.db.prepare("SELECT count(*) AS total FROM candidate_relay_response_bodies").get().total, 0);
    assert.deepEqual(await pending, body);
  } finally { store.close(); }
});

test("没人取走的传输缓冲会被清扫，证据行不受影响", async () => {
  const { store, broker } = fixture();
  try {
    const { pending, claimed } = await leaseOne(broker, "/api/jobs");
    broker.complete("candidate-real", claimed.id, { worker_id: "worker-1", response_status: 200, response_body: largeBody("y") });
    await pending;
    store.db.prepare(`INSERT INTO candidate_relay_response_bodies(request_id,body_json,bytes,sha256,created_at)
      VALUES(?,?,?,?,?)`).run(claimed.id, "{}", 2, "z".repeat(64), "2026-01-01T00:00:00.000Z");
    assert.equal(broker.sweepAbandonedResponseBodies(), 1);
    const row = store.db.prepare("SELECT * FROM candidate_relay_requests WHERE id=?").get(claimed.id);
    assert.equal(row.status, "COMPLETED");
    assert.equal(JSON.parse(row.response_body_json).__relay_response_body, "candidate-relay-response-body/1.0");
  } finally { store.close(); }
});

test("没活干的取活会挂住等，不再让考生每半秒问一次", async () => {
  // 2026-09-22 实测：立即回"没有"的做法，让两个考生侧的工人每 0.5 秒问一次，
  // 一天 32 万次、两周 441 万次。考场与考生分属两个云账号，每一次问答都走
  // 公网、两边各自计费；还在只增不删的防重放表里留下 966 万行，这是 19 GB
  // 库的主要来源。其中 98.5% 的回答是"没有"。
  const { store, broker } = fixture();
  try {
    // 没活时不立刻回答，而是把问题攥住。
    const startedAt = Date.now();
    const empty = await broker.claimWaiting("candidate-real",
      { worker_id: "w", lease_ms: 30000 }, { waitMs: 120 });
    assert.equal(empty, null, "没活时仍然回答 null，考生侧一行都不用改");
    assert.ok(Date.now() - startedAt >= 100, "它必须真的等过，而不是立刻回答");

    // 来活了要立刻交出去，不用等这一轮攥满。
    const parked = broker.claimWaiting("candidate-real",
      { worker_id: "w", lease_ms: 30000 }, { waitMs: 5000 });
    const askedAt = Date.now();
    setTimeout(() => {
      broker.request("candidate-real", "candidate_submitter", "/api/health", { timeoutMs: 2000 })
        .catch(() => {});
    }, 20);
    const claimed = await parked;
    assert.ok(claimed, "来活之后这条挂住的取活必须拿到它");
    assert.equal(claimed.pathname, "/api/health");
    assert.ok(Date.now() - askedAt < 2000, "来活要立刻交，不能等攥满 5 秒");
    broker.complete("candidate-real", claimed.id,
      { worker_id: "w", response_status: 200, response_body: { ok: true } });

    // 攥的时长有上限，而且必须低于考生工人自己的 20 秒请求超时，
    // 否则考生会把正常的一次问答当成超时。
    const capped = new CandidateRelayBroker({ store, ledger: broker.ledger, claimWaitMs: 99000,
      candidates: {} });
    assert.ok(capped.claimWaitMs <= 18000, "攥的上限必须留在考生 20 秒超时之内");
    // 设成 0 就回到立刻回答的老行为，出事时可以一键退回。
    const off = new CandidateRelayBroker({ store, ledger: broker.ledger, claimWaitMs: 0, candidates: {} });
    assert.equal(off.claimWaitMs, 0);
  } finally { store.close(); }
});
