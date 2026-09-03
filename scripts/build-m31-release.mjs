import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployRoot = path.join(root, ".deploy");
const buildRoot = path.join(deployRoot, "m31-build");
const payloadRoot = path.join(buildRoot, "evalos");
const sourceRevision = execFileSync("git", ["rev-parse", "--verify", "HEAD"],
  { cwd: root, encoding: "utf8" }).trim();
const trackedStatus = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"],
  { cwd: root, encoding: "utf8" }).trim();
if (!/^[a-f0-9]{40}$/.test(sourceRevision)) throw new Error("release source revision must be a full Git commit");
if (trackedStatus) throw new Error("release source contains uncommitted tracked changes");

if (process.platform === "win32") {
  execFileSync(process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", "npm run m31:verify"],
    { cwd: root, stdio: "inherit" });
} else {
  execFileSync("npm", ["run", "m31:verify"], { cwd: root, stdio: "inherit" });
}

rmSync(buildRoot, { recursive: true, force: true });
mkdirSync(payloadRoot, { recursive: true });

const include = [
  "package.json", "package-lock.json", "config", "docs/contracts",
  "packages/agent-runtime/package.json", "packages/agent-runtime/package-lock.json",
  "packages/agent-runtime/src", "packages/agent-runtime/scripts", "packages/agent-runtime/opsmind-plugin",
  "packages/kernel/src", "packages/twin-runtime/package.json", "packages/twin-runtime/src",
  "services/control-api/src", "infra/migrations/sqlite", "infra/systemd", "infra/nginx", "infra/acme", "infra/deploy",
  "infra/management",
  "apps/console/dist", "apps/console/serve.mjs", "apps/console/package.json", "apps/console/package-lock.json",
  "scripts/smoke-m31-deployment.mjs",
];

for (const relative of include) {
  const source = path.join(root, relative);
  if (!existsSync(source)) throw new Error(`release input missing: ${relative}`);
  const target = path.join(payloadRoot, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, dereference: false });
}

const files = [];
walk(payloadRoot, files);
const linuxTextExtensions = new Set([".sh", ".service", ".conf"]);
for (const file of files) {
  if (!linuxTextExtensions.has(path.extname(file))) continue;
  writeFileSync(file, readFileSync(file, "utf8").replaceAll("\r\n", "\n"));
}
const forbidden = [/langgraph_runner\.py$/i, /mock-contestant\.mjs$/i, /product-e2e-adapter\.mjs$/i,
  /candidate-adapter-v4\.mjs$/i, /product-connectors-v4\.mjs$/i,
  /product-evaluation-adapter-v2/i, /evaluation-adapter-v2/i, /deepseek-claude-adapter\.mjs$/i];
for (const file of files) {
  const relative = path.relative(payloadRoot, file).replaceAll("\\", "/");
  if (forbidden.some((pattern) => pattern.test(relative))) throw new Error(`obsolete runtime leaked into release: ${relative}`);
}

const inventory = files.map((file) => ({
  path: path.relative(payloadRoot, file).replaceAll("\\", "/"),
  bytes: statSync(file).size,
  sha256: sha256(readFileSync(file)),
})).sort((a, b) => a.path.localeCompare(b.path));
const contentDigest = sha256(JSON.stringify(inventory));
const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" })
  .format(new Date()).replaceAll("-", "");
const releaseId = `m31-${day}-${contentDigest.slice(0, 10)}`;
writeFileSync(path.join(payloadRoot, "RELEASE.json"), `${JSON.stringify({ contract: "evalos-release.2", release_id: releaseId,
  milestone: "M3.2", source_revision: sourceRevision, content_digest: `sha256:${contentDigest}`,
  built_at: new Date().toISOString(),
  formal_480_enabled: false, candidate_execution: "external-real-products-only", includes_external_candidate_source: false,
  files: inventory }, null, 2)}\n`);

mkdirSync(deployRoot, { recursive: true });
const archive = path.join(deployRoot, `${releaseId}.tar.gz`);
rmSync(archive, { force: true });
execFileSync("tar", ["-czf", archive, "-C", buildRoot, "evalos"], { cwd: root, stdio: "inherit" });
const archiveSha256 = sha256(readFileSync(archive));
const result = { status: "BUILT", release_id: releaseId, source_revision: sourceRevision,
  content_digest: `sha256:${contentDigest}`, archive, archive_sha256: archiveSha256,
  bytes: statSync(archive).size, file_count: inventory.length, includes_external_candidate_source: false, formal_480_enabled: false };
writeFileSync(path.join(deployRoot, "m31-release.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));

function walk(directory, output) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, output);
    else if (entry.isFile()) output.push(full);
  }
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
