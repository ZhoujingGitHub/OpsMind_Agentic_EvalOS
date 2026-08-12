import { entityId, isoNow, sha256, stableStringify } from "./utils.mjs";

const GENESIS = "0".repeat(64);

export class EvaluationLedger {
  constructor(store) {
    this.store = store;
  }

  append({ entityType, entityId: targetId, action, payload }) {
    return this.store.transaction(() => {
      const previous = this.store.db.prepare("SELECT entry_hash FROM ledger_entries ORDER BY seq DESC LIMIT 1").get();
      const prevHash = previous?.entry_hash ?? GENESIS;
      const timestamp = isoNow();
      const canonical = {
        timestamp,
        entity_type: entityType,
        entity_id: targetId,
        action,
        payload,
        prev_hash: prevHash,
      };
      const entryHash = sha256(canonical);
      const id = entityId("ledger", entryHash);
      const result = this.store.db.prepare(`
        INSERT INTO ledger_entries(id,timestamp,entity_type,entity_id,action,payload_json,prev_hash,entry_hash)
        VALUES(?,?,?,?,?,?,?,?)
      `).run(id, timestamp, entityType, targetId, action, stableStringify(payload), prevHash, entryHash);
      return { seq: Number(result.lastInsertRowid), id, ...canonical, entry_hash: entryHash };
    });
  }

  entries() {
    return this.store.db.prepare("SELECT * FROM ledger_entries ORDER BY seq").all().map((row) => ({
      ...row,
      payload: JSON.parse(row.payload_json),
    }));
  }

  verify() {
    const entries = this.entries();
    let expectedPrev = GENESIS;
    const errors = [];
    for (const entry of entries) {
      if (entry.prev_hash !== expectedPrev) errors.push({ seq: entry.seq, reason: "previous hash mismatch" });
      const expectedHash = sha256({
        timestamp: entry.timestamp,
        entity_type: entry.entity_type,
        entity_id: entry.entity_id,
        action: entry.action,
        payload: entry.payload,
        prev_hash: entry.prev_hash,
      });
      if (entry.entry_hash !== expectedHash) errors.push({ seq: entry.seq, reason: "entry hash mismatch" });
      expectedPrev = entry.entry_hash;
    }
    return {
      valid: errors.length === 0,
      entries: entries.length,
      head_hash: entries.at(-1)?.entry_hash ?? GENESIS,
      errors,
    };
  }
}

