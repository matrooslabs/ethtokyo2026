import { decodeEventLog } from 'viem';
import { leaderboardAbi } from './abi.js';

const zeroAddress = `0x${'0'.repeat(40)}`;
const str = value => value.toString();
const lower = value => value.toLowerCase();
export function normalizeLog(log) {
  if (log.removed || log.blockNumber === null || !log.blockHash || log.transactionIndex === null || log.logIndex === null || !log.transactionHash)
    throw new Error('Non-canonical or pending event');
  const { eventName, args: a } = decodeEventLog({ abi: leaderboardAbi, data: log.data, topics: log.topics, strict: true });
  const base = { chartHash: lower(a.beatmapId), dayId: str(a.dayId), position: {
    blockNumber: str(log.blockNumber), blockHash: lower(log.blockHash), transactionIndex: log.transactionIndex,
    logIndex: log.logIndex, transactionHash: lower(log.transactionHash),
  } };
  switch (eventName) {
    case 'EntryPaid': return { ...base, type: 'entry', sessionId: lower(a.sessionId), payer: lower(a.payer), player: lower(a.player), device: lower(a.device), amount: str(a.amount) };
    case 'ScoreRecorded': return { ...base, type: 'score', sessionId: lower(a.sessionId), player: lower(a.player), score: str(a.score), bestScore: str(a.bestScore) };
    case 'LeaderChanged': return { ...base, type: 'leader', sessionId: lower(a.sessionId), player: lower(a.player), score: str(a.score) };
    case 'PrizeClaimed': return { ...base, type: 'payout', recipient: lower(a.player), amount: str(a.amount) };
    case 'EntryRefunded': return { ...base, type: 'refund', recipient: lower(a.payer), amount: str(a.amount) };
    default: throw new Error(`Unsupported event ${eventName}`);
  }
}
export class ChainSource {
  constructor(client, address) { this.client = client; this.address = address; }
  async head() { return Number(await this.client.getBlockNumber({ cacheTime: 0 })); }
  async block(number) {
    const block = await this.client.getBlock({ blockNumber: BigInt(number) });
    if (!block.hash || Number(block.number) !== number) throw new Error(`Missing canonical block ${number}`);
    return { number, hash: lower(block.hash), parentHash: lower(block.parentHash) };
  }
  async events(from, to) {
    // No event filter: fail closed if the deployed contract emits unknown ABI.
    const logs = await this.client.getLogs({ address: this.address, fromBlock: BigInt(from), toBlock: BigInt(to) });
    return logs.map(log => {
      if (lower(log.address) !== lower(this.address)) throw new Error('Unexpected log address');
      return normalizeLog(log);
    });
  }
  async reconcile(view, tip) {
    const mismatches = [];
    let reads = 0;
    const read = (functionName, args) => {
      reads++;
      return this.client.readContract({ address: this.address, abi: leaderboardAbi, functionName, args, blockNumber: BigInt(tip.number) });
    };
    const compare = (scope, field, indexed, onchain) => {
      if (String(indexed).toLowerCase() !== String(onchain).toLowerCase()) mismatches.push({ ...scope, field, indexed, onchain: String(onchain) });
    };
    try {
      for (const round of view.rounds.values()) {
        const scope = { chartHash: round.chartHash, dayId: round.dayId };
        const args = [round.chartHash, BigInt(round.dayId)];
        const [totalPaid, totalRefunded, leader, highestScore, prizeClaimed] = await read('rounds', args);
        compare(scope, 'totalPaid', round.pot, totalPaid);
        compare(scope, 'totalRefunded', round.totalRefunds, totalRefunded);
        compare(scope, 'leader', round.leader?.player ?? zeroAddress, leader);
        compare(scope, 'highestScore', round.leader?.score ?? '0', highestScore);
        compare(scope, 'prizeClaimed', round.claimed, prizeClaimed);
        const remaining = prizeClaimed ? 0n : totalPaid - totalRefunded;
        compare(scope, 'remainingPot', round.remainingPot, remaining);
        const checkedPlayers = new Set();
        for (const row of round.rankings) {
          // Rankings are descending, so the first attempt is this player's on-chain best.
          if (checkedPlayers.has(row.player)) continue;
          checkedPlayers.add(row.player);
          const [exists, bestScore] = await read('records', [...args, row.player]);
          compare({ ...scope, player: row.player }, 'exists', true, exists);
          compare({ ...scope, player: row.player }, 'bestScore', row.score, bestScore);
        }
        const payers = new Map();
        for (const attempt of view.attempts.values()) if (attempt.chartHash === round.chartHash && attempt.dayId === round.dayId)
          payers.set(attempt.payer, (payers.get(attempt.payer) ?? 0n) + BigInt(attempt.amount));
        for (const refund of view.settlements) if (refund.type === 'refund' && refund.chartHash === round.chartHash && refund.dayId === round.dayId)
          payers.set(refund.recipient, (payers.get(refund.recipient) ?? 0n) - BigInt(refund.amount));
        for (const [payer, amount] of payers) compare({ ...scope, payer }, 'refundablePayments', str(amount), await read('refundablePayments', [...args, payer]));
      }
      return { status: mismatches.length ? 'mismatch' : 'ok', blockNumber: String(tip.number), blockHash: tip.hash, reads, mismatches };
    } catch (error) {
      return { status: 'error', blockNumber: String(tip.number), blockHash: tip.hash, reads, mismatches, error: 'Historical contract read failed; verify RPC archive support and deployed ABI' };
    }
  }
}
