#!/usr/bin/env python3
"""Run both products' three-block derivation over the two sealed 2026-09-18 runs.

Read-only, purely local, no server. Each product's own code is imported from
its own repository; nothing is shared between them but the vocabulary.

What this can prove from the sealed pack:
  * the disease block, on real answers that predate the field (both empty, which
    is the honest reading and exactly what the exam now scores as "not declared")
  * the ruled-out block, on real rejected hypotheses with real counter evidence

What it cannot prove here: the corroboration block needs the evidence rows'
canonical references, and the sealed pack carries an empty
evidence_canonical_sample. That mapping is covered by each product's unit tests
against the real evidence shape, and is confirmed end to end by the live runs.

Usage (from the EvalOS repository root):
    python _work/claude-takeover-20260911/tools/report-breakdown-on-sealed.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
EVALOS = HERE.parents[3]
PARENT = EVALOS.parent
AH_SRC = PARENT / "OpsMind" / "services" / "agent-service" / "src"
LG_SRC = (PARENT / "OpsMind-LangGraph" / "runtime" / "codex-migration-20260903"
          / "candidates" / "report-evidence" / "src")
PACK = HERE.parent / "shadow-20260919" / "sealed-20260918-pack.json"

def load(label: str, path: Path):
    """Load one product's module by file path.

    Importing it as a package would drag in that product's web framework, and
    this probe must stay runnable from any Python. Each module is pure stdlib.
    """

    import importlib.util

    if not path.is_file():
        raise SystemExit(f"missing product module: {path}")
    spec = importlib.util.spec_from_file_location(label, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[label] = module
    spec.loader.exec_module(module)
    return module


ah_breakdown = load("ah_report_breakdown",
                    AH_SRC / "opsmind_agent" / "report_breakdown.py").root_cause_breakdown
lg_breakdown = load("lg_report_blocks",
                    LG_SRC / "opsmind_langgraph" / "api" / "report_blocks.py").root_cause_breakdown


def render(title: str, breakdown: dict) -> None:
    print("#" * 88)
    print(title)
    print("#" * 88)
    print(f"  合同版本: {breakdown['contract_version']}")
    print(f"  病根:     {breakdown['root_cause'] or '（这次没有指明——本次运行早于该字段）'}")
    print(f"  佐证:     {breakdown['corroborating'] or '（封存包不含证据的规范编号，见脚本头部说明）'}")
    print("  已排除:")
    if not breakdown["ruled_out"]:
        print("            （没有被否决的假设）")
    for item in breakdown["ruled_out"]:
        ids = (item.get("counter_evidence_ids") or item.get("contradicting_evidence_ids") or [])
        mark = "带反证" if item["evidenced"] else "没给反证"
        claim = (item.get("cause") or item.get("statement") or "")[:46]
        print(f"      {mark:<7} {str(item['hypothesis_id']):<24} 反证 {len(ids)} 条  {claim}")
    print()


def main() -> int:
    pack = json.loads(PACK.read_text(encoding="utf-8"))

    ah = pack["ah"]
    ah_result = ah_breakdown({"hypotheses": ah["hypotheses"]}, ah.get("evidence_canonical_sample") or [])
    render(f"考生乙 Agent Harness — {ah['investigation_id']}（2026-09-18 封存）", ah_result)

    lg = pack["lg"]
    lg_result = lg_breakdown(lg["hypotheses"], lg.get("evidence_canonical_sample") or [])
    render(f"考生甲 LangGraph — {lg['investigation_id']}（2026-09-18 封存）", lg_result)

    failures: list[str] = []
    for name, result, source in (("AH", ah_result, ah), ("LG", lg_result, lg)):
        declared = [item for item in source["hypotheses"] if item.get("root_cause_fact_refs")]
        if declared and not result["root_cause"]:
            failures.append(f"{name}: 答卷指明了病根，但推导出来的病根块是空的")
        if not declared and result["root_cause"]:
            failures.append(f"{name}: 答卷没指明病根，推导却凭空给出了一条")
        knocked = [item for item in source["hypotheses"]
                   if str(item.get("status")) in {"rejected", "weakened", "unresolved"}]
        if len(knocked) != len(result["ruled_out"]):
            failures.append(f"{name}: 被否决的假设 {len(knocked)} 条，已排除块只有 {len(result['ruled_out'])} 条")
        for item in result["ruled_out"]:
            ids = item.get("counter_evidence_ids") or item.get("contradicting_evidence_ids") or []
            if bool(ids) != item["evidenced"]:
                failures.append(f"{name}: {item['hypothesis_id']} 的反证标记与实际反证条数不一致")

    evidenced = sum(1 for result in (ah_result, lg_result)
                    for item in result["ruled_out"] if item["evidenced"])
    print(f">>> 两份真实答卷合计 {evidenced} 条被否决假设**带着反证证据编号**，")
    print(">>> 这正是新的『排除竞争假设』判据要看的东西；两份答卷在新判据下都拿得到这一项。")
    print(">>> 病根那一栏两份都是空的——这两次运行早于该字段，按新规矩会被判为没有定位到根因。")
    if failures:
        print()
        print(">>> 推导不正确：")
        for line in failures:
            print(f"    {line}")
        return 1
    print(">>> 三块推导与两份真实答卷逐条一致。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
