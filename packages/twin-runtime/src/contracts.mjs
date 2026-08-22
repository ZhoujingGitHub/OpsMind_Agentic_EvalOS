const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const CAPABILITIES = new Set(["health", "logs", "sessions", "processes", "pcap_summary", "connectivity", "subscriber", "metrics"]);
const ACTION_CONTRACTS = Object.freeze({
  subscriber_profile: { source: ["reference_profile"] },
  ran_configuration: { target: ["tracking_area"], source: ["reference_config"] },
  service_state: { component: ["amf", "smf", "upf", "nrf", "mongodb"], desired_state: ["running"] },
  network_policy: { interface: ["n2", "n3", "n4", "dns"], desired_state: ["allow"] },
  route_state: { route: ["n6"], desired_state: ["present"] },
  traffic_control: { interface: ["user_plane"], delay_ms: [0] },
  component_restart: { component: ["gnb"] },
  alert_state: { alert: ["amf-down"], desired_state: ["cleared"] },
  capture_policy: { policy: ["bounded-retention"], desired_state: ["enabled"] },
});
const OPERATIONS = new Set(["health", "prepare", "observe", "act", "snapshot", "reset"]);
const MANAGER_OPERATIONS = new Set(["status", "prepare", "snapshot", "reset"]);
const MANAGED_CONTESTANTS = Object.freeze({
  "agent-harness-v2": "ah-",
  "langgraph-v1": "lg-",
});

export function validateTwinRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Twin request must be an object");
  if (!OPERATIONS.has(request.operation)) throw new Error(`Unsupported Twin operation: ${request.operation}`);
  if (request.operation !== "health" && !ID.test(String(request.trial_id ?? ""))) throw new Error("Invalid Twin trial_id");
  if (request.operation === "prepare" && !ID.test(String(request.scenario_id ?? ""))) throw new Error("Invalid Twin scenario_id");
  if (request.operation === "observe" && !CAPABILITIES.has(request.capability)) throw new Error(`Unsupported Twin capability: ${request.capability}`);
  if (request.operation === "act") {
    const contract = ACTION_CONTRACTS[request.action_type];
    if (!contract) throw new Error(`Unsupported Twin action type: ${request.action_type}`);
    const parameters = request.parameters;
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new Error("Twin action parameters are required");
    if (JSON.stringify(Object.keys(parameters).sort()) !== JSON.stringify(Object.keys(contract).sort())) {
      throw new Error("Twin action parameters do not match the frozen contract");
    }
    for (const [name, allowed] of Object.entries(contract)) {
      if (!allowed.some((value) => Object.is(value, parameters[name]))) throw new Error(`Unsupported Twin action parameter: ${name}`);
    }
  }
  if (request.seed !== undefined && !Number.isSafeInteger(Number(request.seed))) throw new Error("Twin seed must be an integer");
  return structuredClone(request);
}

export function validateTwinResponse(response, operation) {
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("Twin response must be an object");
  if (typeof response.ok !== "boolean") throw new Error("Twin response must contain boolean ok");
  if (response.operation && response.operation !== operation) throw new Error("Twin response operation mismatch");
  return response;
}

export function validateTwinManagerRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Twin manager request must be an object");
  if (!MANAGER_OPERATIONS.has(request.operation)) throw new Error(`Unsupported Twin manager operation: ${request.operation}`);
  const prefix = MANAGED_CONTESTANTS[request.contestant_ref];
  if (!prefix) throw new Error(`Unsupported managed contestant: ${request.contestant_ref}`);
  if (request.operation !== "status") {
    if (!ID.test(String(request.trial_id ?? "")) || !String(request.trial_id).startsWith(prefix)) {
      throw new Error(`Managed Twin trial_id must start with ${prefix}`);
    }
  }
  if (request.operation === "prepare" && !ID.test(String(request.scenario_id ?? ""))) {
    throw new Error("Invalid managed Twin scenario_id");
  }
  if (request.seed !== undefined && !Number.isSafeInteger(Number(request.seed))) {
    throw new Error("Managed Twin seed must be an integer");
  }
  return structuredClone(request);
}

export function validateTwinManagerResponse(response, operation) {
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("Twin manager response must be an object");
  if (typeof response.ok !== "boolean") throw new Error("Twin manager response must contain boolean ok");
  if (response.operation && response.operation !== operation) throw new Error("Twin manager response operation mismatch");
  if ("slot_lease_id" in response || "binding_hmac" in response) throw new Error("Twin manager response leaked a private lease or binding secret");
  return response;
}

export function managedTwinTrialId(contestantRef, evalosTrialId) {
  const prefix = MANAGED_CONTESTANTS[contestantRef];
  if (!prefix) throw new Error(`Unsupported managed contestant: ${contestantRef}`);
  const suffix = String(evalosTrialId ?? "").replace(/[^A-Za-z0-9._:-]/g, "-");
  const value = `${prefix}${suffix}`.slice(0, 128);
  if (!ID.test(value)) throw new Error("Unable to derive a valid managed Twin trial_id");
  return value;
}

export const TWIN_CAPABILITIES = Object.freeze([...CAPABILITIES]);
export const TWIN_ACTION_TYPES = Object.freeze(Object.keys(ACTION_CONTRACTS));
export const TWIN_OPERATIONS = Object.freeze([...OPERATIONS]);
export const TWIN_MANAGER_OPERATIONS = Object.freeze([...MANAGER_OPERATIONS]);
export const TWIN_MANAGED_CONTESTANTS = MANAGED_CONTESTANTS;
