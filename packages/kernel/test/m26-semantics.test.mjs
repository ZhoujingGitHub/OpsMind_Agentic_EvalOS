import assert from "node:assert/strict";
import test from "node:test";
import { explainTraceRecord, TRACE_FILTERS } from "../src/index.mjs";

test("机器日志解释层同时保留中文含义、英文辅助和原始事件码", () => {
  const raw = { record_type: "SPAN_END", span_kind: "TOOL", name: "tool.query_logs", actor: "contestant", status: "OK" };
  const display = explainTraceRecord(raw);
  assert.equal(display.title.zh, "调用工具：查询机器日志");
  assert.equal(display.title.en, "Call tool: query_logs");
  assert.equal(display.title.code, raw.name);
  assert.equal(display.actor.zh, "参评 Agent");
  assert.equal(display.lifecycle.en, "Span end");
  assert.equal(display.status.zh, "成功");
  assert.equal(TRACE_FILTERS.some((item) => item.code === "TOOL" && item.zh === "工具调用" && item.en === "Tool"), true);
});

test("未知机器事件不会被丢弃或伪造含义", () => {
  const raw = { record_type: "SPAN_EVENT", span_kind: "VENDOR_EXTENSION", name: "vendor.future.signal", actor: "future-daemon" };
  const display = explainTraceRecord(raw);
  assert.equal(display.title.code, raw.name);
  assert.match(display.title.zh, /vendor\.future\.signal/);
  assert.equal(display.category.en, "VENDOR_EXTENSION");
  assert.equal(display.actor.code, "future-daemon");
});

test("云端真实 Twin 事件与评分过滤器使用可理解的中英文语义", () => {
  const prepared = explainTraceRecord({ record_type: "SPAN_EVENT", span_kind: "INTERNAL",
    name: "environment.prepared", actor: "environment" });
  assert.equal(prepared.title.zh, "准备并隔离考试环境");
  assert.equal(prepared.title.en, "Prepare and isolate evaluation environment");

  const nativeTool = explainTraceRecord({ record_type: "SPAN_EVENT", span_kind: "AGENT",
    name: "native_tool.policy.denied", actor: "harness", status: "FAILED" });
  assert.equal(nativeTool.title.zh, "安全策略拒绝原生工具调用");
  assert.equal(nativeTool.actor.zh, "评测执行层");

  const protocol = explainTraceRecord({ record_type: "SPAN_END", span_kind: "TOOL",
    name: "tool.capture_protocol_summary", actor: "environment", status: "OK" });
  assert.equal(protocol.title.zh, "调用工具：采集协议交互摘要");
  assert.equal(TRACE_FILTERS.some((item) => item.code === "EVALUATOR" && item.en === "Grader"), true);
});
