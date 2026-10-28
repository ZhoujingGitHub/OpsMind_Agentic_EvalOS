// Move old candidate-relay evidence out of the hot database into a verified
// archive, with a ledger entry recording exactly what left and where it went.
//
// Why (measured 2026-10-29): of the 16.69 GB of relay payload in the 20.8 GB
// control database, 16.67 GB (124,963 rows) predates 2026-09-14 and belongs to
// trials of retired question banks. Keeping it inline makes every release
// backup a 20 GB copy. The rows are evidence, so they are archived, verified
// and recorded before they are deleted — never just deleted.
//
// Rows are read in insertion (rowid) order. Ordering by created_at has no index
// and makes SQLite sort the whole payload in a temp file first — on 2026-10-29
// that was 17.9 GB of temp writes on a disk with 27 GB free.
//
// The archive is one gzip'd JSON-lines file: one line per relay request, with
// its response body row when there is one. MANIFEST.json carries the counts,
// the time range, a digest over the ordered ids and a digest over the
// uncompressed content, so the archive can be re-verified against the ledger
// entry at any later time.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { createGunzip, createGzip } from "node:zlib";
import { EvaluationLedger } from "./ledger.mjs";

export const RELAY_ARCHIVE_CONTRACT = "evalos-relay-evidence-archive/1.0";
const ARCHIVE_FILE = "relay-requests.jsonl.gz";
// Kept verbatim from migration 004: recreated after the archived rows leave.
const NO_DELETE_TRIGGER = `CREATE TRIGGER candidate_relay_no_delete
BEFORE DELETE ON candidate_relay_requests
BEGIN SELECT RAISE(ABORT, 'candidate relay records are append-only evidence'); END;`;

function assertCutoff(before) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(before ?? ""))) throw new Error("cutoff must be a date, YYYY-MM-DD");
  return before;
}

function scope(db, before) {
  const open = db.prepare(`SELECT COUNT(*) n FROM candidate_relay_requests
    WHERE created_at < ? AND status IN ('QUEUED','LEASED')`).get(before).n;
  if (open) throw new Error(`${open} relay requests before ${before} are still open; refusing to archive live work`);
  return db.prepare(`SELECT COUNT(*) n, MIN(created_at) first, MAX(created_at) last
    FROM candidate_relay_requests WHERE created_at < ?`).get(before);
}

async function writeLines(file, lines) {
  const gzip = createGzip({ level: 6 });
  const sink = createWriteStream(file);
  const done = new Promise((resolve, reject) => { sink.on("finish", resolve); sink.on("error", reject); gzip.on("error", reject); });
  gzip.pipe(sink);
  for (const line of lines) {
    if (!gzip.write(line)) await new Promise((resolve) => gzip.once("drain", resolve));
  }
  gzip.end();
  await done;
}

function fileSha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
  });
}

/** Export every relay request before `before` into `outDir`; returns the manifest. */
export async function exportRelayEvidence(db, { before, outDir }) {
  assertCutoff(before);
  const range = scope(db, before);
  if (!range.n) throw new Error(`no relay requests before ${before}`);
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, ARCHIVE_FILE);
  if (existsSync(file)) throw new Error(`archive already exists: ${file}`);
  const ids = createHash("sha256");
  const content = createHash("sha256");
  let count = 0;
  let bodies = 0;
  const rows = db.prepare(`SELECT r.*, b.body_json AS stored_body_json, b.bytes AS stored_body_bytes,
      b.sha256 AS stored_body_sha256, b.created_at AS stored_body_created_at
    FROM candidate_relay_requests r LEFT JOIN candidate_relay_response_bodies b ON b.request_id = r.id
    WHERE r.created_at < ? ORDER BY r.rowid`).iterate(before);
  function* lines() {
    for (const row of rows) {
      const { stored_body_json: body, stored_body_bytes: bytes, stored_body_sha256: sha, stored_body_created_at: at, ...request } = row;
      const record = { request, response_body: body === null ? null : { body_json: body, bytes, sha256: sha, created_at: at } };
      if (record.response_body) bodies += 1;
      const line = `${JSON.stringify(record)}\n`;
      ids.update(`${request.id}\n`);
      content.update(line);
      count += 1;
      yield line;
    }
  }
  await writeLines(file, lines());
  if (count !== range.n) throw new Error(`exported ${count} rows but ${range.n} were in scope`);
  const manifest = { contract: RELAY_ARCHIVE_CONTRACT, before, order: "rowid", requests: count, response_bodies: bodies,
    first_created_at: range.first, last_created_at: range.last, ids_sha256: ids.digest("hex"),
    content_sha256: content.digest("hex"), archive_file: ARCHIVE_FILE,
    archive_sha256: await fileSha256(file), archive_bytes: statSync(file).size };
  writeFileSync(path.join(outDir, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Re-read the archive and check it against its manifest and, if given, the live rows. */
export async function verifyRelayArchive(outDir, db = null) {
  const manifest = JSON.parse(readFileSync(path.join(outDir, "MANIFEST.json"), "utf8"));
  const file = path.join(outDir, manifest.archive_file);
  if (await fileSha256(file) !== manifest.archive_sha256) throw new Error("archive file digest does not match its manifest");
  const ids = createHash("sha256");
  const content = createHash("sha256");
  let count = 0;
  const reader = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of reader) {
    content.update(`${line}\n`);
    ids.update(`${JSON.parse(line).request.id}\n`);
    count += 1;
  }
  if (count !== manifest.requests) throw new Error(`archive holds ${count} rows, manifest says ${manifest.requests}`);
  if (ids.digest("hex") !== manifest.ids_sha256) throw new Error("archive ids do not match the manifest");
  if (content.digest("hex") !== manifest.content_sha256) throw new Error("archive content does not match the manifest");
  if (db) {
    // Archives written before `order` was recorded (2026-10-29) are in created_at, id order.
    const order = manifest.order === "rowid" ? "rowid" : "created_at, id";
    const live = db.prepare(`SELECT id FROM candidate_relay_requests WHERE created_at < ? ORDER BY ${order}`).iterate(manifest.before);
    const liveIds = createHash("sha256");
    let liveCount = 0;
    for (const row of live) { liveIds.update(`${row.id}\n`); liveCount += 1; }
    if (liveCount !== manifest.requests || liveIds.digest("hex") !== manifest.ids_sha256) {
      throw new Error("the database no longer holds exactly the archived rows");
    }
  }
  return manifest;
}

/**
 * Delete the archived rows and record the move in the ledger, atomically.
 * `store` is an EvalStore (or anything with `db` and `transaction`).
 */
export async function removeArchivedRelayEvidence(store, outDir, { archiveRef }) {
  const manifest = await verifyRelayArchive(outDir, store.db);
  // The ledger entry is written inside the same transaction as the delete, so
  // rows never leave without a record and a record never claims rows that stayed.
  const ledger = new EvaluationLedger({ db: store.db, transaction: (callback) => callback() });
  return store.transaction(() => {
    store.db.exec("DROP TRIGGER candidate_relay_no_delete");
    const bodies = store.db.prepare(`DELETE FROM candidate_relay_response_bodies WHERE request_id IN (
      SELECT id FROM candidate_relay_requests WHERE created_at < ?)`).run(manifest.before).changes;
    const requests = store.db.prepare("DELETE FROM candidate_relay_requests WHERE created_at < ?").run(manifest.before).changes;
    store.db.exec(NO_DELETE_TRIGGER);
    if (requests !== manifest.requests || bodies !== manifest.response_bodies) {
      throw new Error(`deleted ${requests}/${bodies} rows, archive holds ${manifest.requests}/${manifest.response_bodies}`);
    }
    const entry = ledger.append({ entityType: "candidate_relay_archive", entityId: `relay-archive-before-${manifest.before}`,
      action: "relay_evidence.archived", payload: { ...manifest, archive_ref: archiveRef,
        removed_requests: requests, removed_response_bodies: bodies } });
    return { manifest, requests, bodies, ledger_entry: entry.entry_hash };
  });
}
