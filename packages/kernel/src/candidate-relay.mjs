import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { isoNow, sha256, stableStringify } from "./utils.mjs";

const ROLES = new Set(["candidate_submitter", "approval_oracle", "mode_administrator"]);
const METHODS = new Set(["GET", "POST", "PUT"]);

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

export class CandidateRelayBroker {
  constructor({ store, ledger, candidates = {}, pollIntervalMs = 100, signatureWindowMs = 300000 }) {
    this.store = store;
    this.ledger = ledger;
    this.pollIntervalMs = pollIntervalMs;
    this.signatureWindowMs = signatureWindowMs;
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

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const row = this.store.db.prepare("SELECT * FROM candidate_relay_requests WHERE id=?").get(id);
      if (row?.status === "COMPLETED") {
        const payload = parseJson(row.response_body_json, {});
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

  claim(candidateRef, { worker_id: workerId, lease_ms: leaseMs = 30000 } = {}) {
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
    this.store.db.prepare(`UPDATE candidate_relay_requests SET status=?,response_status=?,response_body_json=?,error=?,completed_at=?
      WHERE id=? AND status='LEASED' AND lease_owner=?`).run(status, error ? null : Number(responseStatus),
      error ? null : jsonValue(responseBody ?? {}), error, isoNow(), requestId, workerId);
    this.ledger.append({ entityType: "candidate_relay_request", entityId: requestId,
      action: error ? "candidate_relay.failed" : "candidate_relay.completed",
      payload: { candidate_ref: candidateRef, request_hash: row.request_hash,
        response_status: error ? null : Number(responseStatus), response_hash: error ? null : sha256(responseBody ?? {}), error } });
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
