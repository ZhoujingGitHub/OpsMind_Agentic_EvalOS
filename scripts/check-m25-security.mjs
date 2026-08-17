import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(ROOT, file), "utf8");
const investigator = read("packages/agent-runtime/src/case-investigator.mjs");
const snapshot = read("packages/kernel/src/source-snapshot.mjs");
const api = read("services/control-api/src/app.mjs");
const proxy = read("apps/console/serve.mjs");
const checks = {
  investigator_has_no_write_tools: /disallowedTools:\s*\["Write",\s*"Edit",\s*"NotebookEdit"/.test(investigator)
    && !/MCP_TOOLS\s*=\s*\[[^\]]*(?:write|edit|act|change|restart)/i.test(investigator),
  analysis_after_experiment_close_only: /experiment\.status !== "COMPLETED"/.test(investigator)
    && /experiment must be closed before AI analysis/.test(api),
  frozen_source_required: /a frozen source snapshot must be bound/.test(investigator)
    && /frozen source snapshot is required/.test(api),
  web_is_untrusted_and_no_data_upload: /网页是非可信外部信息/.test(investigator)
    && /不得上传参评源码、轨迹、凭据或私有数据/.test(investigator)
    && /OFFICIAL_RESEARCH_HOSTS/.test(investigator) && /publicResearchQuery/.test(investigator)
    && /sourceKind: "web"/.test(investigator) && /content_sha256/.test(investigator),
  no_hidden_labels_in_investigator: !/getLabel\(|ground_truth|PrivateLabelStore/.test(investigator),
  source_snapshot_blocks_secrets_and_symlinks: /SECRET_NAME/.test(snapshot) && /containsSensitiveMaterial/.test(snapshot)
    && /isSymbolicLink/.test(snapshot),
  server_side_token_only: /EVALOS_API_TOKEN/.test(proxy) && /authorization/.test(proxy)
    && !/localStorage|sessionStorage/.test(proxy),
  csrf_guard: /拒绝跨站写请求/.test(proxy) && /origin !== expected/.test(proxy),
  no_hardcoded_credentials: !/(?:DEEPSEEK_API_KEY|ANTHROPIC_AUTH_TOKEN|EVALOS_API_TOKEN)\s*=\s*["'][^"']+["']/.test(`${investigator}\n${api}\n${proxy}`),
};
const result = { status: Object.values(checks).every(Boolean) ? "PASSED" : "FAILED", checks };
console.log(JSON.stringify(result, null, 2));
if (result.status !== "PASSED") process.exitCode = 1;
