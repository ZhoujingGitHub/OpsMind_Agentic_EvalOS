import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { openControlStore } from "../src/control-store.mjs";
import { EvaluationLedger } from "../src/ledger.mjs";
import { exportRelayEvidence, removeArchivedRelayEvidence, verifyRelayArchive } from "../src/relay-archive.mjs";

function seeded() {
  const root = mkdtempSync(path.join(os.tmpdir(), "evalos-relay-archive-"));
  const store = openControlStore({ databasePath: path.join(root, "control.sqlite"), runtimeRoot: root });
  const insert = store.db.prepare(`INSERT INTO candidate_relay_requests(id,candidate_ref,credential_role,method,pathname,
    headers_json,request_body_json,request_hash,status,created_at,completed_at,response_status,response_body_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const rows = [["relay-old-1", "2026-09-01T00:00:00.000Z"], ["relay-old-2", "2026-09-13T23:59:59.000Z"],
    ["relay-new-1", "2026-09-14T00:00:00.000Z"]];
  for (const [id, at] of rows) {
    insert.run(id, "langgraph-v1", "candidate_submitter", "POST", "/api/v1/investigations", "{}", '{"q":"中文"}',
      `hash-${id}`, "COMPLETED", at, at, 200, '{"ok":true}');
  }
  store.db.prepare("INSERT INTO candidate_relay_response_bodies(request_id,body_json,bytes,sha256,created_at) VALUES(?,?,?,?,?)")
    .run("relay-old-1", '{"large":true}', 14, "abc", "2026-09-01T00:00:01.000Z");
  return { root, store };
}

test("旧中继存证先归档、核对，再在同一事务里删除并记账", async () => {
  const { root, store } = seeded();
  try {
    const out = path.join(root, "archive");
    const manifest = await exportRelayEvidence(store.db, { before: "2026-09-14", outDir: out });
    assert.equal(manifest.requests, 2);
    assert.equal(manifest.response_bodies, 1);
    const lines = gunzipSync(readFileSync(path.join(out, manifest.archive_file))).toString("utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(lines.map((line) => line.request.id), ["relay-old-1", "relay-old-2"]);
    assert.equal(lines[0].request.request_body_json, '{"q":"中文"}');
    assert.equal(lines[0].response_body.body_json, '{"large":true}');
    assert.equal(lines[1].response_body, null);
    // Rows are still in place until removal is asked for separately.
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM candidate_relay_requests").get().n, 3);

    const removed = await removeArchivedRelayEvidence(store, out, { archiveRef: "exam-host:/srv/opsmind-evidence/test" });
    assert.equal(removed.requests, 2);
    assert.equal(removed.bodies, 1);
    assert.deepEqual(store.db.prepare("SELECT id FROM candidate_relay_requests").all().map((row) => row.id), ["relay-new-1"]);
    // The append-only guard is back in force for everything that stayed.
    assert.throws(() => store.db.prepare("DELETE FROM candidate_relay_requests").run(), /append-only evidence/);
    const entry = store.db.prepare("SELECT * FROM ledger_entries WHERE action='relay_evidence.archived'").get();
    assert.equal(JSON.parse(entry.payload_json).ids_sha256, manifest.ids_sha256);
    assert.equal(new EvaluationLedger(store).verify().valid, true);
    // The archive still verifies after the rows are gone.
    assert.equal((await verifyRelayArchive(out)).requests, 2);
  } finally { store.close(); }
});

test("归档与库不一致、或范围内还有未完成请求时拒绝删除", async () => {
  const { root, store } = seeded();
  try {
    const out = path.join(root, "archive");
    const manifest = await exportRelayEvidence(store.db, { before: "2026-09-14", outDir: out });
    const file = path.join(out, manifest.archive_file);
    const tampered = gunzipSync(readFileSync(file)).toString("utf8").split("\n").slice(0, 1).join("\n") + "\n";
    writeFileSync(file, gzipSync(tampered));
    await assert.rejects(removeArchivedRelayEvidence(store, out, { archiveRef: "x" }), /digest does not match/);
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM candidate_relay_requests").get().n, 3);

    store.db.prepare(`INSERT INTO candidate_relay_requests(id,candidate_ref,credential_role,method,pathname,headers_json,
      request_hash,status,created_at) VALUES('relay-open','langgraph-v1','candidate_submitter','GET','/x','{}','h','QUEUED',
      '2026-09-02T00:00:00.000Z')`).run();
    await assert.rejects(exportRelayEvidence(store.db, { before: "2026-09-14", outDir: path.join(root, "again") }), /still open/);
  } finally { store.close(); }
});
