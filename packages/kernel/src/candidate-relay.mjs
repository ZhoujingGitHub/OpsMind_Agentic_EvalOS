import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { isoNow, sha256, stableStringify } from "./utils.mjs";

const ROLES = new Set(["candidate_submitter", "approval_oracle", "mode_administrator"]);
const METHODS = new Set(["GET", "POST", "PUT"]);
// A relay row records who called what and the hashes of what crossed the
// boundary. A large response body is transport payload, not that record, so it
// is handed over through a mutable buffer and dropped once the caller has it.
const INLINE_RESPONSE_BODY_LIMIT = 16 * 1024;
const EXTERNAL_BODY_MARKER = "candidate-relay-response-body/1.0";
const ABANDONED_BODY_MS = 3600000;

function externalBodyEnvelope(body) {
  return stableStringify({ __relay_response_body: EXTERNAL_BODY_MARKER,
    sha256: sha256(body ?? {}), bytes: Buffer.byteLength(jsonValue(body) ?? "", "utf8") });
}

function externalBodyReference(stored) {
  const value = parseJson(stored, null);
  return value?.__relay_response_body === EXTERNAL_BODY_MARKER ? value : null;
}

function bodyHash(rawBody) {
  return createHash("sha256").update(rawBody).digest("hex");
}

function canonicalSignature(method, pathname, timestamp, nonce, rawBody) {
  return `${method}\n${pathname}\n${timestamp}\n${nonce}\n${bodyHash(rawBody)}`;
}

function jsonValue(value) {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" ? value : stableStringify(value);
}

function parseJson(value, fallback = {}) {
  try { return value === null || value === undefined ? fallback : JSON.parse(value); }
  catch { return fallback; }
}

// How long a claim with nothing to hand out is allowed to wait before it
// answers "nothing yet".
//
// Why this exists: with an immediate answer, the worker beside each candidate
// had to ask again straight away, and it asked every 0.5 s around the clock.
// Measured on 2026-09-22: 4 asks a second, 320 thousand a day, 4.4 million over
// a fortnight — and because the exam and the candidates live in two different
// cloud accounts, every one of those asks crossed the public network and was
// billed on both sides. It also left 9.67 million anti-replay rows in an
// append-only table, which is most of why the database reached 19 GB.
//
// 98.5% of that was the answer "nothing". Holding the question instead of
// answering it removes exactly that: one held question covers fifteen seconds.
// The cap stays below the worker's own 20 s request timeout so the worker needs
// no change at all, and work is handed over the instant it arrives rather than
// on the next poll — so this is faster, not slower.
const DEFAULT_CLAIM_WAIT_MS = 15000;
const MAX_CLAIM_WAIT_MS = 18000;

// How long a used nonce is kept after it stops being checkable. One hour is
// twelve times the five-minute signature window, so clock skew or a paused
// process cannot turn the sweep into a replay hole. The matching trigger in
// 011_m32_relay_nonce_retention.sql still refuses to delete anything newer.
const NONCE_RETENTION_MS = 3600000;
// Rows per sweep. The backlog on 2026-09-23 was ten million; deleting that in
// one statement would hold a write lock long enough to stall a running trial.
const NONCE_SWEEP_LIMIT = 20000;
// Sweeping on every claim would be wasteful now that claims are parked rather
// than polled, so it runs at most this often.
const NONCE_SWEEP_INTERVAL_MS = 60000;

export class CandidateRelayBroker {
  constructor({ store, ledger, candidates = {}, pollIntervalMs = 100, signatureWindowMs = 300000,
    claimWaitMs = DEFAULT_CLAIM_WAIT_MS }) {
    this.store = store;
    this.ledger = ledger;
    this.pollIntervalMs = pollIntervalMs;
    this.signatureWindowMs = signatureWindowMs;
    this.claimWaitMs = Math.min(Math.max(Number(claimWaitMs) || 0, 0), MAX_CLAIM_WAIT_MS);
    // One entry per candidate holding the resolvers of the claims parked on it.
    this.claimWaiters = new Map();
    this.lastNonceSweepAt = 0;
    this.candidates = Object.fromEntries(Object.entries(candidates).map(([ref, item]) => [ref, {
      ...item,
      publicKey: createPublicKey(item.public_key_pem),
    }]));
  }

  hasCandidate(candidateRef) { return Boolean(this.candidates[candidateRef]); }

  candidate(candidateRef) {
    const item = this.candidates[candidateRef];
    if (!item) throw new Error(`candidate relay is not registered: ${candidateRef}`);
    return item;
  }

  authenticate({ candidateRef, method, pathname, headers, rawBody }) {
    const item = this.candidate(candidateRef);
    const timestamp = headers.get("x-evalos-relay-timestamp");
    const nonce = headers.get("x-evalos-relay-nonce");
    const signature = headers.get("x-evalos-relay-signature");
    const signedAt = Number(timestamp);
    if (!timestamp || !nonce || !signature || !Number.isFinite(signedAt) || Math.abs(Date.now() - signedAt) > this.signatureWindowMs) {
      throw new Error("candidate relay signature is missing or outside the allowed time window");
    }
    const message = Buffer.from(canonicalSignature(method, pathname, timestamp, nonce, rawBody));
    let signatureBytes;
    try { signatureBytes = Buffer.from(signature, "base64"); }
    catch { throw new Error("candidate relay signature is not valid base64"); }
    if (!verify(null, message, item.publicKey, signatureBytes)) throw new Error("candidate relay signature verification failed");
    try {
      this.store.db.prepare(`INSERT INTO candidate_relay_nonces(candidate_ref,nonce,signed_at,received_at)
        VALUES(?,?,?,?)`).run(candidateRef, nonce, new Date(signedAt).toISOString(), isoNow());
    } catch (error) {
      if (/UNIQUE constraint failed/.test(String(error?.message))) throw new Error("candidate relay nonce was replayed");
      throw error;
    }
    return true;
  }

  async request(candidateRef, credentialRole, pathname, { method = "GET", body, headers = {}, timeoutMs = 30000 } = {}) {
    const normalizedMethod = String(method).toUpperCase();
    if (!ROLES.has(credentialRole)) throw new Error(`unsupported candidate credential role: ${credentialRole}`);
    if (!METHODS.has(normalizedMethod)) throw new Error(`unsupported candidate relay method: ${normalizedMethod}`);
    if (!pathname.startsWith("/") || pathname.includes("..") || pathname.includes("\\")) {
      throw new Error("candidate relay pathname must be an absolute safe API path");
    }
    const candidate = this.candidate(candidateRef);
    const allowed = candidate.allowed_paths ?? [];
    if (!allowed.some((pattern) => new RegExp(pattern).test(pathname))) {
      throw new Error(`candidate relay path is not allowlisted: ${normalizedMethod} ${pathname}`);
    }
    const id = `relay_${randomUUID().replaceAll("-", "")}`;
    const createdAt = isoNow();
    const bodyJson = jsonValue(body);
    const requestHash = sha256({ candidate_ref: candidateRef, credential_role: credentialRole,
      method: normalizedMethod, pathname, headers, body: body ?? null });
    this.store.db.prepare(`INSERT INTO candidate_relay_requests(
      id,candidate_ref,credential_role,method,pathname,headers_json,request_body_json,request_hash,status,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, candidateRef, credentialRole, normalizedMethod, pathname,
      stableStringify(headers), bodyJson, requestHash, "QUEUED", createdAt);
    this.ledger.append({ entityType: "candidate_relay_request", entityId: id, action: "candidate_relay.queued",
      payload: { candidate_ref: candidateRef, credential_role: credentialRole, method: normalizedMethod,
        pathname, request_hash: requestHash } });
    // Hand it over to a parked claim immediately; queueing is the only thing
    // that can turn "nothing yet" into work, so this is the only wake needed.
    this.wakeClaimWaiters(candidateRef);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const row = this.store.db.prepare("SELECT * FROM candidate_relay_requests WHERE id=?").get(id);
      if (row?.status === "COMPLETED") {
        const payload = this.takeResponseBody(row);
        if (row.response_status < 200 || row.response_status >= 300) {
          const code = payload?.detail?.code ?? payload?.error?.code ?? payload?.detail ?? "request_failed";
          throw new Error(`candidate product ${normalizedMethod} ${pathname} HTTP ${row.response_status}: ${typeof code === "string" ? code : JSON.stringify(code)}`);
        }
        return payload;
      }
      if (["FAILED", "EXPIRED"].includes(row?.status)) throw new Error(row.error ?? `candidate relay request ${row.status.toLowerCase()}`);
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    const result = this.store.db.prepare(`UPDATE candidate_relay_requests SET status='EXPIRED',error=?,completed_at=?
      WHERE id=? AND status IN ('QUEUED','LEASED')`).run("candidate relay response timed out", isoNow(), id);
    if (result.changes) this.ledger.append({ entityType: "candidate_relay_request", entityId: id,
      action: "candidate_relay.expired", payload: { candidate_ref: candidateRef, request_hash: requestHash } });
    throw new Error(`candidate relay timed out after ${timeoutMs}ms`);
  }

  takeResponseBody(row) {
    // The immutable evidence row keeps the envelope with hash and length; the
    // body itself is collected once and then removed from the buffer.
    const reference = externalBodyReference(row.response_body_json);
    if (!reference) return parseJson(row.response_body_json, {});
    const stored = this.store.db.prepare(
      "SELECT body_json FROM candidate_relay_response_bodies WHERE request_id=?").get(row.id);
    if (!stored) {
      throw new Error(`candidate relay response body is no longer available: ${row.id}`);
    }
    const payload = parseJson(stored.body_json, {});
    this.store.db.prepare("DELETE FROM candidate_relay_response_bodies WHERE request_id=?").run(row.id);
    return payload;
  }

  /**
   * Drop nonces that have aged out of the replay window.
   *
   * A nonce is only ever consulted for a request whose signed timestamp is
   * inside the signature window; past that, the timestamp check refuses the
   * request before the lookup happens, so an expired nonce can prove nothing.
   * Keeping them cost 1.9 GB and ten million rows by 2026-09-23.
   *
   * Deletion is bounded on purpose. The backlog was ten million rows, and
   * removing that in one statement would hold a write lock long enough to
   * stall a running trial. Each pass takes a slice; the table drains over a
   * few hours and then stays small on its own.
   */
  sweepExpiredNonces({ retentionMs = NONCE_RETENTION_MS, limit = NONCE_SWEEP_LIMIT } = {}) {
    const cutoff = new Date(Date.now() - retentionMs).toISOString();
    return this.store.db.prepare(`DELETE FROM candidate_relay_nonces WHERE rowid IN (
      SELECT rowid FROM candidate_relay_nonces WHERE received_at<? LIMIT ?)`)
      .run(cutoff, limit).changes;
  }

  sweepExpiredNoncesIfDue() {
    if (Date.now() - this.lastNonceSweepAt < NONCE_SWEEP_INTERVAL_MS) return 0;
    this.lastNonceSweepAt = Date.now();
    // A failed sweep must never fail the claim it rode in on: housekeeping is
    // not part of the contract between the exam and a candidate.
    try { return this.sweepExpiredNonces(); } catch { return 0; }
  }

  sweepAbandonedResponseBodies() {
    const cutoff = new Date(Date.now() - ABANDONED_BODY_MS).toISOString();
    return this.store.db.prepare(
      "DELETE FROM candidate_relay_response_bodies WHERE created_at<?").run(cutoff).changes;
  }

  wakeClaimWaiters(candidateRef) {
    const parked = this.claimWaiters.get(candidateRef);
    if (!parked?.size) return 0;
    const woken = parked.size;
    for (const resolve of [...parked]) resolve();
    parked.clear();
    return woken;
  }

  /**
   * Claim work, waiting quietly instead of answering "nothing yet".
   *
   * If there is work it is handed over at once, exactly as before. If there is
   * not, the question is parked until work arrives or the wait runs out, and
   * only then answered. The answer is the same in both cases, so the worker
   * asking cannot tell the difference — it simply stops having to ask 120
   * times a minute to find out nothing changed.
   */
  async claimWaiting(candidateRef, params = {}, { waitMs = this.claimWaitMs } = {}) {
    const first = this.claim(candidateRef, params);
    if (first || !(waitMs > 0)) return first;
    const parked = this.claimWaiters.get(candidateRef) ?? new Set();
    this.claimWaiters.set(candidateRef, parked);
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        parked.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      // Never hold the process open for a parked claim: a shutdown mid-wait is
      // an answer of "nothing", not a hang.
      timer.unref?.();
      parked.add(finish);
    });
    // Ask once more on the way out. A wake means work arrived; a timeout means
    // it probably did not, but the queue is cheap to re-read and racing a wake
    // against the timer must never drop a request on the floor.
    return this.claim(candidateRef, params);
  }

  claim(candidateRef, { worker_id: workerId, lease_ms: leaseMs = 30000 } = {}) {
    this.sweepAbandonedResponseBodies();
    this.sweepExpiredNoncesIfDue();
    if (!workerId || !Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 120000) {
      throw new Error("candidate relay claim requires worker_id and lease_ms between 1000 and 120000");
    }
    this.candidate(candidateRef);
    const now = isoNow();
    this.store.db.prepare(`UPDATE candidate_relay_requests SET status='QUEUED',lease_owner=NULL,lease_expires_at=NULL
      WHERE candidate_ref=? AND status='LEASED' AND lease_expires_at<?`).run(candidateRef, now);
    const row = this.store.transaction(() => {
      const queued = this.store.db.prepare(`SELECT id FROM candidate_relay_requests
        WHERE candidate_ref=? AND status='QUEUED' ORDER BY created_at LIMIT 1`).get(candidateRef);
      if (!queued) return null;
      const expires = new Date(Date.now() + leaseMs).toISOString();
      this.store.db.prepare(`UPDATE candidate_relay_requests SET status='LEASED',lease_owner=?,lease_expires_at=?,attempt=attempt+1
        WHERE id=? AND status='QUEUED'`).run(workerId, expires, queued.id);
      return this.store.db.prepare("SELECT * FROM candidate_relay_requests WHERE id=?").get(queued.id);
    });
    if (!row) return null;
    this.ledger.append({ entityType: "candidate_relay_request", entityId: row.id, action: "candidate_relay.leased",
      payload: { candidate_ref: candidateRef, worker_id: workerId, attempt: row.attempt } });
    return { id: row.id, credential_role: row.credential_role, method: row.method, pathname: row.pathname,
      headers: parseJson(row.headers_json, {}), body: parseJson(row.request_body_json, null), request_hash: row.request_hash,
      lease_expires_at: row.lease_expires_at };
  }

  complete(candidateRef, requestId, { worker_id: workerId, response_status: responseStatus, response_body: responseBody, error = null } = {}) {
    const row = this.store.db.prepare("SELECT * FROM candidate_relay_requests WHERE id=? AND candidate_ref=?").get(requestId, candidateRef);
    if (!row || row.status !== "LEASED" || row.lease_owner !== workerId) throw new Error("candidate relay lease is missing or owned by another worker");
    const status = error ? "FAILED" : "COMPLETED";
    const body = error ? null : jsonValue(responseBody ?? {});
    const external = body !== null && Buffer.byteLength(body, "utf8") > INLINE_RESPONSE_BODY_LIMIT;
    this.store.transaction(() => {
      if (external) {
        this.store.db.prepare(`INSERT OR REPLACE INTO candidate_relay_response_bodies(
          request_id,body_json,bytes,sha256,created_at) VALUES(?,?,?,?,?)`).run(
          requestId, body, Buffer.byteLength(body, "utf8"), sha256(responseBody ?? {}), isoNow());
      }
      this.store.db.prepare(`UPDATE candidate_relay_requests SET status=?,response_status=?,response_body_json=?,error=?,completed_at=?
        WHERE id=? AND status='LEASED' AND lease_owner=?`).run(status, error ? null : Number(responseStatus),
        external ? externalBodyEnvelope(responseBody ?? {}) : body, error, isoNow(), requestId, workerId);
    });
    this.ledger.append({ entityType: "candidate_relay_request", entityId: requestId,
      action: error ? "candidate_relay.failed" : "candidate_relay.completed",
      payload: { candidate_ref: candidateRef, request_hash: row.request_hash,
        response_status: error ? null : Number(responseStatus), response_hash: error ? null : sha256(responseBody ?? {}),
        response_body_storage: external ? "transport_buffer" : "inline", error } });
    return { id: requestId, status };
  }

  transport(candidateRef) {
    this.candidate(candidateRef);
    return Object.freeze({
      origin: `relay://${candidateRef}`,
      credential_roles: [...ROLES],
      request: (credentialRole, pathname, options = {}) => this.request(candidateRef, credentialRole, pathname, options),
    });
  }
}

export function relaySignaturePayload({ method, pathname, timestamp, nonce, rawBody = "" }) {
  return canonicalSignature(method, pathname, timestamp, nonce, rawBody);
}
