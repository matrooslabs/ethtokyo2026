# DailyLeaderboard consumer API (final PR1 contract surface)

Solidity source: `scoring/gkr-scoring/contracts/src/DailyLeaderboard.sol`.
Constructor: `constructor(IEntryToken token, IPaidSessionRegistry registry)`; token must have six decimals. `ENTRY_FEE() = 1000000`. Public immutable `token()` and `registry()` return addresses.

- `enter(bytes32 beatmapId,address player,address device,uint64 expectedDayId) returns(bytes32 sessionId)` — caller pays; player wins; approve token first.
- `recordVerifiedScore(bytes32 sessionId,uint32 score)` — registry only.
- `claim(bytes32 beatmapId,uint64 dayId)` — anyone triggers, winner receives.
- `refund(bytes32 beatmapId,uint64 dayId)` — refunds caller's payments if no winner.
- `currentDay() returns(uint64)`; `endAt(uint64 dayId) returns(uint256)`.
- `rounds(bytes32,uint64) returns(uint256 totalPaid,uint256 totalRefunded,address leader,uint32 highestScore,bool prizeClaimed)`.
- `records(bytes32,uint64,address) returns(bool exists,uint32 bestScore)`.
- `entries(bytes32 sessionId) returns(bytes32 beatmapId,uint64 dayId,address payer,address player,bool scored)`.
- `refundablePayments(bytes32,uint64,address) returns(uint256)` — historical paid amount until refunded; only refundable after midnight with zero leader.

Events (exact ABI):
```solidity
event EntryPaid(bytes32 indexed beatmapId, uint64 indexed dayId, bytes32 indexed sessionId, address payer, address player, address device, uint256 amount);
event ScoreRecorded(bytes32 indexed beatmapId, uint64 indexed dayId, bytes32 indexed sessionId, address player, uint32 score, uint32 bestScore);
event LeaderChanged(bytes32 indexed beatmapId, uint64 indexed dayId, address indexed player, bytes32 sessionId, uint32 score);
event PrizeClaimed(bytes32 indexed beatmapId, uint64 indexed dayId, address indexed player, uint256 amount);
event EntryRefunded(bytes32 indexed beatmapId, uint64 indexed dayId, address indexed payer, uint256 amount);
```

Paid registry boundary: `openPaidSession(bytes32 chartHash,address player,address device,uint64 expiresAt) returns(bytes32)` opens Mode A calldata sessions. Registry configured once by organizer using `setLeaderboard(address)`; immutable after setting. Match ID is derived from chart/day. Existing organizer unpaid APIs remain. Callback receives proof-derived score only, strictly before next UTC midnight.

Rank wallet best scores by score descending, then the event order of the first attempt achieving that best score (block, transaction, log). Equal/lower subsequent scores do not replace this first-achievement ordering. Zero is a valid score; zero leader address means no accepted score. Entry events occur after registry SessionOpened in the same transaction.
