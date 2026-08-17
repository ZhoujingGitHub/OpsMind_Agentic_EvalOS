import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] ?? path.join(ROOT, ".deploy", "m15-release"));
const evalosRoot = path.join(output, "evalos");
const langgraphSource = path.resolve(process.env.OPSMIND_LANGGRAPH_SOURCE ?? path.join(ROOT, "..", "OpsMind-LangGraph"));
const previousRelease = process.env.M15_PREVIOUS_RELEASE ?? "/opt/opsmind-evalos/releases/m1-20260813-82e8c0fe";
const include = ["config", "docs/contracts", "infra/migrations", "packages", "scripts", "services", "package.json"];
const skip = new Set(["node_modules", "runtime", "artifacts", ".git", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".venv"]);

function copyFiltered(source, target) {
  const info = statSync(source);
  if (info.isDirectory()) {
    if (skip.has(path.basename(source))) return;
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
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else result.push(full);
    }
  }
  walk(root);
  return result.sort((a, b) => a.localeCompare(b, "en"));
}

function digestTree(root, { exclude = new Set() } = {}) {
  const hash = createHash("sha256");
  const entries = [];
  for (const file of files(root)) {
    const relative = path.relative(root, file).replaceAll("\\", "/");
    if (exclude.has(relative)) continue;
    const content = readFileSync(file);
    const digest = createHash("sha256").update(content).digest("hex");
    entries.push({ path: relative, sha256: digest, size_bytes: content.length });
    hash.update(relative).update("\0").update(digest).update("\n");
  }
  return { sha256: hash.digest("hex"), entries };
}

function revision(repo) {
  try { return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { return "unversioned-source"; }
}

rmSync(output, { recursive: true, force: true });
mkdirSync(evalosRoot, { recursive: true });
for (const item of include) copyFiltered(path.join(ROOT, item), path.join(evalosRoot, item));

// The EvalOS bundle owns the comparison adapter, while the frozen V1 source
// remains an external contestant copied beside it. Runtime dependencies are
// inherited from the already accepted immutable M1 release on EvalLab.
const langgraphRoot = path.join(output, "langgraph");
for (const item of ["src", "knowledge_packs", "pyproject.toml", "README.md"]) {
  copyFiltered(path.join(langgraphSource, item), path.join(langgraphRoot, item));
}

const pluginSource = path.join(ROOT, "packages", "agent-runtime", "opsmind-plugin");
const pluginRoot = path.join(output, "opsmind-plugin");
copyFiltered(pluginSource, pluginRoot);

const mutableManifestPaths = new Set(["config/m15-pilot.manifest.json", "config/m15-real-preflight.manifest.json"]);
const evalosDigest = digestTree(evalosRoot, { exclude: mutableManifestPaths });
const langgraphDigest = digestTree(langgraphRoot);
const pluginDigest = digestTree(pluginRoot);
const sourceRevision = `${revision(ROOT)}+tree.${evalosDigest.sha256.slice(0, 16)}`;
const langgraphRevision = revision(langgraphSource);
const runnerBaseUrl = process.env.M15_ANTHROPIC_BASE_URL ?? "https://api.deepseek.com/anthropic";
if (!/^https:\/\//.test(runnerBaseUrl)) throw new Error("M15_ANTHROPIC_BASE_URL must use HTTPS");
const pilotPath = path.join(evalosRoot, "config", "m15-pilot.manifest.json");
const pilot = JSON.parse(readFileSync(pilotPath, "utf8"));
pilot.contestants = pilot.contestants.map((item) => item.ref === "agent-harness-v2"
  ? { ...item, source_revision: sourceRevision, artifact_digest: `sha256:${evalosDigest.sha256}` }
  : { ...item, source_revision: langgraphRevision, artifact_digest: `sha256:${langgraphDigest.sha256}` });
writeFileSync(pilotPath, `${JSON.stringify(pilot, null, 2)}\n`, "utf8");
const preflight = { ...pilot, name: "M1.5 L1 v2 真实双架构预检", case_refs: [pilot.case_refs[0]], replicates: 1 };
writeFileSync(path.join(evalosRoot, "config", "m15-real-preflight.manifest.json"), `${JSON.stringify(preflight, null, 2)}\n`, "utf8");

const releaseRunner = `#!/bin/sh
set -eu
MODE=pilot
if [ "\${1:-}" = "--preflight" ]; then MODE=preflight; shift; fi
RELEASE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PREVIOUS_RELEASE=${previousRelease}
cd "$RELEASE_ROOT/evalos"
set -a
. /etc/opsmind/deepSeekParameter
set +a
export ANTHROPIC_BASE_URL="\${ANTHROPIC_BASE_URL:-${runnerBaseUrl}}"
export OPSMIND_LANGGRAPH_PYTHON="$PREVIOUS_RELEASE/langgraph/.venv/bin/python"
export OPSMIND_LANGGRAPH_ROOT="$RELEASE_ROOT/langgraph"
export OPSMIND_PLUGIN_ROOT="$RELEASE_ROOT/opsmind-plugin"
export NODE_PATH="$PREVIOUS_RELEASE/evalos/packages/agent-runtime/node_modules"
if [ ! -e packages/agent-runtime/node_modules ]; then
  ln -s "$PREVIOUS_RELEASE/evalos/packages/agent-runtime/node_modules" packages/agent-runtime/node_modules
fi
if [ "$MODE" = preflight ]; then
  exec /usr/local/bin/node scripts/run-real-m15.mjs --preflight "$@"
fi
exec /usr/local/bin/node scripts/run-real-m15.mjs "$@"
`;
writeFileSync(path.join(output, "run-m15"), releaseRunner, { encoding: "utf8", mode: 0o755 });

const provenance = {
  release_contract: "m15-source-bundle-v1",
  generated_at: new Date().toISOString(),
  previous_release_dependency: previousRelease,
  dependency_policy: "reuse accepted Claude Agent SDK node_modules and LangGraph Python venv without modifying the previous release",
  evalos: { source_revision: sourceRevision, artifact_digest: `sha256:${digestTree(evalosRoot, { exclude: mutableManifestPaths }).sha256}` },
  langgraph: { source_revision: langgraphRevision, artifact_digest: `sha256:${langgraphDigest.sha256}` },
  plugin: { artifact_digest: `sha256:${pluginDigest.sha256}` },
};
writeFileSync(path.join(output, "release-provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, ...provenance }, null, 2));
