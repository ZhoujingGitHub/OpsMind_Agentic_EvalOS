import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const matrixPath = path.join(root, "config", "m31-capability-protection.json");
const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));

if (matrix.contract !== "evalos-capability-protection.1" || matrix.milestone !== "M3.1") {
  throw new Error("M3.1 capability protection contract is missing or invalid");
}
if (!Array.isArray(matrix.capabilities) || matrix.capabilities.length !== 20) {
  throw new Error("M3.1 must protect exactly CAP-001 through CAP-020");
}
const expected = Array.from({ length: 20 }, (_, index) => `CAP-${String(index + 1).padStart(3, "0")}`);
const actual = matrix.capabilities.map((item) => item.id);
if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("capability ids must be complete and ordered");

for (const capability of matrix.capabilities) {
  if (!capability.name || !capability.owner || !["architecture", "test", "browser"].includes(capability.verification)) {
    throw new Error(`${capability.id} is missing name, owner or verification mode`);
  }
  if (!Array.isArray(capability.evidence) || capability.evidence.length === 0) {
    throw new Error(`${capability.id} has no implementation evidence`);
  }
  for (const relative of capability.evidence) {
    const target = path.join(root, relative);
    if (!existsSync(target)) throw new Error(`${capability.id} evidence is missing: ${relative}`);
    const status = statSync(target);
    if ((status.isFile() && status.size === 0) || (status.isDirectory() && readdirSync(target).length === 0)) {
      throw new Error(`${capability.id} evidence is empty: ${relative}`);
    }
  }
}

console.log(`M3.1 capability protection ready: ${matrix.capabilities.length}/20 capabilities mapped`);
