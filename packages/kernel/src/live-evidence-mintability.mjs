import { faultDeltaObservable } from "./fault-delta.mjs";

// Which facts the live laboratory can actually mint.
//
// A case whose required evidence the laboratory cannot mint, or whose injected
// state change no candidate-side observation exposes, is unanswerable. Running
// it wastes a physical lease and produces the wrong conclusion ("the product is
// bad") about a defect that lives in the case bank.
//
// This is the single implementation. The read-only probes import it; they must
// never keep a copy, because the last copy went stale the day the table under
// it changed.
//
// The three shapes below are not guesses. They are read off the two channels
// that mint references today:
//
//   channel 1  product-evidence-semantics.mjs
//     process:<element>-healthy                  element ∈ service ids in scope
//     pcap:<protocol>-observed                   protocol ∈ capture whitelist
//     policy:<protocol>:<port>:drop-rule-present kernel policy snapshot
//
//   channel 2  opsmind_harness_labctl.py matched_evidence_refs
//     process:<daemon>-inactive                  daemon ∈ RUNTIME_TARGETS

// resource_type=service entries of the laboratory resource scope.
export const LIVE_SERVICE_IDS = Object.freeze(["amf", "smf", "upf", "nrf", "mongodb", "dns"]);
// harness_diagnostics.py hard-codes this capture whitelist.
export const LIVE_CAPTURE_PROTOCOLS = Object.freeze(["sctp", "ngap", "pfcp", "gtp"]);
// opsmind_harness_labctl.py RUNTIME_TARGETS. This is the channel the first
// probe missed, which is why it counted 12 runnable cases instead of 16.
export const LIVE_RUNTIME_DAEMONS = Object.freeze(["ueransim-gnb", "ueransim-ue",
  "open5gs-amfd", "open5gs-smfd", "open5gs-upfd", "open5gs-nrfd", "mongod"]);

const SERVICE_IDS = new Set(LIVE_SERVICE_IDS);
const CAPTURE_PROTOCOLS = new Set(LIVE_CAPTURE_PROTOCOLS);
const RUNTIME_DAEMONS = new Set(LIVE_RUNTIME_DAEMONS);

export function mintableEvidenceRef(ref) {
  const text = String(ref ?? "");
  let match = /^process:([a-z0-9_.-]+)-healthy$/.exec(text);
  if (match) return SERVICE_IDS.has(match[1]);
  match = /^process:([a-z0-9_.-]+)-inactive$/.exec(text);
  if (match) return RUNTIME_DAEMONS.has(match[1]);
  match = /^pcap:([a-z][a-z0-9_]*)-observed$/.exec(text);
  if (match) return CAPTURE_PROTOCOLS.has(match[1]);
  return /^policy:(?:sctp|udp|tcp):[0-9]{1,5}:drop-rule-present$/.test(text);
}

// A case is live-evidence-only when no tool ships a fixture receipt: everything
// the candidate can cite has to be minted by the laboratory at run time. That
// is a structural property of the case sheet, not a dataset name, so a new
// live bank is covered the day it is written.
export function liveEvidenceOnlyCase(caseSpec) {
  const tools = Object.values(caseSpec?.tools ?? {});
  return caseSpec?.source?.level === "L2" && tools.length > 0
    && tools.every((tool) => !(tool?.result?.evidence_refs?.length > 0));
}

function unmintableHint(refs) {
  const head = refs.slice(0, 2).join("、");
  return refs.length > 2 ? `${head} 等 ${refs.length} 种` : head;
}

/**
 * Can this case be answered against the live laboratory at all?
 *
 * Returns `applicable: false` for every case that carries its own fixture
 * evidence — those are graded against the case sheet and this question does
 * not arise.
 */
export function liveEvidenceMintability(caseSpec) {
  if (!liveEvidenceOnlyCase(caseSpec)) {
    return { applicable: false, runnable: true, verdict: "不适用（本题自带证据）", reason_zh: null };
  }
  const truth = caseSpec.ground_truth ?? {};
  const required = [...(truth.required_evidence ?? [])];
  const mintable = required.filter(mintableEvidenceRef);
  const unmintable = required.filter((ref) => !mintableEvidenceRef(ref));
  // The root cause question changed on 2026-09-20. It used to ask whether the
  // laboratory could mint the case's root-cause *reference*; there is no
  // reference any more, so it asks whether the changed state lives in an
  // observation family the candidate can actually request.
  const deltas = truth.fault_deltas ?? null;
  const unobservableDeltas = (deltas ?? []).filter((delta) => !faultDeltaObservable(delta));
  const rootCauseObservable = !deltas || unobservableDeltas.length === 0;
  // The evidence gate asks for two of the required references, or all of them
  // when the case declares fewer than two.
  const minimumRecall = Math.min(1, 2 / Math.max(1, required.length));
  const bestRecall = required.length ? mintable.length / required.length : 1;
  const verdict = !rootCauseObservable ? "改动考生观测不到"
    : bestRecall < minimumRecall ? "证据召回够不着"
      : bestRecall === 1 ? "有富余" : "零余量";
  const runnable = rootCauseObservable && bestRecall >= minimumRecall;
  const reason = !rootCauseObservable
    ? `本题被改动的状态（${unobservableDeltas.map((item) => item.observation).join("、")}）`
      + "考生这一侧没有任何观测能看到，它永远指不出来，不能进考场"
    : bestRecall < minimumRecall
      ? `本题的必需证据实验室只开得出 ${mintable.length}/${required.length}，`
        + `最低要 ${Math.ceil(minimumRecall * required.length)}/${required.length}`
        + `（缺 ${unmintableHint(unmintable)}），证据这道门必挂，不能进考场`
      : null;
  return { applicable: true, runnable, verdict,
    required, mintable_refs: mintable, unmintable_refs: unmintable,
    fault_deltas: deltas, root_cause_observable: rootCauseObservable,
    // A case the bank does not annotate is still runnable; it simply drops the
    // root cause dimension out of the denominator. The list of those scenarios
    // lives in m2-cases.mjs and a test keeps it honest.
    root_cause_gradeable: Boolean(deltas) && rootCauseObservable,
    unobservable_deltas: unobservableDeltas,
    minimum_recall: Number(minimumRecall.toFixed(3)), best_recall: Number(bestRecall.toFixed(3)),
    reason_zh: reason };
}
