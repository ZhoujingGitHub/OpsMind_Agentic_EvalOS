import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] ?? path.join(ROOT, ".deploy", "m2-release"));
const evalosRoot = path.join(output, "evalos");
const langgraphRoot = path.join(output, "langgraph");
const langgraphSource = path.resolve(ROOT, "../OpsMind-LangGraph");
const previousRelease = process.env.M2_PREVIOUS_RELEASE ?? "/opt/opsmind-evalos/releases/m1-20260813-82e8c0fe";
const include = ["apps", "config", "docs/contracts", "infra", "packages", "scripts", "services", "package.json"];
const langgraphInclude = ["src", "knowledge_packs", "pyproject.toml"];
const skip = new Set(["node_modules", "runtime", "artifacts", ".git", "__pycache__", ".pytest_cache", ".venv", ".next", ".vinext"]);

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
      if (statSync(full).isDirectory()) walk(full);
      else result.push(full);
    }
  }
  walk(root);
  return result.sort((a, b) => a.localeCompare(b, "en"));
}

function digestTree(root, exclude = new Set()) {
  const tree = createHash("sha256");
  const entries = [];
  for (const file of files(root)) {
    const relative = path.relative(root, file).replaceAll("\\", "/");
    if (exclude.has(relative)) continue;
    const content = readFileSync(file);
    const sha = createHash("sha256").update(content).digest("hex");
    entries.push({ path: relative, sha256: sha, size_bytes: content.length });
    tree.update(relative).update("\0").update(sha).update("\n");
  }
  return { sha256: tree.digest("hex"), entries };
}

function digestSelection(root, selections) {
  const selected = new Set();
  for (const relative of selections) {
    const full = path.join(root, relative);
    if (statSync(full).isDirectory()) files(full).forEach((file) => selected.add(file));
    else selected.add(full);
  }
  const tree = createHash("sha256");
  const entries = [...selected].sort((left, right) => left.localeCompare(right, "en")).map((file) => {
    const relative = path.relative(root, file).replaceAll("\\", "/");
    const content = readFileSync(file);
    const sha = createHash("sha256").update(content).digest("hex");
    tree.update(relative).update("\0").update(sha).update("\n");
    return { path: relative, sha256: sha, size_bytes: content.length };
  });
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

const mutable = new Set(["config/m2-agent-acceptance.manifest.json", "config/m2-adapter-qualification.manifest.json"]);
const platformDigest = digestTree(evalosRoot, mutable);
const contestantDigest = digestSelection(evalosRoot, [
  "packages/agent-runtime/src",
  "packages/agent-runtime/opsmind-plugin",
  "packages/agent-runtime/package.json",
  "packages/agent-runtime/package-lock.json",
]);
const langgraphDigest = digestTree(langgraphRoot);
const platformSourceRevision = `${revision(ROOT)}+platform.${platformDigest.sha256.slice(0, 16)}`;
const sourceRevision = `${revision(ROOT)}+contestant.${contestantDigest.sha256.slice(0, 16)}`;
const langgraphRevision = `${revision(langgraphSource)}+tree.${langgraphDigest.sha256.slice(0, 16)}`;
const manifestPath = path.join(evalosRoot, "config", "m2-agent-acceptance.manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.contestants = manifest.contestants.map((item) => ({ ...item, source_revision: sourceRevision,
  artifact_digest: `sha256:${contestantDigest.sha256}` }));
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
const qualificationManifestPath = path.join(evalosRoot, "config", "m2-adapter-qualification.manifest.json");
const qualificationManifest = JSON.parse(readFileSync(qualificationManifestPath, "utf8"));
qualificationManifest.contestants = qualificationManifest.contestants.map((item) => item.ref === "agent-harness-v2"
  ? { ...item, source_revision: sourceRevision, artifact_digest: `sha256:${contestantDigest.sha256}` }
  : { ...item, source_revision: langgraphRevision, artifact_digest: `sha256:${langgraphDigest.sha256}` });
writeFileSync(qualificationManifestPath, `${JSON.stringify(qualificationManifest, null, 2)}\n`, "utf8");

const releaseRunner = `#!/bin/sh
set -eu
RELEASE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PREVIOUS_RELEASE=${previousRelease}
cd "$RELEASE_ROOT/evalos"
set -a
. /etc/opsmind/deepSeekParameter
set +a
export ANTHROPIC_BASE_URL="\${ANTHROPIC_BASE_URL:-https://api.deepseek.com/anthropic}"
export EVALOS_TWIN_HOST="\${EVALOS_TWIN_HOST:-114.215.189.185}"
export EVALOS_TWIN_USER="\${EVALOS_TWIN_USER:-evalos-twin}"
export EVALOS_TWIN_SSH_KEY="\${EVALOS_TWIN_SSH_KEY:-/etc/opsmind-evalos/keys/m2-twin-ed25519}"
export EVALOS_TWIN_KNOWN_HOSTS="\${EVALOS_TWIN_KNOWN_HOSTS:-/etc/opsmind-evalos/keys/m2-twin-known_hosts}"
export EVALOS_TWIN_USE_SUDO="\${EVALOS_TWIN_USE_SUDO:-1}"
export M2_AGENT_RUNTIME_ROOT="\${M2_AGENT_RUNTIME_ROOT:-/var/lib/opsmind-evalos/runtime/m2-agent}"
export M2_AGENT_OUTPUT="\${M2_AGENT_OUTPUT:-/var/lib/opsmind-evalos/artifacts/m2-agent}"
export OPSMIND_PLUGIN_ROOT="$RELEASE_ROOT/evalos/packages/agent-runtime/opsmind-plugin"
export NODE_PATH="$PREVIOUS_RELEASE/evalos/packages/agent-runtime/node_modules"
if [ ! -e packages/agent-runtime/node_modules ]; then
  echo "M2 release dependency link is missing; installation must create packages/agent-runtime/node_modules as root" >&2
  exit 78
fi
exec /usr/local/bin/node scripts/run-real-m2.mjs "$@"
`;
writeFileSync(path.join(output, "run-m2"), releaseRunner, { encoding: "utf8", mode: 0o755 });

const qualificationRunner = `#!/bin/sh
set -eu
RELEASE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PREVIOUS_RELEASE=${previousRelease}
cd "$RELEASE_ROOT/evalos"
set -a
. /etc/opsmind/deepSeekParameter
set +a
export ANTHROPIC_BASE_URL="\${ANTHROPIC_BASE_URL:-https://api.deepseek.com/anthropic}"
export EVALOS_TWIN_HOST="\${EVALOS_TWIN_HOST:-114.215.189.185}"
export EVALOS_TWIN_USER="\${EVALOS_TWIN_USER:-evalos-twin}"
export EVALOS_TWIN_SSH_KEY="\${EVALOS_TWIN_SSH_KEY:-/etc/opsmind-evalos/keys/m2-twin-ed25519}"
export EVALOS_TWIN_KNOWN_HOSTS="\${EVALOS_TWIN_KNOWN_HOSTS:-/etc/opsmind-evalos/keys/m2-twin-known_hosts}"
export EVALOS_TWIN_USE_SUDO="\${EVALOS_TWIN_USE_SUDO:-1}"
export M2_QUALIFICATION_RUNTIME_ROOT="\${M2_QUALIFICATION_RUNTIME_ROOT:-/var/lib/opsmind-evalos/runtime/m2-qualification}"
export M2_QUALIFICATION_OUTPUT="\${M2_QUALIFICATION_OUTPUT:-/var/lib/opsmind-evalos/artifacts/m2-qualification}"
export OPSMIND_PLUGIN_ROOT="$RELEASE_ROOT/evalos/packages/agent-runtime/opsmind-plugin"
export OPSMIND_LANGGRAPH_ROOT="$RELEASE_ROOT/langgraph"
export OPSMIND_LANGGRAPH_PYTHON="$PREVIOUS_RELEASE/langgraph/.venv/bin/python"
export NODE_PATH="$PREVIOUS_RELEASE/evalos/packages/agent-runtime/node_modules"
if [ ! -e packages/agent-runtime/node_modules ]; then
  echo "M2 release dependency link is missing; installation must create packages/agent-runtime/node_modules as root" >&2
  exit 78
fi
exec /usr/local/bin/node scripts/run-m2-adapter-qualification.mjs "$@"
`;
writeFileSync(path.join(output, "run-m2-qualification"), qualificationRunner, { encoding: "utf8", mode: 0o755 });

const finalDigest = digestTree(output);
const provenance = {
  release_contract: "m2-source-bundle-v1",
  generated_at: new Date().toISOString(),
  previous_release_dependency: previousRelease,
  dependency_policy: "只读复用已验收 M1 发布中的 Claude Agent SDK node_modules 与 LangGraph Python venv，不修改旧发布目录",
  execution: "real DeepSeek V4 Flash through Claude Agent SDK or frozen LangGraph adapter, both through the same real protocol Twin Harness",
  source_revision: sourceRevision,
  contestant_artifact_digest: `sha256:${contestantDigest.sha256}`,
  platform_source_revision: platformSourceRevision,
  platform_artifact_digest: `sha256:${platformDigest.sha256}`,
  langgraph_source_revision: langgraphRevision,
  langgraph_artifact_digest: `sha256:${langgraphDigest.sha256}`,
  release_tree_digest: `sha256:${finalDigest.sha256}`,
  inventory: finalDigest.entries,
};
writeFileSync(path.join(output, "release-provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, ...provenance, inventory: undefined }, null, 2));
