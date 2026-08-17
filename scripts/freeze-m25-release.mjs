import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] ?? path.join(ROOT, ".deploy", "m25-release"));
const evalosRoot = path.join(output, "evalos");
const langgraphRoot = path.join(output, "langgraph");
const langgraphSource = path.resolve(ROOT, "../OpsMind-LangGraph");
const previousRelease = process.env.M25_PREVIOUS_RELEASE ?? "/opt/opsmind-evalos/releases/m2-20260814-3c21f916";
const include = ["apps", "config", "docs", "infra", "packages", "scripts", "services", "README.md", "package.json", "package-lock.json"];
const langgraphInclude = ["src", "knowledge_packs", "pyproject.toml"];
const skipped = new Set(["node_modules", "runtime", "artifacts", ".deploy", ".git", ".wrangler", "__pycache__", ".pytest_cache", ".venv", ".next", ".vinext"]);

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

function files(root) {
  const result = [];
  function walk(current) {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else result.push(full);
    }
  }
  walk(root);
  return result.sort((a, b) => a.localeCompare(b, "en"));
}

function digestTree(root, excluded = new Set()) {
  const tree = createHash("sha256");
  const entries = [];
  for (const file of files(root)) {
    const relative = path.relative(root, file).replaceAll("\\", "/");
    if (excluded.has(relative)) continue;
    const content = readFileSync(file);
    const sha256 = createHash("sha256").update(content).digest("hex");
    entries.push({ path: relative, sha256, size_bytes: content.length });
    tree.update(relative).update("\0").update(sha256).update("\n");
  }
  return { sha256: tree.digest("hex"), entries };
}

function revision(repo) {
  try { return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { return "unversioned-source"; }
}

rmSync(output, { recursive: true, force: true });
mkdirSync(evalosRoot, { recursive: true });
for (const item of include) copyFiltered(path.join(ROOT, item), path.join(evalosRoot, item));
for (const item of langgraphInclude) copyFiltered(path.join(langgraphSource, item), path.join(langgraphRoot, item));

const evalosDigest = digestTree(evalosRoot);
const langgraphDigest = digestTree(langgraphRoot);
const releaseDigest = digestTree(output);
const provenance = {
  release_contract: "m25-source-bundle-v1",
  milestone: "M2.5",
  generated_at: new Date().toISOString(),
  architecture: "Claude Agent SDK + DeepSeek V4 Flash + MCP + Skills + Harness",
  orchestration: "model-driven-perceive-reason-tool-observe-loop",
  graph_framework_in_core: null,
  previous_release_dependency: previousRelease,
  dependency_policy: "只读复用已验收 M2 发布中的锁定依赖；安装时创建显式只读软链接，不修改旧发布。",
  evalos_source_revision: revision(ROOT),
  evalos_tree_digest: `sha256:${evalosDigest.sha256}`,
  langgraph_source_revision: revision(langgraphSource),
  langgraph_tree_digest: `sha256:${langgraphDigest.sha256}`,
  release_tree_digest: `sha256:${releaseDigest.sha256}`,
  inventory: releaseDigest.entries,
};
writeFileSync(path.join(output, "release-provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ...provenance, inventory: undefined, output }, null, 2));
