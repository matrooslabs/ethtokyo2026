import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Indexer } from '../src/sync.js';
import { project, json, roundKey } from '../src/domain.js';
import { createApi } from '../src/api.js';

const chart = `0x${'ab'.repeat(32)}`, otherChart = `0x${'cd'.repeat(32)}`;
const alice = `0x${'11'.repeat(20)}`, bob = `0x${'22'.repeat(20)}`;
const identity = { chainId: '31337', address: `0x${'33'.repeat(20)}`, deploymentBlock: '10' };
const hash = (n, fork = 0) => `0x${(BigInt(n) + BigInt(fork) * 1000n).toString(16).padStart(64, '0')}`;
const event = (type, n, log, fields = {}) => ({ type, chartHash: chart, dayId: '20000',
  position: { blockNumber: String(n), blockHash: hash(n), transactionIndex: 0, logIndex: log, transactionHash: hash(n * 10) }, ...fields });
const entry = (id, n, log, player = alice, extra = {}) => event('entry', n, log, { sessionId: String(id), payer: player, player, amount: '1000000', ...extra });
const score = (id, value, n, log, player = alice, extra = {}) => event('score', n, log, { sessionId: String(id), player, score: String(value), ...extra });
const block = (n, events = [], fork = 0, parent = hash(n - 1, fork)) => ({ number: n, hash: hash(n, fork), parentHash: parent,
  events: events.map(e => ({ ...e, position: { ...e.position, blockHash: hash(n, fork) } })) });
class FakeSource {
  constructor(blocks) { this.blocks = new Map(blocks.map(b => [b.number, b])); this.reads = []; }
  async head() { return Math.max(...this.blocks.keys()); }
  async block(n) { this.reads.push(n); if (!this.blocks.has(n)) throw new Error(`Missing block ${n}`); return this.blocks.get(n); }
  async events(from, to) { return [...this.blocks.values()].filter(b => b.number >= from && b.number <= to).flatMap(b => b.events); }
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'leaderboard-test-'));
  const path = join(dir, 'index.sqlite');
  const stores = [];
  const open = () => { const store = new Store(path, identity); stores.push(store); return store; };
  t.after(() => { for (const store of stores) { try { store.close(); } catch {} } rmSync(dir, { recursive: true, force: true }); });
  return { path, open };
}

test('every scored attempt gets a rank, with ties ordered by transaction/log acceptance', () => {
  const entries = [entry(1, 10, 0), entry(2, 10, 1, bob), entry(3, 10, 2), entry(4, 10, 3), entry(5, 10, 4, bob)];
  const accepted = [score(1, 0, 11, 0), score(2, 100, 11, 2, bob), score(3, 100, 11, 3), score(4, 100, 11, 4), score(5, 50, 12, 0, bob)];
  accepted[1].position.transactionIndex = 1;
  accepted[2].position.transactionIndex = 2;
  accepted[3].position.transactionIndex = 2;
  const view = project([...accepted, ...entries].reverse());
  const round = view.rounds.get(roundKey(chart, '20000'));
  assert.deepEqual(round.rankings.map(r => [r.rank, r.player, r.score, r.sessionId]), [
    [1, bob, '100', '2'], [2, alice, '100', '3'], [3, alice, '100', '4'], [4, bob, '50', '5'], [5, alice, '0', '1'],
  ]);
  assert.equal(view.attempts.get('1').score, '0');
  assert.equal(round.pot, '5000000');
  assert.equal(round.acceptedScores, 5);
  assert.equal(project([...entries, ...accepted, ...entries]).rounds.get(roundKey(chart, '20000')).entries, 5);
});

test('isolates charts/days and refunds payer; accounts paid, refunded, claimed and remaining totals', () => {
  const events = [entry(1, 10, 0), score(1, 0, 11, 0), event('payout', 12, 0, { recipient: alice, amount: '1000000' }),
    entry(2, 12, 1, bob, { payer: alice, dayId: '20001' }),
    event('refund', 13, 0, { recipient: alice, amount: '1000000', dayId: '20001' }),
    entry(3, 13, 1, bob, { chartHash: otherChart })];
  const view = project(events);
  assert.equal(view.rounds.size, 3);
  assert.equal(view.rounds.get(roundKey(chart, '20000')).claimed, true);
  assert.equal(view.charts.get(chart).remainingPot, '0');
  assert.equal(view.charts.get(chart).totalPaid, '2000000');
  assert.equal(view.charts.get(otherChart).remainingPot, '1000000');
  assert.equal(view.settlements[1].recipient, alice);
  assert.throws(() => project([score(99, 0, 10, 0)]), /without matching paid entry/);
  assert.throws(() => project([entry(1, 10, 0), score(1, 0, 11, 0), event('refund', 12, 0, { recipient: alice, amount: '1000000' })]), /Refund with accepted score/);
});

test('disk restart, duplicate batch, empty blocks, full deployment rebuild yield identical projections', async t => {
  const { open } = fixture(t);
  const blocks = [block(10, [entry(1, 10, 0)]), block(11), block(12, [score(1, 42, 12, 0)]), block(13)];
  const source = new FakeSource(blocks);
  const store = open();
  const indexer = new Indexer(store, source, { confirmations: 0, batchSize: 2 });
  await indexer.sync();
  const expected = json([...store.view.rounds.values()]);
  store.append(blocks);
  assert.equal(store.events().length, 2);
  store.close();
  const restarted = open();
  const resume = new Indexer(restarted, source, { confirmations: 0 });
  await resume.sync();
  assert.equal(restarted.tip().number, 13);
  assert.equal(json([...restarted.view.rounds.values()]), expected);
  restarted.rebuild();
  assert.equal(restarted.tip(), null);
  await resume.sync();
  assert.equal(json([...restarted.view.rounds.values()]), expected);
  assert.equal(resume.status().lag, '0');
});

test('reorg rolls back payouts, scores and entries across restart, including fork before deployment', async t => {
  const { open } = fixture(t);
  const source = new FakeSource([block(10, [entry(1, 10, 0)]), block(11, [score(1, 99, 11, 0)]), block(12, [event('payout', 12, 0, { recipient: alice, amount: '1000000' })])]);
  const store = open();
  await new Indexer(store, source, { confirmations: 0 }).sync();
  store.close();
  const restarted = open();
  source.blocks.set(11, block(11, [entry(2, 11, 0, bob)], 1, hash(10)));
  source.blocks.set(12, block(12, [score(2, 0, 12, 0, bob)], 1));
  const sync = new Indexer(restarted, source, { confirmations: 0 });
  await sync.sync();
  const round = restarted.view.rounds.get(roundKey(chart, '20000'));
  assert.equal(round.leader.player, bob);
  assert.equal(round.claimed, false);
  assert.equal(round.remainingPot, '2000000');
  assert.equal(restarted.view.settlements.length, 0);
  assert.equal(restarted.view.attempts.get('1').score, null);
  source.blocks = new Map([block(10, [], 2), block(11, [], 2)].map(b => [b.number, b]));
  await sync.sync();
  assert.equal(restarted.view.rounds.size, 0);
  assert.equal(restarted.tip().hash, hash(11, 2));
});

test('failed block transaction never advances checkpoint or mutates projection', t => {
  const { open, path } = fixture(t);
  const store = open();
  store.append([block(10, [entry(1, 10, 0)])]);
  assert.throws(() => store.append([block(11, [score(1, 20, 11, 0)]), block(12, [score(999, 20, 12, 0)])]), /matching paid entry/);
  assert.equal(store.tip().number, 10);
  assert.equal(store.view.attempts.get('1').score, null);
  assert.equal(store.events().length, 1);
  assert.throws(() => store.append([block(10, [entry(1, 10, 0, bob)])]), /Conflicting duplicate/);
  assert.throws(() => new Store(path, { ...identity, chainId: '1' }), /different chain/);
});

test('confirmations, RPC errors and mixed-fork logs are visible without corrupting checkpoint', async t => {
  const { open } = fixture(t);
  const store = open();
  const source = new FakeSource([block(10, [entry(1, 10, 0)]), block(11), block(12)]);
  const sync = new Indexer(store, source, { confirmations: 2 });
  await sync.sync();
  assert.equal(store.tip().number, 10);
  source.head = async () => { throw new Error('RPC unavailable'); };
  await assert.rejects(sync.sync(), /RPC unavailable/);
  assert.equal(sync.status().lastError, 'RPC unavailable');
  assert.equal(sync.status().syncing, false);
  assert.equal(store.tip().number, 10);
  source.head = async () => 12;
  source.blocks.get(11).events = [score(1, 5, 11, 0)];
  source.blocks.get(11).events[0].position.blockHash = hash(11, 1);
  sync.confirmations = 0;
  await assert.rejects(sync.sync(), /Chain changed/);
  assert.equal(store.tip().number, 10);
});

test('reconciliation failures are explicit, never reported as successful sync', async t => {
  const { open } = fixture(t);
  const source = new FakeSource([block(10, [entry(1, 10, 0)])]);
  source.reconcile = async () => ({ status: 'mismatch', mismatches: [{ field: 'pot' }] });
  const sync = new Indexer(open(), source, { confirmations: 0 });
  await assert.rejects(sync.sync(), /reconciliation failed/);
  assert.equal(sync.status().reconciliation.status, 'mismatch');
  assert.equal(sync.status().lastSyncedAt, null);
});

test('HTTP rankings, snapshots, pagination, wallet payer history and validation', async t => {
  const { open } = fixture(t);
  const store = open();
  store.append([block(10, [entry(1, 10, 0, bob, { payer: alice }), entry(2, 10, 1), entry(3, 10, 2), entry(4, 10, 3)]),
    block(11, [score(1, 55, 11, 0, bob), score(2, 55, 11, 1), score(3, 40, 11, 2)])]);
  const server = createApi(new Indexer(store, new FakeSource([])));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const get = path => fetch(`http://127.0.0.1:${server.address().port}${path}`);
  let response = await get(`/charts/${chart}/days/20000/rankings?limit=1`);
  const first = await response.json();
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(first.items[0].player, bob);
  assert.equal(first.nextOffset, 1);
  assert.equal(first.total, 3);
  const second = await (await get(`/charts/${chart}/days/20000/rankings?offset=1&atBlockHash=${first.indexedBlockHash}`)).json();
  assert.equal(second.items[0].rank, 2);
  assert.deepEqual(second.items.map(row => [row.rank, row.player, row.sessionId]), [[2, alice, '2'], [3, alice, '3']]);
  assert.equal((await (await get(`/wallets/${alice}/attempts`)).json()).total, 4);
  assert.equal((await (await get(`/wallets/${bob}/history`)).json()).total, 2);
  assert.equal((await (await get(`/wallets/${alice}/bests`)).json()).items[0].rank, 2);
  assert.equal((await (await get(`/wallets/${alice}/bests`)).json()).total, 1);
  assert.equal((await get('/attempts?limit=201')).status, 400);
  assert.equal((await get('/attempts?offset=-1')).status, 400);
  assert.equal((await get('/attempts?dayId=1.2')).status, 400);
  assert.equal((await get('/wallets/invalid/history')).status, 400);
  assert.equal((await get(`/charts/${chart}/days/999`)).status, 404);
  assert.equal((await get(`/attempts?atBlockHash=${hash(10)}`)).status, 409);
  assert.equal((await get('/status')).status, 200);
});
