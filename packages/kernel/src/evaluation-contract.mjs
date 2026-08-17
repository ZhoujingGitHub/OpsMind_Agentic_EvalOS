import { sha256 } from "./utils.mjs";

export const EVALUATION_ADAPTER_CONTRACT_VERSION = "2.0";

function descriptor(name, definition) {
  return {
    name,
    version: definition.version ?? "1.0.0",
    description: definition.description,
    effect: definition.read_only === false ? "CONTROLLED_WRITE" : "READ_ONLY",
    source_system: definition.source_system ?? `evalos.unclassified.${definition.capability ?? name}`,
    input_schema: definition.input_schema ?? { type: "object", properties: {}, additionalProperties: false },
    output_schema: definition.output_schema ?? { type: "object" },
  };
}

export function buildEvaluationContract({ experiment, trial, caseSpec, adapter }) {
  if (experiment?.manifest?.manifest_version !== "4.0") throw new Error("Evaluation Adapter 2.0 requires Manifest 4.0");
  const contestant = experiment.manifest.contestants.find((item) => item.ref === trial.contestant_ref);
  if (!contestant) throw new Error(`contestant is not frozen in the manifest: ${trial.contestant_ref}`);
  if (contestant.adapter_contract_version !== EVALUATION_ADAPTER_CONTRACT_VERSION) {
    throw new Error(`contestant ${contestant.ref} does not use Evaluation Adapter contract 2.0`);
  }
  if (adapter.adapterContractVersion !== EVALUATION_ADAPTER_CONTRACT_VERSION) {
    throw new Error(`runtime adapter ${adapter.id} does not implement Evaluation Adapter contract 2.0`);
  }
  if (contestant.adapter_version !== adapter.adapterVersion) {
    throw new Error(`runtime adapter version mismatch for ${contestant.ref}`);
  }
  if (!adapter.supportedEvaluationLanes?.includes(experiment.manifest.evaluation_lane)) {
    throw new Error(`runtime adapter ${adapter.id} does not support evaluation lane ${experiment.manifest.evaluation_lane}`);
  }
  const contract = {
    adapter_contract_version: EVALUATION_ADAPTER_CONTRACT_VERSION,
    evaluation_lane: experiment.manifest.evaluation_lane,
    experiment_id: experiment.id,
    trial: {
      id: trial.id,
      case_ref: trial.case_ref,
      environment_seed: trial.environment_seed,
      replicate_id: trial.replicate_id,
      blind_id: trial.blind_id,
    },
    contestant: {
      ref: contestant.ref,
      adapter_version: contestant.adapter_version,
      source_revision: contestant.source_revision,
      artifact_digest: contestant.artifact_digest,
      runtime_digest: contestant.runtime_digest,
    },
    case: {
      id: caseSpec.id,
      version: caseSpec.version,
      goal: caseSpec.goal,
      visible: caseSpec.visible,
      source: caseSpec.source,
      environment: caseSpec.environment,
    },
    scope: {
      tenant: caseSpec.visible?.tenant,
      time_window: caseSpec.visible?.time_window,
      ...(caseSpec.visible?.scope ?? {}),
    },
    tools: Object.entries(caseSpec.tools ?? {}).map(([name, definition]) => descriptor(name, definition)),
    model: experiment.manifest.model,
    frozen_dependencies: experiment.manifest.frozen_dependencies,
    budget: trial.budget,
    policy: experiment.manifest.policy,
    retry_policy: experiment.manifest.retry_policy,
  };
  return Object.freeze({ ...contract, contract_digest: `sha256:${sha256(contract)}` });
}
