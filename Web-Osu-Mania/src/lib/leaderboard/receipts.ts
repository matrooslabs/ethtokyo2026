import { parseAbi, parseEventLogs, type Address, type Hex, type TransactionReceipt } from "viem";
const events = parseAbi([
  "event EntryPaid(bytes32 indexed beatmapId,uint64 indexed dayId,bytes32 indexed sessionId,address payer,address player,address device,uint256 amount)",
  "event ScoreRecorded(bytes32 indexed beatmapId,uint64 indexed dayId,bytes32 indexed sessionId,address player,uint32 score,uint32 bestScore)",
]);
export function paidSession(receipt: TransactionReceipt, contract: Address, expected: {
  chartHash: Hex; player: Address; payer: Address; device: Address; dayId: bigint; amount: bigint;
}) {
  if (receipt.status !== "success") throw new Error("Entry transaction reverted.");
  const entry = parseEventLogs({ abi: events, eventName: "EntryPaid", logs: receipt.logs.filter(log => log.address.toLowerCase() === contract.toLowerCase()) })
    .find(({ args }) => args.beatmapId === expected.chartHash && args.dayId === expected.dayId &&
      args.player.toLowerCase() === expected.player.toLowerCase() && args.payer.toLowerCase() === expected.payer.toLowerCase() &&
      args.device.toLowerCase() === expected.device.toLowerCase() && args.amount === expected.amount);
  if (!entry) throw new Error("Confirmed transaction has no matching paid entry. Check the transaction before retrying.");
  return entry.args.sessionId;
}
export function acceptedScore(receipt: TransactionReceipt, contract: Address, expected: {
  chartHash: Hex; sessionId: Hex; player: Address; dayId: bigint;
}) {
  if (receipt.status !== "success") throw new Error("Proof transaction reverted.");
  const recorded = parseEventLogs({ abi: events, eventName: "ScoreRecorded", logs: receipt.logs.filter(log => log.address.toLowerCase() === contract.toLowerCase()) })
    .find(({ args }) => args.sessionId === expected.sessionId && args.beatmapId === expected.chartHash &&
      args.dayId === expected.dayId && args.player.toLowerCase() === expected.player.toLowerCase());
  if (!recorded) throw new Error("No accepted on-chain score for this paid session.");
  return recorded.args.score;
}
