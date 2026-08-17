import { sha256 } from "../../kernel/src/utils.mjs";
import { validateTwinRequest } from "./contracts.mjs";

export class InMemoryTwinClient {
  constructor({ evidenceByScenario = {} } = {}) {
    this.evidenceByScenario = evidenceByScenario;
    this.active = null;
    this.history = [];
  }

  async invoke(rawRequest) {
    const request = validateTwinRequest(rawRequest);
    this.history.push(structuredClone(request));
    if (request.operation === "health") return { ok: true, operation: "health", status: "ready",
      capacity: { max_parallel_trials: 1, active_trials: this.active ? 1 : 0,
        isolation_mode: "serial-in-memory-test-double", dedicated_trial_artifacts: true } };
    if (request.operation === "prepare") {
      if (this.active && this.active.trial_id !== request.trial_id) return { ok: false, operation: "prepare", error: "another Trial is active" };
      this.active = { trial_id: request.trial_id, scenario_id: request.scenario_id, seed: request.seed };
      return { ok: true, operation: "prepare", isolation: "in-memory-test-double",
        fingerprint: sha256(this.active) };
    }
    if (!this.active || this.active.trial_id !== request.trial_id) return { ok: false, operation: request.operation,
      error: { code: "TRIAL_SCOPE_MISMATCH", message: "requested Trial is not active" } };
    if (request.operation === "observe") {
      const evidence = this.evidenceByScenario[this.active.scenario_id] ?? [];
      return { ok: true, operation: "observe", data: { capability: request.capability, scenario: this.active.scenario_id },
        evidence_refs: evidence, observed_at: "2026-08-14T00:00:00.000Z" };
    }
    if (request.operation === "act") {
      const change = { action_type: request.action_type, parameters: request.parameters };
      this.active.changes = [...(this.active.changes ?? []), change];
      return { ok: true, operation: "act", data: { ...change, applied: true,
        post_state: { changes: [...this.active.changes] } } };
    }
    if (request.operation === "snapshot") return { ok: true, operation: "snapshot", snapshot: { ...this.active } };
    if (request.operation === "reset") {
      const finished = this.active;
      this.active = null;
      return { ok: true, operation: "reset", clean: true, baseline_ref: request.baseline_ref ?? "opsmind-m2-baseline-v1",
        reset_hash: sha256({ finished, clean: true }) };
    }
    return { ok: false, operation: request.operation, error: "unsupported" };
  }
}
