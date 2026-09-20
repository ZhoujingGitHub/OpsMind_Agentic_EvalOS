// Which facts the live laboratory can actually mint.
//
// A case whose required evidence or whose disease fact the laboratory cannot
// mint is unanswerable: the candidate never sees the reference, so it can never
// name it. Running such a case wastes a physical lease and produces the wrong
// conclusion ("the product is bad") about a defect that lives in the case bank.
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
  const causeFacts = [...(truth.root_cause_fact_refs ?? [])];
  const mintable = required.filter(mintableEvidenceRef);
  const unmintable = required.filter((ref) => !mintableEvidenceRef(ref));
  const unmintableCause = causeFacts.filter((ref) => !mintableEvidenceRef(ref));
  const rootCauseMintable = causeFacts.length > 0 && unmintableCause.length === 0;
  // The evidence gate asks for two of the required references, or all of them
  // when the case declares fewer than two.
  const minimumRecall = Math.min(1, 2 / Math.max(1, required.length));
  const bestRecall = required.length ? mintable.length / required.length : 1;
  const verdict = !rootCauseMintable ? "根因事实发不出来"
    : bestRecall < minimumRecall ? "证据召回够不着"
      : bestRecall === 1 ? "有富余" : "零余量";
  const runnable = rootCauseMintable && bestRecall >= minimumRecall;
  const reason = !rootCauseMintable
    ? `本题的病根事实实验室开不出证明（缺 ${unmintableHint(unmintableCause.length ? unmintableCause : causeFacts)}），`
      + "考生拿不到这个编号，永远填不对，不能进考场"
    : bestRecall < minimumRecall
      ? `本题的必需证据实验室只开得出 ${mintable.length}/${required.length}，`
        + `最低要 ${Math.ceil(minimumRecall * required.length)}/${required.length}`
        + `（缺 ${unmintableHint(unmintable)}），证据这道门必挂，不能进考场`
      : null;
  return { applicable: true, runnable, verdict,
    required, mintable_refs: mintable, unmintable_refs: unmintable,
    root_cause_fact_refs: causeFacts, root_cause_mintable: rootCauseMintable,
    unmintable_root_cause_refs: unmintableCause,
    minimum_recall: Number(minimumRecall.toFixed(3)), best_recall: Number(bestRecall.toFixed(3)),
    reason_zh: reason };
}
