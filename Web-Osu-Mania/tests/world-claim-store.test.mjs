import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

test('one World human and wallet cannot claim both charts of a challenge', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_world_identity.sql', import.meta.url), 'utf8'));
  const add = db.prepare('INSERT INTO world_identity_bindings (challenge_id, difficulty, nullifier, wallet) VALUES (?, ?, ?, ?)');
  const first = '0x' + '11'.repeat(32);
  const next = '0x' + '22'.repeat(32);
  const human = '0x' + 'ab'.repeat(32);
  const otherHuman = '0x' + 'cd'.repeat(32);
  add.run(first, 'easy', human, '0xwallet1');
  assert.throws(() => add.run(first, 'hard', human, '0xwallet2'), /UNIQUE constraint failed/);
  assert.throws(() => add.run(first, 'hard', otherHuman, '0xwallet1'), /UNIQUE constraint failed/);
  add.run(next, 'hard', human, '0xwallet2');
  assert.equal(db.prepare('SELECT difficulty FROM world_identity_bindings WHERE challenge_id = ? AND nullifier = ?').get(next, human).difficulty, 'hard');
  db.close();
});
