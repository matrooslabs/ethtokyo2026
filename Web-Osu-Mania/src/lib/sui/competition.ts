import { bcs } from "@mysten/sui/bcs";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import type { SuiGrpcClient } from "@mysten/sui/grpc";

// Circle-published native USDC types; never trust a coin's display symbol alone.
const circleUsdc = {
  mainnet: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  testnet: "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
};
const network = import.meta.env.VITE_SUI_NETWORK === "mainnet" ? "mainnet" : "testnet";

export type Difficulty = "Easy" | "Hard";
export const suiDeployment = {
  packageId: import.meta.env.VITE_SUI_PACKAGE_ID || "",
  registryId: import.meta.env.VITE_SUI_REGISTRY_ID || "",
  challengeId: import.meta.env.VITE_SUI_CHALLENGE_ID || "",
  charts: {
    Easy: import.meta.env.VITE_SUI_EASY_CHART_HASH || "",
    Hard: import.meta.env.VITE_SUI_HARD_CHART_HASH || "",
  },
  usdcType: import.meta.env.VITE_SUI_USDC_TYPE || "",
};

const hex32 = /^0x[0-9a-fA-F]{64}$/;
export const configured = !!suiDeployment.packageId && !!suiDeployment.registryId &&
  suiDeployment.usdcType === circleUsdc[network] && hex32.test(suiDeployment.challengeId) &&
  Object.values(suiDeployment.charts).every((hash) => hex32.test(hash)) &&
  suiDeployment.charts.Easy.toLowerCase() !== suiDeployment.charts.Hard.toLowerCase();
export const difficultyCode = (difficulty: Difficulty): number => difficulty === "Easy" ? 0 : 1;
const target = (method: string) => `${suiDeployment.packageId}::competition::${method}`;
const coinType = [suiDeployment.usdcType];

const dynamicTable = bcs.struct("Table", { id: bcs.Address, size: bcs.u64() });
const rankedClaim = bcs.struct("RankedClaim", {
  wallet: bcs.Address, session: bcs.Address, score: bcs.u64(), order: bcs.u64(),
});
const challengeObject = bcs.struct("Challenge", {
  id: bcs.Address,
  registry: bcs.Address,
  round_date: bcs.vector(bcs.u8()),
  round_id: bcs.vector(bcs.u8()),
  easy_chart_hash: bcs.vector(bcs.u8()),
  hard_chart_hash: bcs.vector(bcs.u8()),
  device: bcs.vector(bcs.u8()),
  started_at_ms: bcs.u64(),
  score_deadline_ms: bcs.u64(),
  claim_window_ms: bcs.u64(),
  claim_deadline_ms: bcs.u64(),
  easy_pot: bcs.u64(),
  hard_pot: bcs.u64(),
  buyers: dynamicTable,
  attempts: dynamicTable,
  claims: dynamicTable,
  nullifiers: dynamicTable,
  easy_top: bcs.vector(rankedClaim),
  hard_top: bcs.vector(rankedClaim),
  score_order: bcs.u64(),
  easy_total_purchases: bcs.u64(),
  hard_total_purchases: bcs.u64(),
  easy_refund_purchases_remaining: bcs.u64(),
  hard_refund_purchases_remaining: bcs.u64(),
  easy_original_pot: bcs.u64(),
  hard_original_pot: bcs.u64(),
  easy_refund_pool: bcs.u64(),
  hard_refund_pool: bcs.u64(),
  settled: bcs.bool(),
});

export type RankedClaim = { wallet: string; session: string; score: bigint; order: bigint };
export type ChallengeState = {
  pot: bigint;
  pots: Record<Difficulty, bigint>;
  originalPot: bigint;
  refundPool: bigint;
  remaining: bigint;
  claimRegistered: boolean;
  refundEligible: boolean;
  roundDate: string;
  device: string;
  chartHashes: Record<Difficulty, string>;
  rankedClaims: Record<Difficulty, RankedClaim[]>;
  startedAtMs: number;
  scoreDeadlineMs: number;
  claimDeadlineMs: number;
  settled: boolean;
};

function hex(bytes: number[]): string {
  return `0x${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

async function walletState(client: SuiGrpcClient, wallet: string, challengeId: string, difficulty: Difficulty): Promise<{ remaining: bigint; claimRegistered: boolean; refundEligible: boolean }> {
  const tx = new Transaction();
  tx.setSender(wallet);
  tx.moveCall({ target: target("remaining_plays"), typeArguments: coinType,
    arguments: [tx.object(challengeId), tx.pure.address(wallet), tx.pure.u8(difficultyCode(difficulty))] });
  tx.moveCall({ target: target("claim_registered"), typeArguments: coinType,
    arguments: [tx.object(challengeId), tx.pure.address(wallet)] });
  tx.moveCall({ target: target("refund_eligible"), typeArguments: coinType,
    arguments: [tx.object(challengeId), tx.pure.address(wallet), tx.pure.u8(difficultyCode(difficulty))] });
  const result = await client.simulateTransaction({ transaction: tx, include: { commandResults: true }, checksEnabled: false });
  const remainingBytes = result.Transaction && result.commandResults?.[0]?.returnValues?.[0]?.bcs;
  const claimBytes = result.Transaction && result.commandResults?.[1]?.returnValues?.[0]?.bcs;
  const refundBytes = result.Transaction && result.commandResults?.[2]?.returnValues?.[0]?.bcs;
  if (!remainingBytes || !claimBytes || !refundBytes) throw new Error("Unable to read Sui wallet plays and claim.");
  return { remaining: BigInt(bcs.u64().parse(remainingBytes)),
    claimRegistered: bcs.bool().parse(claimBytes), refundEligible: bcs.bool().parse(refundBytes) };
}

export async function readCompetition(client: SuiGrpcClient, wallet: string, challengeId: string,
  difficulty: Difficulty, expectedChartHash: string): Promise<ChallengeState> {
  if (!configured) throw new Error("Sui challenge deployment is not configured.");
  const [object, player] = await Promise.all([
    client.getObject({ objectId: challengeId, include: { content: true } }),
    walletState(client, wallet, challengeId, difficulty),
  ]);
  const content = object.object?.content;
  if (!content || object.object?.type !== `${suiDeployment.packageId}::competition::Challenge<${suiDeployment.usdcType}>`) {
    throw new Error("Sui challenge object does not match the configured vault.");
  }
  const parsed = challengeObject.parse(content);
  if (parsed.registry !== suiDeployment.registryId) throw new Error("Challenge registry does not match this deployment.");
  const chartHashes = { Easy: hex(parsed.easy_chart_hash), Hard: hex(parsed.hard_chart_hash) };
  if (chartHashes[difficulty].toLowerCase() !== expectedChartHash.toLowerCase() ||
      (challengeId === suiDeployment.challengeId && (
        chartHashes.Easy.toLowerCase() !== suiDeployment.charts.Easy.toLowerCase() ||
        chartHashes.Hard.toLowerCase() !== suiDeployment.charts.Hard.toLowerCase()))) {
    throw new Error("Sui challenge charts do not match the selected Forest difficulty.");
  }
  const ranks = (top: typeof parsed.easy_top) => top.map((claim) => ({
    wallet: claim.wallet, session: claim.session, score: BigInt(claim.score), order: BigInt(claim.order),
  }));
  return {
    pot: BigInt(parsed[difficulty === "Easy" ? "easy_pot" : "hard_pot"]),
    pots: { Easy: BigInt(parsed.easy_pot), Hard: BigInt(parsed.hard_pot) },
    originalPot: BigInt(parsed[difficulty === "Easy" ? "easy_original_pot" : "hard_original_pot"]),
    refundPool: BigInt(parsed[difficulty === "Easy" ? "easy_refund_pool" : "hard_refund_pool"]),
    remaining: player.remaining, claimRegistered: player.claimRegistered, refundEligible: player.refundEligible,
    roundDate: new TextDecoder().decode(Uint8Array.from(parsed.round_date)),
    device: hex(parsed.device), chartHashes,
    rankedClaims: { Easy: ranks(parsed.easy_top), Hard: ranks(parsed.hard_top) },
    startedAtMs: Number(parsed.started_at_ms), scoreDeadlineMs: Number(parsed.score_deadline_ms),
    claimDeadlineMs: Number(parsed.claim_deadline_ms), settled: parsed.settled,
  };
}

export function buyPlays(challengeId: string, difficulty: Difficulty): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("buy_plays"), typeArguments: coinType,
    arguments: [tx.object(challengeId), tx.coin({ balance: 1_000_000n, type: suiDeployment.usdcType }), tx.pure.u8(difficultyCode(difficulty)), tx.object.clock()],
  });
  return tx;
}

export function startPaid(challengeId: string, difficulty: Difficulty): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("start_paid"), typeArguments: coinType,
    arguments: [tx.object(challengeId), tx.object(suiDeployment.registryId), tx.pure.u8(difficultyCode(difficulty)), tx.object.clock()],
  });
  return tx;
}

export function settle(challengeId: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({ target: target("settle"), typeArguments: coinType,
    arguments: [tx.object(challengeId), tx.object.clock()] });
  return tx;
}

export function refund(wallet: string, challengeId: string, difficulty: Difficulty): Transaction {
  const tx = new Transaction();
  tx.moveCall({ target: target("refund"), typeArguments: coinType,
    arguments: [tx.object(challengeId), tx.pure.address(wallet), tx.pure.u8(difficultyCode(difficulty)), tx.object.clock()] });
  return tx;
}

export type Ranking = { wallet: string; score: bigint; session: string; order: number };
export async function readRankings(client: SuiGrpcClient, challengeId: string, difficulty: Difficulty): Promise<Ranking[]> {
  const best = new Map<string, Ranking>();
  let after: string | undefined;
  let order = 0;
  do {
    const page = await client.listEvents({
      filter: { eventType: `${suiDeployment.packageId}::competition::PaidScoreRecorded` },
      order: "ascending", limit: 50, ...(after ? { after } : {}),
    });
    for (const event of page.events) {
      const row = event.json as { challenge: string; difficulty: string | number; wallet: string; score: string; session: string };
      if (row.challenge !== challengeId || Number(row.difficulty) !== difficultyCode(difficulty)) continue;
      const current = best.get(row.wallet);
      const score = BigInt(row.score);
      if (!current || score > current.score) best.set(row.wallet, { wallet: row.wallet, score, session: row.session, order });
      order++;
    }
    after = page.hasNextPage ? page.endCursor ?? undefined : undefined;
  } while (after);
  return Array.from(best.values()).sort((a, b) => a.score === b.score ?
    a.order - b.order : a.score > b.score ? -1 : 1).slice(0, 20);
}

export type RoundOption = { id: string; date: string; closeMs: number };
export async function readRounds(client: SuiGrpcClient, chartHash: string): Promise<RoundOption[]> {
  const rounds: RoundOption[] = [];
  const seen = new Set<string>();
  let before: string | undefined;
  do {
    const page = await client.listEvents({
      filter: { eventType: `${suiDeployment.packageId}::competition::ChallengeCreated` },
      order: "descending", limit: 50, ...(before ? { before } : {}),
    });
    for (const event of page.events) {
      const row = event.json as { challenge?: string; registry?: string; easy_chart_hash?: string | number[];
        hard_chart_hash?: string | number[]; round_date?: string | number[]; score_deadline_ms?: string };
      if (!row.challenge || row.registry !== suiDeployment.registryId || seen.has(row.challenge)) continue;
      const asHex = (raw: string | number[] | undefined): string => {
        if (Array.isArray(raw)) return hex(raw);
        if (typeof raw !== "string") return "";
        return hex32.test(raw) ? raw : hex(Array.from(fromBase64(raw)));
      };
      if (![asHex(row.easy_chart_hash), asHex(row.hard_chart_hash)].some((hash) => hash.toLowerCase() === chartHash.toLowerCase())) continue;
      const date = Array.isArray(row.round_date) ? new TextDecoder().decode(Uint8Array.from(row.round_date)) :
        typeof row.round_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.round_date) ? row.round_date :
          typeof row.round_date === "string" ? new TextDecoder().decode(fromBase64(row.round_date)) : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      seen.add(row.challenge);
      rounds.push({ id: row.challenge, date, closeMs: Number(row.score_deadline_ms) });
    }
    before = page.hasNextPage ? page.endCursor ?? undefined : undefined;
  } while (before);
  return rounds;
}
