import { isAddress, parseAbi, type Address } from "viem";
export const leaderboardAbi = parseAbi([
  "function token() view returns (address)",
  "function registry() view returns (address)",
  "function enter(bytes32 beatmapId,address player,address device,uint64 expectedDayId) returns (bytes32 sessionId)",
  "function claim(bytes32 beatmapId,uint64 dayId)",
  "function refund(bytes32 beatmapId,uint64 dayId)",
  "function rounds(bytes32,uint64) view returns (uint256 totalPaid,uint256 totalRefunded,address leader,uint32 highestScore,bool prizeClaimed)",
  "function records(bytes32,uint64,address) view returns (bool exists,uint32 bestScore)",
  "function entries(bytes32) view returns (bytes32 beatmapId,uint64 dayId,address payer,address player,bool scored)",
  "function refundablePayments(bytes32,uint64,address) view returns (uint256)",
  "event EntryPaid(bytes32 indexed beatmapId,uint64 indexed dayId,bytes32 indexed sessionId,address payer,address player,address device,uint256 amount)",
  "event ScoreRecorded(bytes32 indexed beatmapId,uint64 indexed dayId,bytes32 indexed sessionId,address player,uint32 score,uint32 bestScore)",
]);
const configured = import.meta.env.VITE_LEADERBOARD_ADDRESS;
export const leaderboardAddress: Address | undefined = configured && isAddress(configured) ? configured : undefined;
export const bridgeUrl = (import.meta.env.VITE_PROVER_BRIDGE_URL || "").replace(/\/$/, "");
export const indexerUrl = (import.meta.env.VITE_LEADERBOARD_INDEXER_URL || "").replace(/\/$/, "");
