import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

const product = read("packages/agent-runtime/src/product-e2e-adapter.mjs");
const app = read("services/control-api/src/app.mjs");
const store = read("packages/kernel/src/store.mjs");
const qualification = read("scripts/run-m3-adapter-qualification.mjs");
const capacity = read("scripts/check-m3-capacity-gates.mjs");

// Product Tool Bridge 使用短时、只存哈希、按 Trial/合同/工具三重限域的令牌。
assert.match(product, /randomBytes\(32\)/);
assert.match(product, /tokenHash\(token\)/);
assert.doesNotMatch(product, /this\.entries\.set\([^,]+,\s*\{[^}]*token[,}]/s);
assert.match(product, /request\.trial_id !== entry\.trialId/);
assert.match(product, /request\.contract_digest !== entry\.contractDigest/);
assert.match(product, /!entry\.allowedTools\.has\(request\.tool_name\)/);
assert.match(product, /finally\s*\{\s*bridge\.close\(\)/s);
assert.match(product, /requires HTTPS; HTTP is allowed only on loopback/);
assert.match(product, /statusUrl\.origin !== base\.origin/);

// 商用品质结论必须具备六类真实证据，且内部桥接入口不能绕过普通控制面。
for (const name of ["queue", "worker", "recovery", "persistence", "audit", "archive"]) {
  assert.match(product, new RegExp(`\\"${name}\\"`));
}
assert.match(app, /url\.pathname === "\/internal\/product-tool-bridge"/);
assert.match(app, /productToolBridgeRegistry\.invoke/);
assert.doesNotMatch(app, /EVALOS_(?:AGENT|LANGGRAPH)_PRODUCT_ADAPTER_TOKEN\s*[:=]\s*["'][^"']+["']/);
assert.doesNotMatch(app, /DEEPSEEK_API_KEY\s*[:=]\s*["'][^"']+["']/);

// 能力失败不可重试洗分；资格证据必须覆盖安全、恢复、复位、PCAP、哈希和凭据扫描。
assert.match(store, /capability_failures_retryable !== false/);
assert.match(qualification, /prompt_injection_and_cross_tenant_lures_ignored/);
assert.match(qualification, /tool_failure_recovery_proved/);
assert.match(qualification, /every_trial_reset_clean/);
assert.match(qualification, /every_trial_has_pcap/);
assert.match(qualification, /no_credentials_in_evidence/);

// 容量不足时必须在付费模型调用前停止，不能让并发 Trial 共享同一 Twin。
assert.match(capacity, /paid_trials_started:\s*false/);
assert.match(capacity, /enough_real_twin_slots/);
assert.match(capacity, /twin_is_idle_before_rehearsal/);
assert.match(qualification, /Twin 资格考场仍被/);
assert.match(capacity, /模型调用前安全停止/);
assert.match(app, /formalM3RunEnabled/);
assert.match(app, /尚未放行/);

console.log("M3.0 安全检查通过：短时限域桥接令牌、能力失败禁洗分、完整资格证据、容量安全停止和正式开考锁均已落实。");
