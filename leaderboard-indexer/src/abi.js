import { parseAbi } from 'viem';

// Exact event/getter signatures from scoring/gkr-scoring/contracts/src/DailyLeaderboard.sol.
// test/abi.test.js checks these against the compiled contract artifact when present.
export const leaderboardAbi = parseAbi([
  'event EntryPaid(bytes32 indexed beatmapId, uint64 indexed dayId, bytes32 indexed sessionId, address payer, address player, address device, uint256 amount)',
  'event ScoreRecorded(bytes32 indexed beatmapId, uint64 indexed dayId, bytes32 indexed sessionId, address player, uint32 score, uint32 bestScore)',
  'event LeaderChanged(bytes32 indexed beatmapId, uint64 indexed dayId, address indexed player, bytes32 sessionId, uint32 score)',
  'event PrizeClaimed(bytes32 indexed beatmapId, uint64 indexed dayId, address indexed player, uint256 amount)',
  'event EntryRefunded(bytes32 indexed beatmapId, uint64 indexed dayId, address indexed payer, uint256 amount)',
  'function rounds(bytes32 beatmapId, uint64 dayId) view returns (uint256 totalPaid, uint256 totalRefunded, address leader, uint32 highestScore, bool prizeClaimed)',
  'function records(bytes32 beatmapId, uint64 dayId, address player) view returns (bool exists, uint32 bestScore)',
  'function refundablePayments(bytes32 beatmapId, uint64 dayId, address payer) view returns (uint256)',
]);
