import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { leaderboardAbi } from '../src/abi.js';
import { normalizeLog, ChainSource } from '../src/chain.js';
import { project } from '../src/domain.js';
import { configFromEnv } from '../src/config.js';

const chart = `0x${'ab'.repeat(32)}`, session = `0x${'01'.repeat(32)}`;
const player = `0x${'11'.repeat(20)}`, payer = `0x${'22'.repeat(20)}`, device = `0x${'33'.repeat(20)}`;
const hash = `0x${'44'.repeat(32)}`, address = `0x${'55'.repeat(20)}`;
function log(name, fields, index) {
  const abi = leaderboardAbi.find(x => x.type === 'event' && x.name === name);
  const nonIndexed = abi.inputs.filter(x => !x.indexed);
  return {
    address, blockNumber: 100n, blockHash: hash, logIndex: index, transactionIndex: 1,
    transactionHash: hash, removed: false,
    topics: encodeEventTopics({ abi: leaderboardAbi, eventName: name, args: fields }),
    data: encodeAbiParameters(nonIndexed, nonIndexed.map(x => fields[x.name])),
  };
}
const fields = { beatmapId: chart, dayId: 20000n, sessionId: session, player, payer, device };
const entryLog = () => log('EntryPaid', { ...fields, amount: 1000000n }, 0);
const scoreLog = () => log('ScoreRecorded', { ...fields, score: 0, bestScore: 0 }, 1);

test('all five real Solidity event shapes decode losslessly, including zero, bytes32 session and leader', () => {
  const events = [entryLog(), scoreLog(), log('LeaderChanged', { ...fields, score: 0 }, 2), log('PrizeClaimed', { ...fields, amount: 1000000n }, 3)].map(normalizeLog);
  const view = project(events);
  assert.equal(events[0].sessionId, session);
  assert.equal(events[0].device, device);
  assert.equal(view.charts.get(chart).remainingPot, '0');
  assert.equal(view.history[2].type, 'leader');
  assert.equal(view.attempts.get(session).score, '0');
  const refund = normalizeLog(log('EntryRefunded', { ...fields, amount: 1000000n }, 1));
  assert.equal(project([events[0], refund]).settlements[0].recipient, payer);
  assert.throws(() => normalizeLog({ ...entryLog(), removed: true }), /Non-canonical/);
  assert.throws(() => normalizeLog({ ...entryLog(), data: '0x' }));
  assert.throws(() => project([events[0], { ...events[1], bestScore: '1' }]), /bestScore mismatch/);
  assert.throws(() => project([events[0], events[1], { ...events[2], score: '1' }]), /LeaderChanged mismatch/);
});

test('ABI signatures, indexed fields and getter return types match compiled DailyLeaderboard artifact', t => {
  const artifactPath = new URL('../../scoring/gkr-scoring/contracts/out/DailyLeaderboard.sol/DailyLeaderboard.json', import.meta.url);
  if (!existsSync(artifactPath)) { t.skip('Build DailyLeaderboard with forge to verify compiled ABI'); return; }
  const actual = JSON.parse(readFileSync(artifactPath, 'utf8')).abi;
  for (const item of leaderboardAbi) {
    const compiled = actual.find(x => x.type === item.type && x.name === item.name);
    assert.ok(compiled, item.name);
    const shape = x => ({ type: x.type, indexed: Boolean(x.indexed) });
    assert.deepEqual(item.inputs.map(shape), compiled.inputs.map(shape), item.name);
    if (item.type === 'event') assert.deepEqual(item.inputs.map(x => x.name), compiled.inputs.map(x => x.name), item.name);
    if (item.outputs) assert.deepEqual(item.outputs.map(x => x.type), compiled.outputs.map(x => x.type), item.name);
  }
});

test('historical reconciliation covers round accounting, leaders, zero score records and payer balances', async () => {
  const view = project([entryLog(), scoreLog()].map(normalizeLog));
  const calls = [];
  const client = { async readContract(call) {
    calls.push(call);
    if (call.functionName === 'rounds') return [1000000n, 0n, player, 0, false];
    if (call.functionName === 'records') return [true, 0];
    if (call.functionName === 'refundablePayments') return 1000000n;
  } };
  const source = new ChainSource(client, address);
  const result = await source.reconcile(view, { number: 100, hash });
  assert.equal(result.status, 'ok');
  assert.equal(result.reads, 3);
  assert.ok(calls.every(call => call.blockNumber === 100n && call.address === address));
  client.readContract = async call => call.functionName === 'rounds' ? [2000000n, 0n, payer, 1, true] : call.functionName === 'records' ? [false, 5] : 0n;
  const mismatch = await source.reconcile(view, { number: 100, hash });
  assert.equal(mismatch.status, 'mismatch');
  assert.deepEqual(mismatch.mismatches.map(m => m.field), ['totalPaid', 'leader', 'highestScore', 'prizeClaimed', 'remainingPot', 'exists', 'bestScore', 'refundablePayments']);
  client.readContract = async () => { throw new Error('no archive state'); };
  assert.equal((await source.reconcile(view, { number: 100, hash })).status, 'error');
});

test('source bounds requests to contract and block range, rejects unknown address', async () => {
  let received;
  const client = { async getLogs(args) { received = args; return [entryLog()]; } };
  const source = new ChainSource(client, address);
  assert.equal((await source.events(100, 101))[0].type, 'entry');
  assert.deepEqual(received, { address, fromBlock: 100n, toBlock: 101n });
  client.getLogs = async () => [{ ...entryLog(), address: payer }];
  await assert.rejects(source.events(100, 100), /Unexpected log address/);
});

test('configuration requires real identity and sane limits without invented deployment values', () => {
  const base = { RPC_URL: 'http://127.0.0.1:8545', CHAIN_ID: '11155111', LEADERBOARD_ADDRESS: address, DEPLOYMENT_BLOCK: '100' };
  assert.equal(configFromEnv(base).identity.deploymentBlock, '100');
  for (const key of ['RPC_URL', 'CHAIN_ID', 'LEADERBOARD_ADDRESS', 'DEPLOYMENT_BLOCK']) {
    const missing = { ...base }; delete missing[key];
    assert.throws(() => configFromEnv(missing));
  }
  assert.throws(() => configFromEnv({ ...base, BATCH_SIZE: '0' }));
  assert.throws(() => configFromEnv({ ...base, CONFIRMATIONS: '-1' }));
  assert.throws(() => configFromEnv({ ...base, RPC_URL: 'file:///tmp/rpc' }));
});
