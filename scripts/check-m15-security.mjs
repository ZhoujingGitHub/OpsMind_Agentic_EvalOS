import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" })
  .trim().split(/\r?\n/).filter(Boolean);
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:api[_-]?key|access[_-]?key|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9_\-]{20,}["']/i,
  /Bearer\s+[A-Za-z0-9._\-]{24,}/i,
];
const findings = [];
for (const file of tracked) {
  if (/package-lock\.json$|\.docx$|\.jpg$|\.png$/.test(file)) continue;
  let text;
  try { text = readFileSync(path.join(root, file), "utf8"); } catch { continue; }
  if (secretPatterns.some((pattern) => pattern.test(text))) findings.push(file);
}
const result = { status: findings.length ? "FAILED" : "PASSED", scanned_files: tracked.length, findings };
console.log(JSON.stringify(result, null, 2));
if (findings.length) process.exitCode = 1;
