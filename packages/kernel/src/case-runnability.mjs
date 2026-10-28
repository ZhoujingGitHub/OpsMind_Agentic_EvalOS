import { OBSERVATION_FIELDS, faultDeltaObservable } from "./fault-delta.mjs";
import { OBSERVATION_KINDS } from "./m33-ops-cases.mjs";

// Can a case be answered against the live laboratory at all?
//
// A case that cannot be answered wastes a physical lease and produces the
// wrong conclusion ("the product is bad") about a defect that lives in the
// bank. Since Grader 7.0 the question has two halves, both structural:
//
//   1. the changed state lives in an observation family a candidate can
//      request (OBSERVATION_FIELDS), so it can be pointed at; and
//   2. every kind of live data the case asks a correct answer to rest on is a
//      kind the laboratory actually serves (OBSERVATION_KINDS).
//
// A live case that still declares exam-minted reference strings instead of
// kinds of data predates 7.0 and is refused outright: that is the defect that
// made 9 of 13 annotated scenarios unanswerable.

// A case is live-only when no tool ships a fixture receipt: everything the
// candidate can cite has to be produced by the laboratory at run time.
export function liveEvidenceOnlyCase(caseSpec) {
  const tools = Object.values(caseSpec?.tools ?? {});
  return caseSpec?.source?.level === "L2" && tools.length > 0
    && tools.every((tool) => !(tool?.result?.evidence_refs?.length > 0));
}

export function caseRunnability(caseSpec) {
  if (!liveEvidenceOnlyCase(caseSpec)) {
    return { applicable: false, runnable: true, verdict: "不适用（本题自带证据）", reason_zh: null };
  }
  const truth = caseSpec.ground_truth ?? {};
  const required = truth.required_observations;
  if (!required || typeof required !== "object") {
    return { applicable: true, runnable: false, verdict: "题库早于判分 7.0",
      reason_zh: "本题用的还是考场自造的证据编号，判分 7.0 已改为「必须查过哪几类现场数据」；只能查看历史，不能再考" };
  }
  const deltas = Array.isArray(truth.fault_deltas) ? truth.fault_deltas : null;
  const unobservable = (deltas ?? []).filter((delta) => !faultDeltaObservable(delta));
  const kinds = [required.must, ...(required.any_of ?? [])].filter(Boolean);
  const unknownKinds = kinds.filter((kind) => !OBSERVATION_KINDS.includes(kind));
  const runnable = Boolean(deltas) && unobservable.length === 0 && unknownKinds.length === 0;
  const reason = !deltas ? "本题没有标注被改动的状态，根因无从判起"
    : unobservable.length ? `本题被改动的状态（${unobservable.map((item) => item.observation).join("、")}）考生侧观测不到`
      : unknownKinds.length ? `本题要求的现场数据（${unknownKinds.join("、")}）实验室不提供` : null;
  return { applicable: true, runnable,
    verdict: runnable ? (deltas.length ? "可考" : "可考（无故障对照）") : "不可考",
    required_observations: required, fault_deltas: deltas,
    observable_families: Object.keys(OBSERVATION_FIELDS), reason_zh: reason };
}
