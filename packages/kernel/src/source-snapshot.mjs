import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { sha256, stableStringify } from "./utils.mjs";
import { containsSensitiveMaterial } from "./redaction.mjs";

const CODE_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".css", ".go", ".h", ".html", ".java", ".js", ".jsx",
  ".json", ".md", ".mjs", ".py", ".rs", ".sh", ".sql", ".toml", ".ts", ".tsx", ".yaml", ".yml"]);
const CODE_FILES = new Set(["Dockerfile", "Makefile", "package-lock.json", "package.json", "pyproject.toml", "requirements.txt"]);
const DENY_SEGMENTS = new Set([".git", ".next", ".claude-state", "artifacts", "coverage", "dist", "node_modules", "private", "runtime"]);
const SECRET_NAME = /(?:^|[._-])(?:env|credential|credentials|secret|secrets|token|tokens|password|passwd|id_rsa|known_hosts)(?:$|[._-])/i;
const contentDigest = (content) => createHash("sha256").update(content).digest("hex");

function normalizeRelative(value) {
  const normalized = String(value).replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`invalid snapshot path: ${value}`);
  }
  return normalized;
}

function sourceFiles(root, prefix, limits) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (DENY_SEGMENTS.has(entry.name) || SECRET_NAME.test(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { walk(absolute); continue; }
      if (!stat.isFile()) continue;
      if (!CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && !CODE_FILES.has(entry.name)) continue;
      if (stat.size > limits.maxFileBytes) throw new Error(`source file exceeds snapshot limit: ${absolute}`);
      const relative = normalizeRelative(path.posix.join(prefix, path.relative(root, absolute).replaceAll("\\", "/")));
      const content = readFileSync(absolute);
      if (containsSensitiveMaterial(content.toString("utf8"))) throw new Error(`source file contains credential-shaped material: ${absolute}`);
      files.push({ absolute, path: relative, size_bytes: stat.size, sha256: contentDigest(content) });
    }
  };
  walk(root);
  return files;
}

export function freezeSourceSnapshot({ roots, storageRoot, contestantRef, sourceRevision, artifactDigest,
  maxFileBytes = 2 * 1024 * 1024, maxTotalBytes = 32 * 1024 * 1024 } = {}) {
  if (!Array.isArray(roots) || !roots.length) throw new Error("at least one explicit source root is required");
  if (!contestantRef || !sourceRevision || !/^sha256:[a-f0-9]{64}$/.test(String(artifactDigest))) {
    throw new Error("contestantRef, sourceRevision and a frozen sha256 artifactDigest are required");
  }
  const limits = { maxFileBytes };
  const files = roots.flatMap((item, index) => {
    const root = path.resolve(typeof item === "string" ? item : item.path);
    if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error(`source root is not a directory: ${root}`);
    const prefix = normalizeRelative(typeof item === "string" ? `root-${index + 1}` : (item.prefix ?? `root-${index + 1}`));
    return sourceFiles(root, prefix, limits);
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (!files.length) throw new Error("source snapshot contains no permitted code files");
  const total = files.reduce((sum, file) => sum + file.size_bytes, 0);
  if (total > maxTotalBytes) throw new Error(`source snapshot exceeds ${maxTotalBytes} bytes`);
  const manifestFiles = files.map(({ absolute: _absolute, ...file }) => file);
  const treeHash = sha256(manifestFiles.map(({ path: filePath, sha256: digest, size_bytes: size }) => ({ path: filePath, sha256: digest, size_bytes: size })));
  const destination = path.join(path.resolve(storageRoot), treeHash);
  const filesRoot = path.join(destination, "files");
  mkdirSync(filesRoot, { recursive: true });
  for (const file of files) {
    const output = path.join(filesRoot, ...file.path.split("/"));
    mkdirSync(path.dirname(output), { recursive: true });
    if (!existsSync(output)) copyFileSync(file.absolute, output);
    if (contentDigest(readFileSync(output)) !== file.sha256) throw new Error(`snapshot verification failed: ${file.path}`);
  }
  const manifest = Object.freeze({
    contract: "evalos-source-snapshot.1", contestant_ref: contestantRef, source_revision: sourceRevision,
    artifact_digest: artifactDigest, tree_hash: treeHash, file_count: files.length, size_bytes: total, files: manifestFiles,
  });
  const manifestPath = path.join(destination, "manifest.json");
  if (existsSync(manifestPath)) {
    const existing = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (stableStringify(existing) !== stableStringify(manifest)) throw new Error("content-addressed snapshot manifest conflict");
  } else writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o444 });
  return { ...manifest, storage_path: destination };
}

export function listSnapshotFiles(snapshot) {
  return [...(snapshot?.manifest?.files ?? snapshot?.files ?? [])].map((file) => ({ ...file }));
}

export function readSnapshotFile(snapshot, requestedPath, { maxBytes = 512 * 1024 } = {}) {
  const relative = normalizeRelative(requestedPath);
  const file = listSnapshotFiles(snapshot).find((item) => item.path === relative);
  if (!file) throw new Error("source file is not part of the immutable snapshot");
  if (file.size_bytes > maxBytes) throw new Error("source file is too large for interactive inspection");
  const root = path.resolve(snapshot.storage_path, "files");
  const absolute = path.resolve(root, ...relative.split("/"));
  const rel = path.relative(root, absolute);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("source file path escaped snapshot root");
  const content = readFileSync(absolute, "utf8");
  if (contentDigest(Buffer.from(content, "utf8")) !== file.sha256) throw new Error("source snapshot file digest mismatch");
  return { path: relative, content, sha256: file.sha256, size_bytes: file.size_bytes };
}

export function searchSnapshotFiles(snapshot, query, { limit = 50, maxBytes = 512 * 1024 } = {}) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (needle.length < 2 || needle.length > 128) throw new Error("source search query must contain 2-128 characters");
  const matches = [];
  for (const file of listSnapshotFiles(snapshot)) {
    if (file.size_bytes > maxBytes) continue;
    const source = readSnapshotFile(snapshot, file.path, { maxBytes }).content;
    const lines = source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const column = lines[index].toLowerCase().indexOf(needle);
      if (column < 0) continue;
      matches.push({ path: file.path, line: index + 1, column: column + 1, preview: lines[index].trim().slice(0, 240) });
      if (matches.length >= limit) return matches;
    }
  }
  return matches;
}

export function materializeSnapshotView(snapshot, destination) {
  const root = path.resolve(destination);
  if (existsSync(root)) throw new Error("source view destination must be new");
  mkdirSync(root, { recursive: true, mode: 0o755 });
  const directories = new Set([root]);
  for (const file of listSnapshotFiles(snapshot)) {
    const source = readSnapshotFile(snapshot, file.path, { maxBytes: 2 * 1024 * 1024 });
    const output = path.resolve(root, ...file.path.split("/"));
    const relative = path.relative(root, output);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("snapshot view path escaped destination");
    const directory = path.dirname(output);
    mkdirSync(directory, { recursive: true, mode: 0o755 });
    let current = directory;
    while (current === root || current.startsWith(`${root}${path.sep}`)) {
      directories.add(current);
      if (current === root) break;
      current = path.dirname(current);
    }
    writeFileSync(output, source.content, { encoding: "utf8", mode: 0o444 });
    if (contentDigest(readFileSync(output)) !== file.sha256) throw new Error(`source view verification failed: ${file.path}`);
    chmodSync(output, 0o444);
  }
  [...directories].sort((left, right) => right.length - left.length).forEach((directory) => chmodSync(directory, 0o555));
  return { path: root, tree_hash: snapshot.tree_hash, file_count: listSnapshotFiles(snapshot).length };
}
