import { bcs } from "@mysten/sui/bcs";
import { Transaction } from "@mysten/sui/transactions";
import type { SuiGrpcClient } from "@mysten/sui/grpc";

export const suiDeployment = {
  packageId: import.meta.env.VITE_SUI_PACKAGE_ID || "",
  registryId: import.meta.env.VITE_SUI_REGISTRY_ID || "",
  competitionId: import.meta.env.VITE_SUI_COMPETITION_ID || "",
  usdcType: import.meta.env.VITE_SUI_USDC_TYPE || "",
};

export const configured = Object.values(suiDeployment).every(Boolean);
const target = (method: string) => `${suiDeployment.packageId}::competition::${method}`;
const coinType = [suiDeployment.usdcType];

const dynamicTable = bcs.struct("Table", { id: bcs.Address, size: bcs.u64() });
const competitionObject = bcs.struct("Competition", {
  id: bcs.Address,
  registry: bcs.Address,
  round_id: bcs.vector(bcs.u8()),
  chart_hash: bcs.vector(bcs.u8()),
  device: bcs.vector(bcs.u8()),
  sales_deadline_ms: bcs.u64(),
  starts_deadline_ms: bcs.u64(),
  score_deadline_ms: bcs.u64(),
  claim_deadline_ms: bcs.u64(),
  pot: bcs.u64(),
  wallets: dynamicTable,
  people: dynamicTable,
  attempts: dynamicTable,
  has_winner: bcs.bool(),
  winner: bcs.Address,
  winning_session: bcs.option(bcs.Address),
  high_score: bcs.u64(),
  prize_paid: bcs.bool(),
});

export type CompetitionState = {
  pot: bigint;
  remaining: bigint;
  device: string;
  chartHash: string;
  hasWinner: boolean;
  winner: string;
  highScore: bigint;
  salesDeadlineMs: number;
  startsDeadlineMs: number;
  scoreDeadlineMs: number;
  claimDeadlineMs: number;
  prizePaid: boolean;
};

async function remainingPlays(client: SuiGrpcClient, wallet: string): Promise<bigint> {
  const tx = new Transaction();
  tx.setSender(wallet);
  tx.moveCall({ target: target("remaining_plays"), typeArguments: coinType,
    arguments: [tx.object(suiDeployment.competitionId), tx.pure.address(wallet)] });
  const result = await client.simulateTransaction({ transaction: tx, include: { commandResults: true }, checksEnabled: false });
  const bytes = result.Transaction && result.commandResults?.[0]?.returnValues?.[0]?.bcs;
  if (!bytes) throw new Error("Unable to read remaining plays from Sui.");
  return BigInt(bcs.u64().parse(bytes));
}

export async function readCompetition(client: SuiGrpcClient, wallet: string): Promise<CompetitionState> {
  if (!configured) throw new Error("Sui competition deployment is not configured.");
  const [object, remaining] = await Promise.all([
    client.getObject({ objectId: suiDeployment.competitionId, include: { content: true } }),
    remainingPlays(client, wallet),
  ]);
  const content = object.object?.content;
  if (!content || object.object?.type !== `${suiDeployment.packageId}::competition::Competition<${suiDeployment.usdcType}>`) {
    throw new Error("Sui competition object does not match the configured vault.");
  }
  const parsed = competitionObject.parse(content);
  if (parsed.registry !== suiDeployment.registryId) throw new Error("Competition registry does not match this deployment.");
  return {
    pot: BigInt(parsed.pot),
    remaining,
    hasWinner: parsed.has_winner,
    winner: parsed.winner,
    highScore: BigInt(parsed.high_score),
    device: `0x${Array.from(parsed.device, (value) => value.toString(16).padStart(2, "0")).join("")}`,
    chartHash: `0x${Array.from(parsed.chart_hash, (value) => value.toString(16).padStart(2, "0")).join("")}`,
    salesDeadlineMs: Number(parsed.sales_deadline_ms),
    startsDeadlineMs: Number(parsed.starts_deadline_ms),
    scoreDeadlineMs: Number(parsed.score_deadline_ms),
    claimDeadlineMs: Number(parsed.claim_deadline_ms),
    prizePaid: parsed.prize_paid,
  };
}

export function buyPlays(): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("buy_plays"),
    typeArguments: coinType,
    arguments: [tx.object(suiDeployment.competitionId), tx.coin({ balance: 1_000_000n, type: suiDeployment.usdcType }), tx.object.clock()],
  });
  return tx;
}

export function startPaid(): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("start_paid"),
    typeArguments: coinType,
    arguments: [tx.object(suiDeployment.competitionId), tx.object(suiDeployment.registryId), tx.object.clock()],
  });
  return tx;
}

export function claimPrize(): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("claim_prize"),
    typeArguments: coinType,
    arguments: [tx.object(suiDeployment.competitionId), tx.object.clock()],
  });
  return tx;
}

export function refund(wallet: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: target("refund"),
    typeArguments: coinType,
    arguments: [tx.object(suiDeployment.competitionId), tx.pure.address(wallet), tx.object.clock()],
  });
  return tx;
}

export type Ranking = { wallet: string; score: bigint; session: string };
export async function readRankings(client: SuiGrpcClient, winner?: string): Promise<Ranking[]> {
  const best = new Map<string, Ranking>();
  let before: string | undefined;
  do {
    const page = await client.listEvents({
      filter: { eventType: `${suiDeployment.packageId}::competition::PaidScoreRecorded` },
      order: "descending", limit: 50, ...(before ? { before } : {}),
    });
    for (const event of page.events) {
      const row = event.json as { competition: string; wallet: string; score: string; session: string };
      if (row.competition !== suiDeployment.competitionId) continue;
      const current = best.get(row.wallet);
      const score = BigInt(row.score);
      if (!current || score > current.score) best.set(row.wallet, { wallet: row.wallet, score, session: row.session });
    }
    before = page.hasNextPage ? page.endCursor ?? undefined : undefined;
  } while (before);
  return Array.from(best.values()).sort((a, b) => a.score === b.score ?
    a.wallet === winner ? -1 : b.wallet === winner ? 1 : 0 : a.score > b.score ? -1 : 1).slice(0, 20);
}
