import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gradeTrial } from "./grader.mjs";
import { isoNow, parseJson, sha256, stableStringify } from "./utils.mjs";

export class PrivateLabelStore {
  constructor({ databasePath, migrationPath }) {
    this.databasePath = path.resolve(databasePath);
    mkdirSync(path.dirname(this.databasePath), { recursive: true });
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec(readFileSync(migrationPath, "utf8"));
  }

  close() { this.db.close(); }

  publishRegistry(registry) {
    const snapshot = registry.snapshot({ includePrivateLabels: true });
    for (const item of snapshot.cases) {
      const label = item.private_label;
      this.db.prepare("INSERT OR IGNORE INTO private_case_labels(case_ref,label_json,label_hash,created_at) VALUES(?,?,?,?)").run(
        item.key, stableStringify(label), sha256(label), isoNow(),
      );
    }
    return sha256(snapshot.cases.map((item) => ({ key: item.key, label: item.private_label })));
  }

  getLabel(caseRef) {
    const row = this.db.prepare("SELECT label_json,label_hash FROM private_case_labels WHERE case_ref=?").get(caseRef);
    return row ? { ...parseJson(row.label_json, {}), label_hash: row.label_hash } : null;
  }
}

export class DeterministicGradingService {
  constructor({ labelStore, executionCaseResolver, graderRef = "m15-code-grader@2.1.0" }) {
    this.labelStore = labelStore;
    this.executionCaseResolver = executionCaseResolver;
    this.graderRef = graderRef;
  }

  grade({ trialId = null, caseRef, outcome, trace, usage, budget, stability = null, environmentState = null, environmentReset = null }) {
    const execution = this.executionCaseResolver(caseRef);
    const label = this.labelStore.getLabel(caseRef);
    if (!execution || !label) throw new Error(`grading material unavailable for ${caseRef}`);
    const result = gradeTrial({ ...execution, ground_truth: label.ground_truth }, outcome, trace, usage,
      { trialId, budget, stability, graderRef: this.graderRef, environmentState, environmentReset });
    return { grader_ref: this.graderRef, result, label_hash: label.label_hash };
  }
}
