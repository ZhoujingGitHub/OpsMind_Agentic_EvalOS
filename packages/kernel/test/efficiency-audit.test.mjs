import assert from "node:assert/strict";
import test from "node:test";
import { auditTrialEfficiency } from "../src/index.mjs";

function raw(seq, eventType, payload = {}, timestamp = `2026-08-27T00:00:${String(seq).padStart(2, "0")}.000Z`) {
  return { seq, name: "candidate.raw_event", record_type: "SPAN_EVENT", span_kind: "AGENT",
    timestamp, payload: { source_ref: `raw:${seq}`, recorded_at: timestamp,
      payload: { event_type: eventType, created_at: timestamp, payload } } };
}

const usage = { input_tokens: 100, output_tokens: 20, model_calls: 2, tool_calls: 2,
  wallclock_ms: 5000, compute_ms: 5000, storage_bytes: 1024, cost_usd: 0.02,
  measurement: { complete: true, observed_dimensions: ["input_tokens", "output_tokens", "model_calls", "tool_calls",
    "wallclock_ms", "compute_ms", "storage_bytes", "cost_usd"], unavailable_dimensions: [] } };
const budget = { input_tokens: 1000, output_tokens: 1000, model_calls: 10, tool_calls: 10,
  wallclock_ms: 10000, compute_ms: 10000, storage_bytes: 10000, cost_usd: 1 };

test("相同工具和参数在没有新公开证据时只进入人工复核，不自动判无效循环", () => {
  const audit = auditTrialEfficiency([
    raw(1, "tool.called", { id: "call-1", name: "query_logs", input: { service: "amf", token: "secret-a" } }),
    raw(2, "tool.completed", { id: "call-1", name: "query_logs" }),
    raw(3, "tool.called", { id: "call-2", name: "query_logs", input: { service: "amf", token: "secret-b" } }),
    raw(4, "tool.completed", { id: "call-2", name: "query_logs" }),
  ], { usage, budget });
  assert.equal(audit.loop_review.review_candidates.length, 1);
  assert.equal(audit.loop_review.requires_human_review, true);
  assert.equal(audit.loop_review.automatic_invalid_loop_decision, false);
  assert.equal(audit.review_state, "HUMAN_REVIEW_SUGGESTED");
  assert.equal(audit.usage.usage_affects_score, false);
  assert.equal(JSON.stringify(audit).includes("secret-a"), false);
  assert.equal(JSON.stringify(audit).includes("secret-b"), false);
});

test("相同调用之间出现新证据或参数不同，不误报为无效循环", () => {
  const audit = auditTrialEfficiency([
    raw(1, "tool.called", { id: "call-1", name: "query_logs", input: { service: "amf" } }),
    raw(2, "tool.completed", { id: "call-1", name: "query_logs" }),
    raw(3, "evidence.collected", { evidence_id: "ev-1" }),
    raw(4, "tool.called", { id: "call-2", name: "query_logs", input: { service: "amf" } }),
    raw(5, "tool.completed", { id: "call-2", name: "query_logs" }),
    raw(6, "tool.called", { id: "call-3", name: "query_logs", input: { service: "smf" } }),
    raw(7, "tool.completed", { id: "call-3", name: "query_logs" }),
  ], { usage, budget });
  assert.equal(audit.loop_review.exact_repeat_groups.length, 1);
  assert.equal(audit.loop_review.review_candidates.length, 0);
  assert.equal(audit.loop_review.requires_human_review, false);
});

test("未收齐工具终态和缺失 provider 时钟均明确报告为未知", () => {
  const incompleteUsage = { ...usage, input_tokens: undefined,
    measurement: { complete: false, observed_dimensions: ["tool_calls"], unavailable_dimensions: ["input_tokens"] } };
  const audit = auditTrialEfficiency([
    raw(1, "tool.called", { id: "call-open", name: "probe_dns", input: { target: "mec" } }),
    raw(2, "agent.message", {}),
  ], { usage: incompleteUsage, budget });
  assert.equal(audit.tool_execution.unresolved.length, 1);
  assert.equal(audit.model_timing.model_timing_complete, false);
  assert.match(audit.model_timing.interpretation, /cannot_separate_model_latency/);
  assert.equal(audit.usage.complete, false);
  assert.equal(audit.usage.unavailable_dimensions.includes("input_tokens"), true);
});

test("完整关联的 provider 三段时钟才允许宣称模型耗时可观测", () => {
  const audit = auditTrialEfficiency([
    raw(1, "provider.request_started", { request_id: "provider-1" }),
    raw(2, "provider.first_token", { request_id: "provider-1" }),
    raw(3, "provider.request_completed", { request_id: "provider-1" }),
  ], { usage, budget });
  assert.equal(audit.model_timing.correlated_request_spans, 1);
  assert.equal(audit.model_timing.complete_request_spans, 1);
  assert.equal(audit.model_timing.model_timing_complete, true);
});
