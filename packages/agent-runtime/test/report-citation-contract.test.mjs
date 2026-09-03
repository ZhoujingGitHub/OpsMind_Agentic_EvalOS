import assert from "node:assert/strict";
import test from "node:test";
import { productReportEvidence } from "../src/product-connectors-v5.mjs";
import { auditableGraderRunView } from "../../kernel/src/projections.mjs";

test("报告引用只来自产品声明，不从回执、完整证据或任意id猜测", () => {
  const report = { evidence_ids: ["card-a", "card-counter", "card-a"], id: "report-id",
    evidence: [{ evidence_id: "uncited" }],
    hypotheses: [{ supporting_evidence_ids: ["card-a"], counter_evidence_ids: ["card-counter"] }],
    receipt: { evidence_ref: "protocol-lab:receipt", evidence_refs: ["process:canonical"] } };
  const ah = productReportEvidence({ product: "agent-harness", report });
  assert.deepEqual(ah.evidence_ids, ["card-a", "card-counter"]);
  assert.deepEqual(ah.hypotheses, report.hypotheses);
  for (const native of [null, {}, { ...report, valid: false, status: "failed" }]) {
    const lg = productReportEvidence({ product: "langgraph", report,
      taskResult: { report_evidence: native, evidence: report.evidence } });
    assert.equal(lg.status, "unavailable");
    assert.deepEqual(lg.evidence_ids, []);
  }
  const lg = productReportEvidence({ product: "langgraph", taskResult: { report_evidence: {
    ...report, contract_version: "opsmind-report-evidence:1.0", valid: true, status: "published" } } });
  assert.deepEqual(lg.evidence_ids, ah.evidence_ids);
});

test("未知引用保留给严格评分判错；无效引用数组不静默部分接收", () => {
  assert.deepEqual(productReportEvidence({ product: "agent-harness",
    report: { evidence_ids: ["unknown-card"] } }).evidence_ids, ["unknown-card"]);
  assert.equal(productReportEvidence({ product: "agent-harness",
    report: { evidence_ids: ["card-a", null] } }).status, "unavailable");
});

test("根因展示读取真实评分判定，缺失显示未知且不泄漏参考答案", () => {
  for (const passed of [true, false, undefined]) {
    const view = auditableGraderRunView({ result: { assertions: { rca_quality: {
      passed, value: passed ? 1 : 0, evidence: { canonical_labels: ["PRIVATE-ANSWER"] } } } } });
    assert.equal(view.result.assertions.rca_quality.evidence.root_cause_match, passed ?? null);
    assert.equal(JSON.stringify(view).includes("PRIVATE-ANSWER"), false);
  }
});
