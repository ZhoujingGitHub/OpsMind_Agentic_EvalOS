import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANGGRAPH_ROOT = path.resolve(process.env.OPSMIND_LANGGRAPH_ROOT ?? path.join(ROOT, "..", "OpsMind-LangGraph"));
const output = path.resolve(process.argv[2] ?? path.join(ROOT, ".deploy", "m3-release"));
const archive = path.resolve(process.env.M3_RELEASE_ARCHIVE ?? path.join(path.dirname(output), "opsmind-evalos-m30.tgz"));
const evalosRoot = path.join(output, "evalos");
const include = ["apps", "config", "docs", "infra", "packages", "scripts", "services", "README.md", "package.json", "package-lock.json"];
const skipped = new Set(["node_modules", "runtime", "artifacts", ".deploy", ".git", ".wrangler", "__pycache__",
  ".pytest_cache", ".venv", ".next", ".vinext", "dist"]);

function copyFiltered(source, target) {
  const info = statSync(source);
  if (info.isDirectory()) {
    if (skipped.has(path.basename(source))) return;
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) copyFiltered(path.join(source, name), path.join(target, name));
    return;
  }
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target);
}

function inventory(root) {
  const rows = [];
  const tree = createHash("sha256");
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const relative = path.relative(root, full).replaceAll("\\", "/");
        const content = readFileSync(full);
        const sha256 = createHash("sha256").update(content).digest("hex");
        rows.push({ path: relative, sha256, size_bytes: content.length });
        tree.update(relative).update("\0").update(sha256).update("\n");
      }
    }
  };
  walk(root);
  return { digest: `sha256:${tree.digest("hex")}`, files: rows };
}

function revision(root) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

if (!existsSync(path.join(ROOT, "apps", "console", "dist", "server", "index.js"))) {
  throw new Error("前端尚未构建；请先运行 npm run console:build");
}
rmSync(output, { recursive: true, force: true });
mkdirSync(evalosRoot, { recursive: true });
for (const item of include) copyFiltered(path.join(ROOT, item), path.join(evalosRoot, item));
cpSync(path.join(ROOT, "apps", "console", "dist"), path.join(evalosRoot, "apps", "console", "dist"), { recursive: true });
for (const item of ["src", "knowledge_packs", "pyproject.toml", "uv.lock"]) {
  const source = path.join(LANGGRAPH_ROOT, item);
  if (existsSync(source)) copyFiltered(source, path.join(output, "candidate", "langgraph", item));
}
mkdirSync(path.join(output, "release-evidence"), { recursive: true });
for (const name of ["M3设计冻结记录.json"]) {
  cpSync(path.join(ROOT, "artifacts", "m3-freeze", name), path.join(output, "release-evidence", name));
}
const frozen = JSON.parse(readFileSync(path.join(output, "release-evidence", "M3设计冻结记录.json"), "utf8"));
const contents = inventory(output);
const provenance = {
  release_contract: "evalos-m3-source-bundle.1", milestone: "M3.0", generated_at: new Date().toISOString(),
  architecture: "Claude Agent SDK + DeepSeek V4 Flash + native tools + MCP + Skills + Harness",
  orchestration: "single-model-driven-perceive-reason-tool-observe-loop", graph_framework_in_core: null,
  compatibility: "breaking-change; Manifest 4.0 and Adapter 2.0 only",
  evalos_source_revision: revision(ROOT), langgraph_source_revision: revision(LANGGRAPH_ROOT),
  candidate_fingerprints: frozen.candidate_fingerprints,
  cloud_runtime_freeze: "PENDING_LINUX_PYTHON312_FINGERPRINT",
  release_tree_digest: contents.digest,
  inventory: contents.files,
};
writeFileSync(path.join(output, "release-provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
execFileSync("tar", ["-czf", archive, "-C", path.dirname(output), path.basename(output)]);
const archiveSha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
console.log(JSON.stringify({ ...provenance, inventory: undefined, output, archive,
  archive_sha256: `sha256:${archiveSha256}` }, null, 2));
