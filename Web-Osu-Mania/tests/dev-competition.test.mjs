import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEV_WALLETS, initialState, launchChallenge, buyPlays, startPlay, recordScore,
  abortRun, advanceClock, claimPrize, settle, refund, rankings,
} from '../src/lib/dev/competition.ts';

const [a, b, c, d, e, f] = DEV_WALLETS.map(({ wallet }) => wallet);
const start = 1_800_000_000_000;

function play(state, wallet, difficulty, id, score, failed = false) {
  return recordScore(startPlay(state, wallet, difficulty, id), { runId: id, score, failed });
}

test('six local demo wallets buy chart-specific credits, rank their best scores, and settle isolated pools', () => {
  const empty = initialState(start);
  assert.equal(DEV_WALLETS.length, 6);
  assert.ok(DEV_WALLETS.every(({ name, wallet }) => /simulat/i.test(name) && wallet.startsWith('SIM-')));
  assert.equal(empty.id, null);
  assert.deepEqual(empty.pots, { Easy: 0, Hard: 0 });
  assert.ok(Object.values(empty.players).every(player => player.balance === 10_000_000 && player.credits.Easy === 0 && player.credits.Hard === 0));
  assert.throws(() => buyPlays(empty, a, 'Easy'), /Launch/);

  const scheduledStart = start + 60_000;
  let state = launchChallenge(empty, 'LOCAL-FOREST-ROUND', scheduledStart);
  assert.equal(state.nowMs, start);
  assert.equal(state.startedAtMs, scheduledStart);
  assert.equal(state.scoreDeadlineMs, scheduledStart + 21_600_000);
  assert.equal(state.claimDeadlineMs, scheduledStart + 21_600_000 + 86_400_000);
  assert.equal(empty.id, null); // Input state is never changed.
  assert.throws(() => launchChallenge(state, 'another', scheduledStart), /already launched/);
  state = advanceClock(state, scheduledStart);
  for (const wallet of [a, b, c, f, a]) state = buyPlays(state, wallet, 'Easy');
  for (const wallet of [a, d, e]) state = buyPlays(state, wallet, 'Hard');
  assert.deepEqual(state.pots, { Easy: 5_000_000, Hard: 3_000_000 });
  assert.equal(state.players[a].balance, 7_000_000);
  assert.deepEqual(state.players[a].credits, { Easy: 6, Hard: 3 });
  assert.deepEqual(state.players[b].credits, { Easy: 3, Hard: 0 });
  assert.throws(() => startPlay(state, b, 'Hard', ' '), /fresh/);

  state = startPlay(state, a, 'Hard', 'a-hard-failed');
  assert.equal(state.players[a].credits.Hard, 2);
  assert.throws(() => startPlay(state, b, 'Easy', 'locked'), /Finish or abort/);
  assert.throws(() => recordScore(state, { runId: 'forged', score: 999_999, failed: false }), /matching active/);
  state = recordScore(state, { runId: 'a-hard-failed', score: 999_999, failed: true });
  assert.equal(state.players[a].best.Hard, null);
  assert.equal(state.scoreOrder, 0);
  assert.throws(() => startPlay(state, a, 'Hard', 'a-hard-failed'), /fresh/);
  state = abortRun(startPlay(state, a, 'Hard', 'a-abort'), 'a-abort');
  assert.equal(state.players[a].credits.Hard, 1);
  assert.throws(() => recordScore(state, { runId: 'a-abort', score: 1, failed: false }), /matching active/);
  assert.throws(() => startPlay(state, a, 'Hard', 'a-abort'), /fresh/);

  state = play(state, a, 'Easy', 'a-easy-900', 900);
  state = play(state, b, 'Easy', 'b-easy-900', 900);
  state = play(state, c, 'Easy', 'c-easy-999', 999); // Highest score never claims.
  state = play(state, a, 'Easy', 'a-easy-worse', 800);
  state = play(state, a, 'Hard', 'a-hard-777', 777);
  state = play(state, d, 'Hard', 'd-hard-700', 700);
  state = play(state, e, 'Hard', 'e-hard-750', 750);
  state = play(state, f, 'Easy', 'f-easy-650', 650);
  assert.equal(state.players[a].best.Easy.order, 1); // Lower score did not replace the personal best.
  assert.deepEqual(rankings(state, 'Easy').map(({ wallet, claimRank }) => [wallet, claimRank]),
    [[c, null], [a, null], [b, null], [f, null]]);
  const snapshot = JSON.parse(JSON.stringify(state));
  assert.deepEqual(snapshot, state); // Store/render may serialize without a network or special numeric types.

  state = advanceClock(state, state.scoreDeadlineMs - 1);
  assert.throws(() => claimPrize(state, a, 'Easy'), /after scoring/);
  state = advanceClock(state, state.scoreDeadlineMs);
  assert.throws(() => buyPlays(state, a, 'Easy'), /closed/);
  assert.throws(() => startPlay(state, a, 'Easy', 'too-late'), /closed/);
  assert.throws(() => settle(state), /Wait until/);
  assert.throws(() => claimPrize(state, d, 'Easy'), /recorded/);
  state = claimPrize(state, b, 'Easy'); // Reverse claim order must not break a tie.
  state = claimPrize(state, a, 'Easy');
  assert.throws(() => claimPrize(state, a, 'Hard'), /already claimed/);
  state = claimPrize(state, f, 'Easy');
  state = claimPrize(state, d, 'Hard'); // Lower score claims first.
  state = claimPrize(state, e, 'Hard');
  assert.deepEqual(rankings(state, 'Easy').map(({ wallet, claimRank }) => [wallet, claimRank]),
    [[c, null], [a, 1], [b, 2], [f, 3]]);
  assert.deepEqual(rankings(state, 'Hard').map(({ wallet, claimRank }) => [wallet, claimRank]),
    [[a, null], [e, 1], [d, 2]]);
  state = advanceClock(state, state.claimDeadlineMs - 1);
  assert.throws(() => settle(state), /Wait until/);
  state = advanceClock(state, state.claimDeadlineMs);
  assert.throws(() => claimPrize(state, c, 'Easy'), /close at/);
  assert.throws(() => refund(state, a, 'Easy'), /Settle/);

  const beforeSettlement = state;
  state = settle(state);
  assert.deepEqual(beforeSettlement.pots, { Easy: 5_000_000, Hard: 3_000_000 });
  assert.deepEqual(state.originalPots, { Easy: 5_000_000, Hard: 3_000_000 });
  assert.deepEqual([a, b, c, d, e, f].map(wallet => state.players[wallet].payout),
    [2_000_000, 1_000_000, 0, 600_000, 1_200_000, 1_000_000]);
  assert.deepEqual(state.refundPools, { Easy: 1_000_000, Hard: 1_200_000 });
  assert.deepEqual(state.pots, { Easy: 1_000_000, Hard: 1_200_000 });
  assert.throws(() => settle(state), /already settled/);
  assert.throws(() => refund(state, d, 'Easy'), /Easy purchasers/);
  for (const wallet of [b, c, f, a]) state = refund(state, wallet, 'Easy');
  assert.deepEqual(state.pots, { Easy: 0, Hard: 1_200_000 });
  for (const wallet of [d, e, a]) state = refund(state, wallet, 'Hard');
  assert.deepEqual([a, b, c, d, e, f].map(wallet => state.players[wallet].refund),
    [800_000, 200_000, 200_000, 400_000, 400_000, 200_000]);
  assert.deepEqual([a, b, c, d, e, f].map(wallet => state.players[wallet].balance),
    [9_800_000, 10_200_000, 9_200_000, 10_000_000, 10_600_000, 10_200_000]);
  assert.deepEqual(state.pots, { Easy: 0, Hard: 0 });
  assert.throws(() => refund(state, a, 'Easy'), /already received/);
  assert.throws(() => refund(state, a, 'Hard'), /already received/);
});

test('a future scheduled start keeps the clock unchanged and gates purchases, runs and scores', () => {
  const scheduledStart = start + 60_000;
  const empty = initialState(start);
  assert.throws(() => launchChallenge(empty, 'past', start - 1), /start/);
  assert.throws(() => launchChallenge(empty, 'fractional', scheduledStart + 0.5), /start/);
  assert.throws(() => launchChallenge(empty, 'overflow', Number.MAX_SAFE_INTEGER), /deadlines/);

  let state = launchChallenge(empty, 'future', scheduledStart);
  assert.equal(state.nowMs, start);
  assert.equal(state.startedAtMs, scheduledStart);
  assert.equal(state.scoreDeadlineMs - state.startedAtMs, 21_600_000);
  assert.equal(state.claimDeadlineMs - state.scoreDeadlineMs, 86_400_000);
  assert.throws(() => buyPlays(state, a, 'Easy'), /not started/);
  assert.throws(() => startPlay(state, a, 'Easy', 'early'), /not started/);
  assert.throws(() => recordScore(state, { runId: 'early', score: 1, failed: false }), /not started/);
  state = advanceClock(state, scheduledStart - 1);
  assert.equal(state.startedAtMs, scheduledStart);
  assert.throws(() => buyPlays(state, a, 'Easy'), /not started/);
  assert.throws(() => startPlay(state, a, 'Easy', 'early'), /not started/);
  assert.throws(() => recordScore(state, { runId: 'early', score: 1, failed: false }), /not started/);
  assert.throws(() => claimPrize(state, a, 'Easy'), /after scoring/);
  assert.equal(state.players[a].balance, 10_000_000);
  assert.deepEqual(state.pots, { Easy: 0, Hard: 0 });

  state = advanceClock(state, scheduledStart);
  state = buyPlays(state, a, 'Easy');
  state = play(state, a, 'Easy', 'at-start', 100);
  assert.equal(state.players[a].best.Easy.score, 100);
  state = advanceClock(state, state.scoreDeadlineMs - 1);
  state = play(state, a, 'Easy', 'last-millisecond', 200);
  assert.equal(state.players[a].best.Easy.score, 200);
  state = advanceClock(state, state.scoreDeadlineMs);
  assert.throws(() => buyPlays(state, a, 'Easy'), /closed/);
  assert.throws(() => startPlay(state, a, 'Easy', 'at-cutoff'), /closed/);
  assert.throws(() => recordScore(state, { runId: 'at-cutoff', score: 300, failed: false }), /closed/);
  state = claimPrize(state, a, 'Easy');
  assert.equal(state.players[a].claim, 'Easy');
});

test('one chart purchase cannot fund a run or refund on the other chart', () => {
  let state = launchChallenge(initialState(start), 'isolated-wallet', start);
  state = buyPlays(state, a, 'Easy');
  assert.deepEqual(state.players[a].credits, { Easy: 3, Hard: 0 });
  assert.throws(() => startPlay(state, a, 'Hard', 'hard-with-easy-credit'), /Buy simulated Hard plays/);
  state = play(state, a, 'Easy', 'easy-run', 100);
  assert.deepEqual(state.players[a].credits, { Easy: 2, Hard: 0 });
  state = claimPrize(advanceClock(state, state.scoreDeadlineMs), a, 'Easy');
  state = settle(advanceClock(state, state.claimDeadlineMs));
  assert.deepEqual(state.originalPots, { Easy: 1_000_000, Hard: 0 });
  assert.deepEqual(state.refundPools, { Easy: 600_000, Hard: 0 });
  assert.throws(() => refund(state, a, 'Hard'), /Hard purchasers/);
  state = refund(state, a, 'Easy');
  assert.deepEqual(state.pots, { Easy: 0, Hard: 0 });
  assert.equal(state.players[a].balance, 10_000_000);
});

test('strict run, balance and clock boundaries preserve spent credits and score provenance', () => {
  assert.throws(() => initialState(-1), /clock/);
  let state = launchChallenge(initialState(start), 'boundary-round', start);
  assert.throws(() => buyPlays(state, 'unknown-wallet', 'Easy'), /Unknown/);
  for (let i = 0; i < 10; i++) state = buyPlays(state, a, 'Easy');
  assert.equal(state.players[a].balance, 0);
  assert.throws(() => buyPlays(state, a, 'Easy'), /Insufficient/);
  assert.throws(() => advanceClock(state, start - 1), /backwards/);
  state = startPlay(state, a, 'Easy', 'expires');
  assert.throws(() => abortRun(state, 'different'), /matching/);
  const beforeRejection = state;
  state = advanceClock(state, state.scoreDeadlineMs);
  assert.throws(() => recordScore(state, { runId: 'expires', score: 999, failed: false }), /closed/);
  assert.equal(beforeRejection.players[a].credits.Easy, 29);
  state = abortRun(state, 'expires');
  assert.equal(state.players[a].credits.Easy, 29);
  assert.equal(state.players[a].best.Easy, null);
  assert.throws(() => claimPrize(state, a, 'Easy'), /recorded/);
  state = advanceClock(state, state.claimDeadlineMs);
  state = settle(state);
  assert.deepEqual(state.refundPools, { Easy: 10_000_000, Hard: 0 });
  assert.throws(() => refund(state, b, 'Easy'), /purchasers/);
  state = refund(state, a, 'Easy');
  assert.equal(state.players[a].balance, 10_000_000);
  assert.deepEqual(state.pots, { Easy: 0, Hard: 0 });
});

test('six eligible claims retain only five prize ranks regardless of arrival order', () => {
  let state = launchChallenge(initialState(start), 'top-five', start);
  for (const wallet of [a, b, c, d, e, f]) state = buyPlays(state, wallet, 'Easy');
  for (const [index, wallet] of [a, b, c, d, e, f].entries()) {
    state = play(state, wallet, 'Easy', `score-${index}`, 100 + index);
  }
  state = advanceClock(state, state.scoreDeadlineMs);
  for (const wallet of [a, b, c, d, e, f]) state = claimPrize(state, wallet, 'Easy');
  assert.deepEqual(rankings(state, 'Easy').map(({ claimRank }) => claimRank), [1, 2, 3, 4, 5, null]);
  assert.deepEqual(rankings(state, 'Easy').map(({ wallet }) => wallet), [f, e, d, c, b, a]);
  state = settle(advanceClock(state, state.claimDeadlineMs));
  assert.deepEqual([a, b, c, d, e, f].map(wallet => state.players[wallet].payout),
    [0, 600_000, 600_000, 1_200_000, 1_200_000, 2_400_000]);
  assert.deepEqual(state.refundPools, { Easy: 0, Hard: 0 });
});
