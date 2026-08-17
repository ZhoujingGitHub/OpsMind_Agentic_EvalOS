import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const controller = read("infra/twin/opsmind_twinctl.py");
const gateway = read("infra/twin/ssh_gateway.sh");
const sshClient = read("packages/twin-runtime/src/ssh-client.mjs");
const adapter = read("packages/agent-runtime/src/deepseek-claude-adapter.mjs");
const manifest = JSON.parse(read("config/m2-agent-acceptance.manifest.json"));
const checks = {
  forced_ssh_gateway: /SSH_ORIGINAL_COMMAND/.test(gateway) && /opsmind-twinctl/.test(gateway),
  strict_host_key_checking: /StrictHostKeyChecking=yes/.test(sshClient) && /UserKnownHostsFile/.test(sshClient),
  frozen_operations_only: /const OPERATIONS = new Set/.test(read("packages/twin-runtime/src/contracts.mjs"))
    && /prepare/.test(controller) && /observe/.test(controller) && /act/.test(controller) && /reset/.test(controller),
  trial_id_path_guard: /ID_RE/.test(controller) && /is_relative_to/.test(controller),
  agent_tools_have_effect_annotations: /readOnlyHint:\s*definition\.read_only !== false/.test(adapter)
    && /destructiveHint:\s*definition\.read_only === false/.test(adapter),
  generic_changes_are_policy_and_trial_scoped: /const ACTION_CONTRACTS = Object\.freeze/.test(read("packages/twin-runtime/src/contracts.mjs"))
    && /operation:\s*"act"/.test(read("packages/twin-runtime/src/environment.mjs"))
    && manifest.policy.allowed_tools.filter((name) => !name.startsWith("query_")
      && !["get_network_health", "capture_protocol_summary", "probe_user_plane"].includes(name)).length === 9,
  secrets_environment_only: !/(?:DEEPSEEK_API_KEY|ANTHROPIC_AUTH_TOKEN)\s*=\s*["'][^"']+["']/.test(adapter),
  cross_tenant_and_exfiltration_forbidden: manifest.policy.forbidden_actions.includes("cross_tenant_access")
    && manifest.policy.forbidden_actions.includes("credential_exfiltration"),
};
const result = { status: Object.values(checks).every(Boolean) ? "PASSED" : "FAILED", checks };
console.log(JSON.stringify(result, null, 2));
if (result.status !== "PASSED") process.exitCode = 1;
