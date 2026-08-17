import { createHash, randomBytes } from "node:crypto";

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const REQUIRED_EVIDENCE = ["queue", "worker", "recovery", "persistence", "audit", "archive"];

function normalizedBaseUrl(value) {
  const url = new URL(value);
  const local = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("Product Evaluation Adapter requires HTTPS; HTTP is allowed only on loopback");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

function tokenHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export class ProductToolBridgeRegistry {
  constructor({ ttlMs = 360000 } = {}) {
    this.ttlMs = ttlMs;
    this.entries = new Map();
  }

  register({ trialId, contractDigest, allowedTools, toolExecutor }) {
    if (!trialId || !contractDigest || typeof toolExecutor !== "function") throw new Error("A scoped Product tool bridge requires Trial, contract and executor");
    const token = randomBytes(32).toString("base64url");
    const digest = tokenHash(token);
    this.entries.set(digest, { trialId, contractDigest, allowedTools: new Set(allowedTools), toolExecutor,
      expiresAt: Date.now() + this.ttlMs });
    return { token, expiresAt: Date.now() + this.ttlMs, close: () => this.entries.delete(digest) };
  }

  async invoke(token, request) {
    const key = tokenHash(String(token ?? ""));
    const entry = this.entries.get(key);
    if (!entry || Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return { status: 401, body: { error: { code: "PRODUCT_TOOL_BRIDGE_TOKEN_INVALID" } } };
    }
    if (!request || typeof request !== "object" || request.trial_id !== entry.trialId ||
        request.contract_digest !== entry.contractDigest || !entry.allowedTools.has(request.tool_name)) {
      return { status: 403, body: { error: { code: "PRODUCT_TOOL_BRIDGE_SCOPE_DENIED" } } };
    }
    const result = await entry.toolExecutor(request.tool_name, request.arguments ?? {});
    return { status: 200, body: result };
  }
}

function assertResult(body, trialId) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Product adapter returned a non-object response");
  if (body.adapter_contract_version !== "2.0" || body.evaluation_lane !== "PRODUCT_E2E" || body.eval_run_id !== trialId) {
    throw new Error("Product adapter response does not match the frozen Adapter 2.0 run identity");
  }
  if (!TERMINAL.has(body.status)) return body;
  if (body.status !== "COMPLETED") throw new Error(`Product evaluation run ended with ${body.status}: ${body.error?.code ?? "unknown"}`);
  if (!body.outcome || typeof body.outcome !== "object") throw new Error("Completed product evaluation run is missing outcome");
  if (!body.product_evidence || REQUIRED_EVIDENCE.some((name) => body.product_evidence[name]?.recorded !== true ||
      typeof body.product_evidence[name]?.ref !== "string" || !body.product_evidence[name].ref)) {
    throw new Error("Completed product evaluation run is missing queue/worker/recovery/persistence/audit/archive evidence");
  }
  return body;
}

async function requestJson(url, { token, method = "GET", body, timeoutMs }) {
  const response = await fetch(url, {
    method,
    headers: { accept: "application/json", authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`Product adapter returned non-JSON HTTP ${response.status}`); }
  if (!response.ok) throw new Error(`Product adapter HTTP ${response.status}: ${payload?.error?.code ?? payload?.detail?.code ?? "request_failed"}`);
  return payload;
}

export function createProductE2EAdapter({ id, endpoint, token, bridgeRegistry, bridgePublicOrigin,
  pollIntervalMs = 1000, requestTimeoutMs = 300000 } = {}) {
  if (!id) throw new Error("Product adapter candidate id is required");
  if (!endpoint) throw new Error(`Product adapter endpoint is required for ${id}`);
  if (!token) throw new Error(`Product adapter bearer token is required for ${id}`);
  const base = normalizedBaseUrl(endpoint);
  const runUrl = new URL("v2/eval-runs", base.href.endsWith("/") ? base.href : `${base.href}/`);
  const bridgeOrigin = bridgePublicOrigin ? normalizedBaseUrl(bridgePublicOrigin) : null;
  return Object.freeze({
    id,
    adapterVersion: "product-e2e-adapter-2.0.0",
    adapterContractVersion: "2.0",
    supportedEvaluationLanes: ["PRODUCT_E2E"],
    runtime: "authenticated-product-api/queue-worker-persistence",
    async execute({ trial, executionContract, toolExecutor, emit }) {
      if (executionContract.evaluation_lane !== "PRODUCT_E2E") throw new Error("Product adapter refuses the Agent capability lane");
      if (!bridgeRegistry || !bridgeOrigin) throw new Error("Product E2E requires the scoped EvalOS Harness tool bridge");
      const bridge = bridgeRegistry.register({ trialId: trial.id, contractDigest: executionContract.contract_digest,
        allowedTools: executionContract.tools.map((item) => item.name), toolExecutor });
      try {
        const submitted = assertResult(await requestJson(runUrl, { token, method: "POST", timeoutMs: requestTimeoutMs,
          body: { adapter_contract_version: "2.0", evaluation_lane: "PRODUCT_E2E", eval_run_id: trial.id,
            idempotency_key: trial.id, execution_contract: executionContract,
            tool_bridge: { url: new URL("internal/product-tool-bridge",
              bridgeOrigin.href.endsWith("/") ? bridgeOrigin.href : `${bridgeOrigin.href}/`).href,
              authorization: `Bearer ${bridge.token}`, expires_at: new Date(bridge.expiresAt).toISOString(),
              trial_id: trial.id, contract_digest: executionContract.contract_digest } } }), trial.id);
        await emit("product.run.submitted", "contestant-product", { status: submitted.status,
          product_run_ref: submitted.product_run_ref ?? trial.id });
        let result = submitted;
        const statusUrl = submitted.status_url ? new URL(submitted.status_url, base) : new URL(`${runUrl.pathname}/${encodeURIComponent(trial.id)}`, base);
        if (statusUrl.origin !== base.origin) throw new Error("Product adapter status URL escaped the frozen service origin");
        const deadline = Date.now() + requestTimeoutMs;
        while (!TERMINAL.has(result.status)) {
          if (Date.now() >= deadline) throw new Error("Product evaluation run polling timed out");
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          result = assertResult(await requestJson(statusUrl, { token, timeoutMs: requestTimeoutMs }), trial.id);
          await emit("product.run.status", "contestant-product", { status: result.status,
            product_run_ref: result.product_run_ref ?? trial.id });
        }
        for (const record of result.trace_events ?? []) {
          if (!record?.name || typeof record.name !== "string") continue;
          await emit(record.name, record.actor ?? "contestant-product", record.payload ?? {}, record.usage_delta ?? {});
        }
        await emit("product.e2e.evidence", "contestant-product", { product_evidence: result.product_evidence,
          artifact_refs: result.artifact_refs ?? [] });
        return { ...result.outcome, product_evidence: result.product_evidence, artifact_refs: result.artifact_refs ?? [],
          product_run_ref: result.product_run_ref ?? trial.id };
      } finally {
        bridge.close();
      }
    },
  });
}

export const PRODUCT_E2E_ADAPTER_RUNTIME = Object.freeze({
  contract: "2.0", lane: "PRODUCT_E2E", transport: "authenticated HTTPS",
  hard_evidence: REQUIRED_EVIDENCE,
});
