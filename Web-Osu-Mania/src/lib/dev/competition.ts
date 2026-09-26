import type { DevDifficulty, DevResult, DevRun } from "./types";

const PRICE = 1_000_000;
const SCORE_WINDOW_MS = 21_600_000;
const CLAIM_WINDOW_MS = 86_400_000;
const PAYOUT_SHARES = [40, 20, 20, 10, 10] as const;

/** These are local demo identities, not Sui addresses or real wallets. */
export const DEV_WALLETS = Array.from({ length: 6 }, (_, index) => ({
  name: `Demo Wallet ${index + 1} (simulated)`,
  wallet: `SIM-DEMO-WALLET-0${index + 1}`,
}));

export type DevPlayer = {
  name: string;
  wallet: string;
  /** Demo USDC in six-decimal integer base units. */
  balance: number;
  /** Unspent plays, shared across Easy and Hard. */
  credits: number;
  purchases: number;
  best: Record<DevDifficulty, { score: number; order: number } | null>;
  claim: DevDifficulty | null;
  payout: number;
  refund: number;
  refunded: boolean;
};

export type DevState = {
  id: string | null;
  nowMs: number;
  startedAtMs: number | null;
  scoreDeadlineMs: number | null;
  claimDeadlineMs: number | null;
  /** Demo USDC remaining in the prize vault. */
  pot: number;
  players: Record<string, DevPlayer>;
  run: DevRun | null;
  settled: boolean;
  scoreOrder: number;
  /** Fixed at settlement; retained to display original prize calculations. */
  originalPot: number;
  /** Original unallocated prize share, before any purchaser refunds. */
  refundPool: number;
  /** Local identity keys used only to prevent a second simulated claim. */
  humanClaims: Record<string, string>;
  /** Spent run identifiers; an aborted run cannot be resumed or replayed. */
  runIds: string[];
};

export type DevRanking = {
  wallet: string;
  name: string;
  /** Highest successfully recorded local score on this chart. */
  score: number;
  /** Monotonic successful-score record order, earlier winning a score tie. */
  order: number;
  /** 1–5 only when claimed and still in the chart's prize positions. */
  claimRank: number | null;
};

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function playerFor(state: DevState, wallet: string): DevPlayer {
  const player = Object.hasOwn(state.players, wallet) ? state.players[wallet] : undefined;
  if (!player) throw new Error("Unknown simulated wallet.");
  return player;
}

function requireChallenge(state: DevState): void {
  if (state.id === null) throw new Error("Launch the simulated challenge first.");
}

function requireScoring(state: DevState): void {
  requireChallenge(state);
  if (state.startedAtMs === null || state.nowMs < state.startedAtMs) {
    throw new Error("The simulated scoring window has not started.");
  }
  if (state.scoreDeadlineMs === null || state.nowMs >= state.scoreDeadlineMs) {
    throw new Error("The simulated scoring window is closed.");
  }
}

function requireDifficulty(difficulty: DevDifficulty): void {
  if (difficulty !== "Easy" && difficulty !== "Hard") throw new Error("Unknown simulated difficulty.");
}

function copy(state: DevState): DevState {
  return structuredClone(state);
}

export function initialState(nowMs: number): DevState {
  if (!validTimestamp(nowMs)) throw new Error("Use a nonnegative integer millisecond clock.");
  const players: Record<string, DevPlayer> = {};
  for (const { name, wallet } of DEV_WALLETS) {
    players[wallet] = {
      name, wallet, balance: 10_000_000, credits: 0, purchases: 0,
      best: { Easy: null, Hard: null }, claim: null, payout: 0, refund: 0, refunded: false,
    };
  }
  return {
    id: null, nowMs, startedAtMs: null, scoreDeadlineMs: null, claimDeadlineMs: null,
    pot: 0, players, run: null, settled: false, scoreOrder: 0, originalPot: 0,
    refundPool: 0, humanClaims: {}, runIds: [],
  };
}

export function launchChallenge(state: DevState, id: string, startAtMs: number): DevState {
  if (state.id !== null) throw new Error("A simulated challenge has already launched.");
  if (!id.trim()) throw new Error("A simulated challenge needs an ID.");
  if (!validTimestamp(startAtMs) || startAtMs < state.nowMs) {
    throw new Error("The simulated start must be a valid timestamp at or after the current clock.");
  }
  if (!validTimestamp(startAtMs + SCORE_WINDOW_MS + CLAIM_WINDOW_MS)) {
    throw new Error("Challenge deadlines exceed the supported clock range.");
  }
  const next = copy(state);
  next.id = id;
  next.startedAtMs = startAtMs;
  next.scoreDeadlineMs = startAtMs + SCORE_WINDOW_MS;
  next.claimDeadlineMs = next.scoreDeadlineMs + CLAIM_WINDOW_MS;
  return next;
}

export function buyPlays(state: DevState, wallet: string): DevState {
  requireScoring(state);
  const player = playerFor(state, wallet);
  if (player.balance < PRICE) throw new Error("Insufficient demo USDC to buy three plays.");
  const next = copy(state);
  const buyer = next.players[wallet];
  buyer.balance -= PRICE;
  buyer.credits += 3;
  buyer.purchases += 1;
  next.pot += PRICE;
  return next;
}

export function startPlay(state: DevState, wallet: string, difficulty: DevDifficulty, runId: string): DevState {
  requireScoring(state);
  requireDifficulty(difficulty);
  if (state.run) throw new Error("Finish or abort the current simulated run first.");
  if (!runId.trim() || state.runIds.includes(runId)) throw new Error("Use a fresh simulated run ID.");
  if (playerFor(state, wallet).credits < 1) throw new Error("Buy simulated plays before starting.");
  const next = copy(state);
  next.players[wallet].credits -= 1;
  next.run = { id: runId, wallet, difficulty };
  next.runIds.push(runId);
  return next;
}

export function recordScore(state: DevState, result: DevResult): DevState {
  requireScoring(state);
  if (!state.run || state.run.id !== result.runId) throw new Error("No matching active simulated run.");
  if (!Number.isSafeInteger(result.score) || result.score < 0 || typeof result.failed !== "boolean") {
    throw new Error("A simulated result needs an integer score and failure status.");
  }
  const next = copy(state);
  const { wallet, difficulty } = state.run;
  next.run = null;
  if (!result.failed) {
    next.scoreOrder += 1;
    const previous = next.players[wallet].best[difficulty];
    if (!previous || result.score > previous.score) {
      next.players[wallet].best[difficulty] = { score: result.score, order: next.scoreOrder };
    }
  }
  return next;
}

export function abortRun(state: DevState, runId: string): DevState {
  if (!state.run || state.run.id !== runId) throw new Error("No matching active simulated run to abort.");
  const next = copy(state);
  next.run = null;
  return next;
}

export function advanceClock(state: DevState, targetMs: number): DevState {
  if (!validTimestamp(targetMs) || targetMs < state.nowMs) throw new Error("The simulated clock cannot move backwards.");
  const next = copy(state);
  next.nowMs = targetMs;
  return next;
}

export function rankings(state: DevState, difficulty: DevDifficulty): DevRanking[] {
  requireDifficulty(difficulty);
  const entries: DevRanking[] = [];
  for (const player of Object.values(state.players)) {
    const best = player.best[difficulty];
    if (best) entries.push({
      wallet: player.wallet, name: player.name, score: best.score, order: best.order, claimRank: null,
    });
  }
  entries.sort((a, b) => b.score - a.score || a.order - b.order);
  const claimed = entries.filter((entry) => state.players[entry.wallet].claim === difficulty);
  for (let i = 0; i < Math.min(claimed.length, PAYOUT_SHARES.length); i++) claimed[i].claimRank = i + 1;
  return entries;
}

export function claimPrize(state: DevState, wallet: string, difficulty: DevDifficulty, humanId: string): DevState {
  requireChallenge(state);
  requireDifficulty(difficulty);
  if (state.scoreDeadlineMs === null || state.claimDeadlineMs === null ||
      state.nowMs < state.scoreDeadlineMs || state.nowMs >= state.claimDeadlineMs) {
    throw new Error("Simulated claims open after scoring and close at the claim deadline.");
  }
  const player = playerFor(state, wallet);
  if (!player.best[difficulty]) throw new Error("A recorded simulated score is required on the selected chart.");
  if (player.claim !== null) throw new Error("This simulated wallet has already claimed a chart.");
  if (!humanId.trim()) throw new Error("Provide a simulated human ID to claim.");
  if (Object.hasOwn(state.humanClaims, `id:${humanId}`)) throw new Error("This simulated human has already claimed a chart.");
  const next = copy(state);
  next.players[wallet].claim = difficulty;
  next.humanClaims[`id:${humanId}`] = wallet;
  return next;
}

export function settle(state: DevState): DevState {
  requireChallenge(state);
  if (state.claimDeadlineMs === null || state.nowMs < state.claimDeadlineMs) {
    throw new Error("Wait until the simulated claim window closes to settle.");
  }
  if (state.settled) throw new Error("The simulated challenge is already settled.");
  const next = copy(state);
  next.originalPot = state.pot;
  let paid = 0;
  for (const [difficulty, slice] of [["Easy", 30], ["Hard", 70]] as const) {
    for (const entry of rankings(state, difficulty)) {
      if (entry.claimRank === null) continue;
      const share = PAYOUT_SHARES[entry.claimRank - 1];
      const amount = Number(BigInt(state.pot) * BigInt(slice) * BigInt(share) / 10_000n);
      next.players[entry.wallet].balance += amount;
      next.players[entry.wallet].payout += amount;
      paid += amount;
    }
  }
  next.pot -= paid;
  next.refundPool = next.pot;
  next.settled = true;
  return next;
}

export function refund(state: DevState, wallet: string): DevState {
  if (!state.settled) throw new Error("Settle the simulated challenge before refunding.");
  const buyer = playerFor(state, wallet);
  if (buyer.purchases === 0) throw new Error("Only simulated purchasers can receive refunds.");
  if (buyer.refunded) throw new Error("This simulated purchaser has already received a refund.");
  const remainingPurchases = Object.values(state.players)
    .reduce((total, player) => total + (player.refunded ? 0 : player.purchases), 0);
  const totalPurchases = Object.values(state.players)
    .reduce((total, player) => total + player.purchases, 0);
  const amount = remainingPurchases === buyer.purchases ? state.pot :
    Number(BigInt(state.refundPool) * BigInt(buyer.purchases) / BigInt(totalPurchases));
  const next = copy(state);
  next.players[wallet].refunded = true;
  next.players[wallet].refund += amount;
  next.players[wallet].balance += amount;
  next.pot -= amount;
  return next;
}
