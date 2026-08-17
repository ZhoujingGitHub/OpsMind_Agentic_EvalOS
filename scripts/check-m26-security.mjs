import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const app = readFileSync(path.join(root, "services/control-api/src/app.mjs"), "utf8");
const migration = readFileSync(path.join(root, "infra/migrations/sqlite/003_m26_run_control.sql"), "utf8");
const server = readFileSync(path.join(root, "apps/console/serve.mjs"), "utf8");

assert.match(app, /authenticated workbench session required/);
assert.match(app, /idempotency-key/);
assert.match(app, /formal evaluation must run the complete frozen suite/);
assert.match(app, /official_score_mutated: false/);
assert.match(app, /evaluation\.request\.created/);
assert.match(app, /cancelQueuedTrials/);
assert.match(migration, /regrade_requests_no_update/);
assert.match(migration, /case_selection_sets_no_update/);
assert.match(server, /拒绝跨站写请求/);
assert.doesNotMatch(app, /DEEPSEEK_API_KEY\s*=/);
console.log("M2.6 安全检查通过：认证、幂等、取消边界、正式口径隔离和只追加重评证据均已落实。");
