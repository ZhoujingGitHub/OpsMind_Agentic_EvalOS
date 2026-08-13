from __future__ import annotations

import asyncio
from collections import defaultdict
from datetime import UTC, datetime
import json
import os
from pathlib import Path
import sys
from typing import Any
from uuid import uuid4

import httpx
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import InMemorySaver

from opsmind_langgraph.contracts import (
    EvidenceQuality,
    ExecutionMode,
    FreshnessClass,
    McpToolDescriptor,
    McpToolResult,
    ResourceScope,
    ScopeSnapshot,
    ToolEffect,
    ToolFamily,
)
from opsmind_langgraph.graph import GraphServices, build_investigation_graph, initial_graph_state
from opsmind_langgraph.infrastructure.model.deepseek import DeepSeekAnthropicAgent
from opsmind_langgraph.graph.agent import AgentDecision, QualityDecision, ToolSelection
from opsmind_langgraph.knowledge import KnowledgePackCatalog
from opsmind_langgraph.mcp_gateway import McpGateway
from opsmind_langgraph.security import SecretValue


class CountingClient:
    def __init__(self, timeout_seconds: float) -> None:
        self.client = httpx.AsyncClient(timeout=timeout_seconds)
        self.input_tokens = 0
        self.output_tokens = 0
        self.calls = 0
        self.last_response_summary: dict[str, Any] = {}

    async def post(self, *args: Any, **kwargs: Any) -> httpx.Response:
        response = await self.client.post(*args, **kwargs)
        self.calls += 1
        try:
            payload = response.json()
            usage = payload.get("usage") or {}
            self.input_tokens += int(usage.get("input_tokens") or 0)
            self.output_tokens += int(usage.get("output_tokens") or 0)
            content = payload.get("content") or []
            self.last_response_summary = {
                "http_status": response.status_code,
                "top_level_keys": sorted(payload.keys()),
                "content_types": [item.get("type") for item in content if isinstance(item, dict)],
                "text_lengths": [len(item.get("text", "")) for item in content if isinstance(item, dict) and isinstance(item.get("text"), str)],
            }
        except (ValueError, TypeError, AttributeError):
            self.last_response_summary = {"http_status": response.status_code, "json": "invalid"}
        return response

    async def close(self) -> None:
        await self.client.aclose()


class EvalCompatibleDeepSeekAgent(DeepSeekAnthropicAgent):
    """Keep V1's real model adapter while normalizing provider JSON to its strict contract.

    DeepSeek occasionally returns semantically valid values in a looser shape than the
    V1 Pydantic contract (for example a JSON object for ``conclusion`` or a string in
    ``hypotheses``).  This boundary adapter changes representation only; it does not
    select tools, hypotheses, graph routes, or stopping conditions.
    """

    @staticmethod
    def _parse_response(stage: Any, payload: dict[str, Any]) -> Any:
        texts: list[str] = []
        selections: list[ToolSelection] = []
        for item in payload.get("content") or []:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "tool_use":
                tool_name = str(item.get("name") or "").strip()
                if tool_name:
                    raw_input = item.get("input")
                    selections.append(ToolSelection(
                        tool_call_id=str(item.get("id") or f"call-{uuid4().hex[:16]}"),
                        tool_name=tool_name,
                        arguments=raw_input if isinstance(raw_input, dict) else {},
                        purpose="Selected by the V1 main Agent to close an evidence gap.",
                    ))
                continue
            if item.get("type") != "text":
                continue
            text = item.get("text")
            if not isinstance(text, str):
                continue
            texts.append(text)
        combined = "\n".join(texts).strip()
        value: dict[str, Any] = {}
        if combined:
            candidate = combined.replace("```json", "").replace("```", "").strip()
            try:
                parsed = json.loads(candidate)
                value = parsed if isinstance(parsed, dict) else {"audit_summary": combined}
            except json.JSONDecodeError:
                value = {"audit_summary": combined}
        if not value and not selections:
            raise RuntimeError("DeepSeek content contains no public decision")
        raw_hypotheses = value.get("hypotheses") or []
        if isinstance(raw_hypotheses, dict):
            raw_hypotheses = [raw_hypotheses]
        elif not isinstance(raw_hypotheses, list):
            raw_hypotheses = [raw_hypotheses]
        hypotheses = tuple(
            hypothesis if isinstance(hypothesis, dict) else {"statement": str(hypothesis)}
            for hypothesis in raw_hypotheses if hypothesis is not None
        )
        raw_gaps = value.get("evidence_gaps") or []
        if not isinstance(raw_gaps, list):
            raw_gaps = [raw_gaps]
        quality_aliases = {
            "final": "finalize", "ready_to_finalize": "finalize", "complete": "finalize",
            "completed": "finalize", "insufficient": "insufficient_evidence",
            "insufficient_data": "insufficient_evidence", "propose": "propose_action",
            "gather_more": "continue", "proceed": "continue",
        }
        stage_value = getattr(stage, "value", str(stage))
        default_quality = "finalize" if stage_value == "finalize" else "continue"
        quality = quality_aliases.get(str(value.get("quality_decision") or default_quality).lower(), str(value.get("quality_decision") or default_quality).lower())
        if quality not in {item.value for item in QualityDecision}:
            quality = default_quality
        proposed = value.get("proposed_action")
        if not isinstance(proposed, dict):
            proposed = None
        if quality == "propose_action" and proposed is None:
            quality = "finalize"
        def public_text(raw: Any) -> str | None:
            if raw is None:
                return None
            return raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False)
        audit_summary = public_text(value.get("audit_summary")) or ("Agent selected authorized tools." if selections else combined)
        return AgentDecision(
            audit_summary=audit_summary[:4000],
            hypotheses=hypotheses,
            selected_tools=tuple(selections),
            evidence_gaps=tuple(str(gap) for gap in raw_gaps if gap is not None),
            quality_decision=QualityDecision(quality),
            conclusion=public_text(value.get("conclusion")),
            uncertainty=public_text(value.get("uncertainty")),
            proposed_action=proposed,
        )

    async def decide(self, turn: Any) -> Any:
        first_error: Exception | None = None
        for attempt in range(2):
            try:
                return await super().decide(turn)
            except Exception as exc:
                if attempt == 0:
                    first_error = exc
                    await asyncio.sleep(0.25)
                    continue
                client = self._client
                summary = getattr(client, "last_response_summary", {})
                raise RuntimeError(
                    "V1 provider-contract error after one bounded adapter retry; "
                    f"safe_response_summary={json.dumps(summary)}"
                ) from (first_error or exc)
        raise AssertionError("unreachable")


def safe_case(case_spec: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": case_spec["id"],
        "version": case_spec["version"],
        "goal": case_spec["goal"],
        "visible": case_spec["visible"],
        "tools": case_spec["tools"],
    }


def json_candidate(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    text = str(value or "").strip()
    if "```" in text:
        text = text.replace("```json", "").replace("```", "").strip()
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        return None


def evidence_from_records(tool_results: list[dict[str, Any]]) -> tuple[list[str], list[dict[str, Any]]]:
    refs: list[str] = []
    signals: list[dict[str, Any]] = []
    for result in tool_results:
        for record in result.get("records", []):
            data = record.get("data") if isinstance(record, dict) else None
            if not isinstance(data, dict):
                continue
            refs.extend(str(item) for item in data.get("evidence_refs", []) if item)
            signals.extend(item for item in data.get("signals", []) if isinstance(item, dict))
    return list(dict.fromkeys(refs)), signals


def normalize_outcome(state: dict[str, Any], tool_results: list[dict[str, Any]], recovered: bool) -> dict[str, Any]:
    parsed = json_candidate(state.get("conclusion"))
    public_text = json.dumps(
        {
            "conclusion": state.get("conclusion"),
            "hypotheses": state.get("hypotheses", []),
            "uncertainty": state.get("uncertainty"),
            "evidence_gaps": state.get("evidence_gaps", []),
        },
        ensure_ascii=False,
    )
    observed_refs, signals = evidence_from_records(tool_results)
    evidence_aliases: dict[str, list[str]] = {}
    for evidence in state.get("evidence", []):
        aliases: list[str] = []
        for record in evidence.get("records", []):
            data = record.get("data") if isinstance(record, dict) else None
            if isinstance(data, dict):
                aliases.extend(str(item) for item in data.get("evidence_refs", []) if item)
        if evidence.get("evidence_id") and aliases:
            evidence_aliases[str(evidence["evidence_id"])] = list(dict.fromkeys(aliases))
    cited_refs = [ref for ref in observed_refs if ref in public_text]
    for alias, refs in evidence_aliases.items():
        if alias in public_text:
            cited_refs.extend(refs)
    candidates = sorted(
        (
            (float(item.get("confidence") or 0), str(item.get("component") or ""))
            for item in signals
            if item.get("component") and not item.get("exclusion")
        ),
        reverse=True,
    )
    mentioned = [item for item in candidates if item[1] in public_text]
    root_cause = str((parsed or {}).get("root_cause") or (mentioned[0][1] if mentioned else "undetermined"))
    exclusions = list((parsed or {}).get("exclusions") or [])
    if not exclusions:
        exclusions = [
            str(item.get("component"))
            for item in signals
            if item.get("exclusion") and str(item.get("component")) in public_text
        ]
    lower = public_text.lower()
    status = str((parsed or {}).get("status") or "").lower()
    if status in {"confirmed", "root_cause_identified", "complete", "completed"}:
        status = "resolved"
    elif status not in {"resolved", "inconclusive"}:
        status = (
            "inconclusive"
            if state.get("status") == "insufficient_evidence"
            or state.get("quality_decision") == "insufficient_evidence"
            or any(marker in lower for marker in ("inconclusive", "insufficient", "证据不足", "无法确认"))
            else "resolved"
        )
    confidence = (parsed or {}).get("confidence")
    if not isinstance(confidence, (int, float)):
        confidence = mentioned[0][0] if mentioned else 0.0
    gaps = [str(item) for item in state.get("evidence_gaps", [])]
    summary = str((parsed or {}).get("summary") or state.get("conclusion") or state.get("plan_summary") or "")
    raw_refs = [str(item) for item in ((parsed or {}).get("evidence_refs") or cited_refs)]
    normalized_refs: list[str] = []
    for ref in raw_refs:
        if ref in observed_refs:
            normalized_refs.append(ref)
        normalized_refs.extend(item for item in evidence_aliases.get(ref, []) if item in observed_refs)
    return {
        "status": status,
        "root_cause": root_cause,
        "confidence": max(0.0, min(1.0, float(confidence))),
        "evidence_refs": list(dict.fromkeys(normalized_refs or cited_refs)),
        "exclusions": list(dict.fromkeys(str(item) for item in exclusions)),
        "tool_failures_recovered": bool(recovered),
        "next_checks": list((parsed or {}).get("next_checks") or gaps),
        "summary": summary,
    }


async def run(payload: dict[str, Any]) -> dict[str, Any]:
    case_spec = safe_case(payload["case_spec"])
    trial = payload["trial"]
    api_key = os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN") or os.getenv("DEEPSEEK_API_KEY")
    if not api_key:
        raise RuntimeError("DeepSeek API key is not configured")

    tenant_id = str(case_spec["visible"]["tenant"])
    scope = ScopeSnapshot(
        scope_snapshot_id=f"scope-{case_spec['id'].lower()}",
        tenant_id=tenant_id,
        scope=ResourceScope(network_profiles=("PNI-NPN",)),
        policy_version="m1-policy-1.0.0",
    )
    gateway = McpGateway()
    calls: dict[str, int] = defaultdict(int)
    trace: list[dict[str, Any]] = []

    for name, definition in case_spec["tools"].items():
        descriptor = McpToolDescriptor(
            name=name,
            version="1.0.0",
            family=ToolFamily.OBSERVABILITY,
            effect=ToolEffect.READ_ONLY,
            required_permissions=(),
            description=str(definition["description"]),
            input_schema={
                "type": "object",
                "properties": {
                    "tenant": {"type": "string"},
                    "time_window": {"type": "string"},
                    "query": {"type": "string"},
                },
                "additionalProperties": False,
            },
        )

        async def handler(request: Any, request_scope: ScopeSnapshot, *, tool_name: str = name, tool_definition: dict[str, Any] = definition) -> McpToolResult:
            calls[tool_name] += 1
            attempt = calls[tool_name]
            trace.append({"kind": "tool.call", "actor": "contestant", "payload": {"tool": tool_name, "args": request.arguments}})
            failed = bool(tool_definition.get("failures_before_success") and attempt <= int(tool_definition["failures_before_success"]))
            record = (
                {"ok": False, "tool": tool_name, "attempt": attempt, "error": tool_definition["failure"]}
                if failed
                else {"ok": True, "tool": tool_name, "attempt": attempt, "data": tool_definition["result"]}
            )
            trace.append({"kind": "tool.result", "actor": "environment", "payload": record})
            return McpToolResult(
                tenant_id=tenant_id,
                scope_snapshot_id=scope.scope_snapshot_id,
                tool_call_id=request.tool_call_id,
                scope=request_scope.scope,
                observed_at=datetime(2026, 8, 13, 2, 5, tzinfo=UTC),
                source_system="evalos-case",
                freshness=FreshnessClass.RECENT,
                quality=EvidenceQuality.HIGH if not failed else EvidenceQuality.LOW,
                execution_mode=ExecutionMode.REAL,
                records=(record,),
                partial=failed,
            )

        gateway.register(descriptor, handler)

    client = CountingClient(float(trial["budget"].get("wallclock_ms", 300000)) / 1000)
    try:
        agent = EvalCompatibleDeepSeekAgent(
            api_key=SecretValue(api_key),
            base_url=os.getenv("ANTHROPIC_BASE_URL", "https://api.deepseek.com/anthropic"),
            model_id="deepseek-v4-flash",
            max_tokens=int(trial["budget"].get("output_tokens", 4096)),
            timeout_seconds=float(trial["budget"].get("wallclock_ms", 300000)) / 1000,
            client=client,  # type: ignore[arg-type]
        )
        knowledge_root = Path(os.environ["OPSMIND_LANGGRAPH_ROOT"]) / "knowledge_packs"
        services = GraphServices(
            agent=agent,
            gateway=gateway,
            knowledge=KnowledgePackCatalog.load(knowledge_root),
            scope=scope,
            governor=lambda _: {"decision": "PROCEED", "reason_code": "M1_FROZEN_MANIFEST"},
            hydrator=lambda _: {
                "visible_context": case_spec["visible"],
                "case_version": case_spec["version"],
                "seed": trial["seed"],
            },
        )
        graph = build_investigation_graph(services, checkpointer=InMemorySaver())
        investigation_id = f"inv-{uuid4().hex[:24]}"
        initial = initial_graph_state(
            scope=scope,
            investigation_id=investigation_id,
            thread_id=f"thread-{uuid4().hex[:24]}",
            run_id=str(trial["id"]),
            candidate_id=f"candidate-{case_spec['id'].lower()}",
            objective=(
                case_spec["goal"]
                + " 最终 conclusion 必须是 JSON 对象，字段为 status、root_cause、confidence、evidence_refs、"
                "exclusions、next_checks、summary；证据不足时 status=inconclusive。证据编号必须逐字引用工具结果。"
            ),
            candidate={"case_id": case_spec["id"], "visible": case_spec["visible"], "seed": trial["seed"]},
            max_iterations=max(1, min(6, int(trial["budget"].get("tool_calls", 20)) // 2)),
        )
        config: RunnableConfig = {"configurable": {"thread_id": initial["thread_id"]}}
        async with asyncio.timeout(float(trial["budget"].get("wallclock_ms", 300000)) / 1000):
            async for update in graph.astream(initial, config=config, stream_mode="updates"):
                for node, values in update.items():
                    public = {
                        key: value
                        for key, value in values.items()
                        if key in {"phase", "plan_summary", "quality_decision", "conclusion", "uncertainty", "iteration", "evidence_gaps", "hypotheses"}
                    }
                    trace.append({"kind": "model.decision", "actor": "langgraph-v1", "payload": {"node": node, "public": public}})
        snapshot = await graph.aget_state(config)
        state = dict(snapshot.values)
        tool_results = list(state.get("tool_results", []))
        failures = [event for event in trace if event["kind"] == "tool.result" and not event["payload"].get("ok")]
        recovered = bool(failures) and any(
            event["kind"] == "tool.result" and event["payload"].get("ok")
            for event in trace[trace.index(failures[0]) + 1 :]
        )
        outcome = normalize_outcome(state, tool_results, recovered)
        return {
            "architecture": "LANGGRAPH_V1",
            "runtime": "real-langgraph-stategraph/deepseek-v4-flash",
            "outcome": outcome,
            "usage": {
                "input_tokens": client.input_tokens,
                "output_tokens": client.output_tokens,
                "model_calls": client.calls,
            },
            "trace": trace,
        }
    finally:
        await client.close()


def main() -> None:
    input_path = Path(sys.argv[1]).resolve()
    output_path = Path(sys.argv[2]).resolve()
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    try:
        result = asyncio.run(run(payload))
    except Exception as exc:
        causes: list[str] = []
        current: BaseException | None = exc
        while current is not None and len(causes) < 4:
            causes.append(f"{type(current).__name__}: {str(current)}")
            current = current.__cause__
        result = {"error": " <- ".join(causes)}
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if "error" in result:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
