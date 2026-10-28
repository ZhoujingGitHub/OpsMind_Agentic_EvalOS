#!/usr/bin/env node
// Archive old candidate-relay evidence out of the control database. **Exam host,
// services stopped** (node:sqlite is synchronous; a multi-gigabyte delete or a
// VACUUM inside the running service stalls every trial — RUNBOOK 25c).
//
//   node --experimental-sqlite scripts/archive-relay-evidence.mjs \
//     --before 2026-09-14 --out /srv/opsmind-evidence/relay-archive-pre-20260914 [--apply] [--vacuum]
//
// Without --apply it only exports and verifies: nothing in the database changes.
// With --apply it verifies the archive against the live rows again, then deletes
// them and writes the ledger entry in one transaction. --vacuum then gives the
// freed pages back to the file system.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { openControlStore } from "../packages/kernel/src/control-store.mjs";
import { exportRelayEvidence, removeArchivedRelayEvidence, verifyRelayArchive } from "../packages/kernel/src/relay-archive.mjs";

const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const before = value("--before");
const outDir = value("--out");
const databasePath = value("--database") ?? "/var/lib/opsmind-evalos/control/control.sqlite";
if (!before || !outDir) {
  console.error("usage: archive-relay-evidence.mjs --before YYYY-MM-DD --out DIR [--apply] [--vacuum] [--database PATH]");
  process.exit(2);
}
for (const unit of ["opsmind-evalos", "opsmind-evalos-console"]) {
  let state = "inactive";
  try { state = execFileSync("systemctl", ["is-active", unit], { encoding: "utf8" }).trim(); } catch { /* inactive */ }
  if (state === "active") { console.error(`${unit} is running; stop the services first`); process.exit(2); }
}

const store = openControlStore({ databasePath, runtimeRoot: path.dirname(databasePath) });
try {
  const manifestFile = path.join(outDir, "MANIFEST.json");
  const manifest = existsSync(manifestFile)
    ? await verifyRelayArchive(outDir, store.db)
    : await exportRelayEvidence(store.db, { before, outDir });
  if (!existsSync(manifestFile)) throw new Error("manifest was not written");
  await verifyRelayArchive(outDir, store.db);
  console.log(JSON.stringify({ step: "archived_and_verified", ...manifest }));
  if (args.includes("--apply")) {
    const result = await removeArchivedRelayEvidence(store, outDir, { archiveRef: `exam-host:${path.resolve(outDir)}` });
    console.log(JSON.stringify({ step: "removed", requests: result.requests, response_bodies: result.bodies,
      ledger_entry: result.ledger_entry }));
    if (args.includes("--vacuum")) {
      const started = Date.now();
      store.db.exec("VACUUM");
      console.log(JSON.stringify({ step: "vacuumed", seconds: Math.round((Date.now() - started) / 1000) }));
    }
  }
} finally { store.close(); }
