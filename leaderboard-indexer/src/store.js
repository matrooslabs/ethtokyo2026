import { DatabaseSync } from 'node:sqlite';
import { json, project } from './domain.js';

export class Store {
  constructor(path, identity, metadata = {}) {
    this.db = new DatabaseSync(path);
    this.metadata = metadata;
    this.identity = identity;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blocks (number INTEGER PRIMARY KEY, hash TEXT NOT NULL, parent_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (block_number INTEGER NOT NULL REFERENCES blocks(number) ON DELETE CASCADE,
        log_index INTEGER NOT NULL, transaction_index INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(block_number, log_index));`);
    const existing = this.db.prepare("SELECT value FROM meta WHERE key='identity'").get();
    const encoded = json({ schema: 1, chainId: String(identity.chainId), address: identity.address.toLowerCase(), deploymentBlock: String(identity.deploymentBlock) });
    if (existing && existing.value !== encoded) {
      this.db.close();
      throw new Error('Database belongs to a different chain, contract, deployment block or schema; use a separate DB_PATH');
    }
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('identity', ?)").run(encoded);
    this.view = project(this.events(), metadata);
  }
  tip() { return this.db.prepare('SELECT number, hash FROM blocks ORDER BY number DESC LIMIT 1').get() ?? null; }
  block(number) { return this.db.prepare('SELECT number, hash FROM blocks WHERE number=?').get(number) ?? null; }
  events() { return this.db.prepare('SELECT payload FROM events ORDER BY block_number, transaction_index, log_index').all().map(r => JSON.parse(r.payload)); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  append(blocks) {
    const view = this.transaction(() => {
      let tip = this.tip();
      for (const block of blocks) {
        const existing = this.block(block.number);
        if (existing) {
          if (existing.hash !== block.hash) throw new Error('Conflicting canonical block; rollback required');
        } else {
          const expected = tip ? tip.number + 1 : Number(this.identity.deploymentBlock);
          if (block.number !== expected || (tip && block.parentHash !== tip.hash)) throw new Error('Non-contiguous block batch');
          this.db.prepare('INSERT INTO blocks VALUES (?, ?, ?)').run(block.number, block.hash, block.parentHash);
          tip = { number: block.number, hash: block.hash };
        }
        for (const event of block.events) {
          if (Number(event.position.blockNumber) !== block.number) throw new Error('Event block mismatch');
          const encoded = json(event);
          const old = this.db.prepare('SELECT payload FROM events WHERE block_number=? AND log_index=?').get(block.number, event.position.logIndex);
          if (old && old.payload !== encoded) throw new Error('Conflicting duplicate event');
          this.db.prepare('INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?)').run(block.number, event.position.logIndex, event.position.transactionIndex, encoded);
        }
      }
      return project(this.events(), this.metadata); // Validate before committing the checkpoint.
    });
    this.view = view;
  }
  rollback(afterBlock) {
    const view = this.transaction(() => {
      this.db.prepare('DELETE FROM blocks WHERE number > ?').run(afterBlock);
      return project(this.events(), this.metadata);
    });
    this.view = view;
  }
  rebuild() { this.rollback(-1); }
  close() { this.db.close(); }
}
