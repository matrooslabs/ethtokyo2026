import test from 'node:test';
import assert from 'node:assert/strict';
import { canEnter, dayOf, endOf, dateDay, utcDate } from '../src/lib/leaderboard/rules.ts';

test('UTC boundary uses next day at exactly midnight regardless of local timezone', () => {
  const day = dateDay('2026-09-26');
  assert.equal(utcDate(day), '2026-09-26');
  assert.equal(dayOf(endOf(day) - 1), day);
  assert.equal(dayOf(endOf(day)), day + 1);
});
test('entry reserves complete song and measured proof buffer strictly before cutoff', () => {
  const end = endOf(dateDay('2026-09-26'));
  assert.equal(canEnter(end - 181, 120, 60), true);
  assert.equal(canEnter(end - 180, 120, 60), false);
  assert.equal(canEnter(end - 100, 120, 60), false);
  assert.equal(canEnter(end, 120, 60), true);
});
test('unmeasured buffer, invalid duration and invalid time fail closed', () => {
  for (const args of [[0, 120, 0], [0, 120, NaN], [0, -1, 30], [NaN, 120, 30], [0, Infinity, 30]]) {
    assert.equal(canEnter(...args), false);
  }
});

import { parseAbi, encodeEventTopics, encodeAbiParameters } from 'viem';
import { paidSession, acceptedScore } from '../src/lib/leaderboard/receipts.ts';
const contract = '0x1111111111111111111111111111111111111111';
const player = '0x2222222222222222222222222222222222222222';
const device = '0x3333333333333333333333333333333333333333';
const chartHash = `0x${'44'.repeat(32)}`;
const sessionId = `0x${'55'.repeat(32)}`;
const abi = parseAbi([
  'event EntryPaid(bytes32 indexed beatmapId,uint64 indexed dayId,bytes32 indexed sessionId,address payer,address player,address device,uint256 amount)',
  'event ScoreRecorded(bytes32 indexed beatmapId,uint64 indexed dayId,bytes32 indexed sessionId,address player,uint32 score,uint32 bestScore)',
]);
function receipt(eventName, address = contract, status = 'success') {
  return { status, logs: [{ address,
    topics: encodeEventTopics({ abi, eventName, args: { beatmapId: chartHash, dayId: 20000n, sessionId } }),
    data: eventName === 'EntryPaid'
      ? encodeAbiParameters([{type:'address'},{type:'address'},{type:'address'},{type:'uint256'}], [player, player, device, 1000000n])
      : encodeAbiParameters([{type:'address'},{type:'uint32'},{type:'uint32'}], [player, 0, 0]),
  }] };
}
const entry = {chartHash, player, payer: player, device, dayId:20000n, amount:1000000n};
const score = {chartHash, player, sessionId, dayId:20000n};
test('only a successful exact contract/chart/player/payer/device/day/payment receipt starts paid play', () => {
  assert.equal(paidSession(receipt('EntryPaid'), contract, entry), sessionId);
  assert.throws(() => paidSession(receipt('EntryPaid', player), contract, entry));
  assert.throws(() => paidSession(receipt('EntryPaid', contract, 'reverted'), contract, entry));
  for (const bad of [{dayId:20001n}, {amount:0n}, {player:device}, {payer:device}, {device:player}, {chartHash:sessionId}]) {
    assert.throws(() => paidSession(receipt('EntryPaid'), contract, {...entry, ...bad}));
  }
});
test('zero is an accepted score and unrelated/reverted/spoofed proof receipts never report success', () => {
  assert.equal(acceptedScore(receipt('ScoreRecorded'), contract, score), 0);
  assert.throws(() => acceptedScore(receipt('ScoreRecorded', player), contract, score));
  assert.throws(() => acceptedScore(receipt('ScoreRecorded', contract, 'reverted'), contract, score));
  for (const bad of [{sessionId:chartHash}, {dayId:20001n}, {player:device}, {chartHash:sessionId}]) {
    assert.throws(() => acceptedScore(receipt('ScoreRecorded'), contract, {...score, ...bad}));
  }
});

import { isHoldObject, laneForX, sectionLines } from '../src/lib/osuFields.ts';
test('combo flags and right-edge notes render the same lanes and holds as the canonical chart', () => {
  assert.equal(isHoldObject(128), true);
  assert.equal(isHoldObject(132), true);
  assert.equal(isHoldObject(1), false);
  assert.equal(isHoldObject(5), false);
  assert.deepEqual([0,127,128,255,256,383,384,511,512].map(x => laneForX(x,4)), [0,0,1,1,2,2,3,3,3]);
});
test('section parsing retains final note at EOF and does not swallow the next section', () => {
  const notes = ['64,192,1000,1,0,0:0:0:0:', '512,192,2000,132,0,2500:0:0:0:0:'];
  assert.deepEqual(sectionLines(['[HitObjects]', ...notes], 'HitObjects'), notes);
  assert.deepEqual(sectionLines(['[HitObjects]', '', notes[0], '// comment', notes[1], '[Other]', 'not a note'], 'HitObjects'), notes);
  assert.deepEqual(sectionLines(['[Other]', 'other'], 'HitObjects'), []);
});

import { recordTransition } from '../src/lib/replayInputs.ts';
test('finish/fail cleanup emits only real key releases and preserves event order', () => {
  const states=[], inputs=[];
  recordTransition(states,inputs,3,0,false); // start key pressed in WAIT, released in PLAY
  recordTransition(states,inputs,0,1000,true);
  recordTransition(states,inputs,0,1020,false);
  recordTransition(states,inputs,1,1500,true);
  recordTransition(states,inputs,1,1501,true); // browser key repeat is not a transition
  for(let column=0;column<4;column++) recordTransition(states,inputs,column,3000,false);
  assert.deepEqual(inputs,[[0,1000,true],[0,1020,false],[1,1500,true],[1,3000,false]]);
  const empty=[];
  for(let column=0;column<4;column++) recordTransition([],empty,column,3000,false);
  assert.deepEqual(empty,[]); // valid zero-input run, no fabricated key releases
});
