// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IPaidSessionRegistry {
    function openPaidSession(bytes32 chartHash, address player, address device, uint64 expiresAt)
        external returns (bytes32 sessionId);
}

interface IEntryToken {
    function decimals() external view returns (uint8);
    function balanceOf(address) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @notice One USDC per attempt; separate winner-takes-all rounds for each chart and UTC day.
contract DailyLeaderboard {
    uint256 public constant ENTRY_FEE = 1_000_000;
    IEntryToken public immutable token;
    IPaidSessionRegistry public immutable registry;

    struct PlayerRecord { bool exists; uint32 bestScore; }
    struct DailyRound {
        uint256 totalPaid;
        uint256 totalRefunded;
        address leader;
        uint32 highestScore;
        bool prizeClaimed;
    }
    struct PaidEntry {
        bytes32 beatmapId;
        uint64 dayId;
        address payer;
        address player;
        bool scored;
    }
    mapping(bytes32 => mapping(uint64 => DailyRound)) public rounds;
    mapping(bytes32 => mapping(uint64 => mapping(address => PlayerRecord))) public records;
    mapping(bytes32 => PaidEntry) public entries;
    mapping(bytes32 => mapping(uint64 => mapping(address => uint256))) public refundablePayments;
    uint256 private entered;

    event EntryPaid(bytes32 indexed beatmapId, uint64 indexed dayId, bytes32 indexed sessionId,
        address payer, address player, address device, uint256 amount);
    event ScoreRecorded(bytes32 indexed beatmapId, uint64 indexed dayId, bytes32 indexed sessionId,
        address player, uint32 score, uint32 bestScore);
    event LeaderChanged(bytes32 indexed beatmapId, uint64 indexed dayId, address indexed player,
        bytes32 sessionId, uint32 score);
    event PrizeClaimed(bytes32 indexed beatmapId, uint64 indexed dayId, address indexed player, uint256 amount);
    event EntryRefunded(bytes32 indexed beatmapId, uint64 indexed dayId, address indexed payer, uint256 amount);

    constructor(IEntryToken token_, IPaidSessionRegistry registry_) {
        require(address(token_).code.length != 0 && address(registry_).code.length != 0, "invalid dependency");
        require(token_.decimals() == 6, "token must have six decimals");
        token = token_;
        registry = registry_;
    }

    modifier nonReentrant() {
        require(entered == 0, "reentrant call");
        entered = 1;
        _;
        entered = 0;
    }

    function currentDay() public view returns (uint64) { return uint64(block.timestamp / 1 days); }
    function endAt(uint64 dayId) public pure returns (uint256) { return (uint256(dayId) + 1) * 1 days; }

    function enter(bytes32 beatmapId, address player, address device, uint64 expectedDayId)
        external nonReentrant returns (bytes32 sessionId)
    {
        require(player != address(0), "invalid player");
        require(expectedDayId == currentDay(), "day changed");
        uint256 deadline = endAt(expectedDayId);
        require(deadline <= type(uint64).max, "deadline overflow");
        uint256 beforeBalance = token.balanceOf(address(this));
        _callToken(abi.encodeCall(IEntryToken.transferFrom, (msg.sender, address(this), ENTRY_FEE)));
        require(token.balanceOf(address(this)) == beforeBalance + ENTRY_FEE, "incorrect payment received");
        sessionId = registry.openPaidSession(beatmapId, player, device, uint64(deadline));
        require(sessionId != bytes32(0) && entries[sessionId].payer == address(0), "invalid session");
        entries[sessionId] = PaidEntry(beatmapId, expectedDayId, msg.sender, player, false);
        rounds[beatmapId][expectedDayId].totalPaid += ENTRY_FEE;
        refundablePayments[beatmapId][expectedDayId][msg.sender] += ENTRY_FEE;
        emit EntryPaid(beatmapId, expectedDayId, sessionId, msg.sender, player, device, ENTRY_FEE);
    }

    function recordVerifiedScore(bytes32 sessionId, uint32 score) external nonReentrant {
        require(msg.sender == address(registry), "registry only");
        PaidEntry storage entry = entries[sessionId];
        require(entry.payer != address(0) && !entry.scored, "unknown or scored entry");
        require(block.timestamp < endAt(entry.dayId), "round closed");
        entry.scored = true;
        PlayerRecord storage record = records[entry.beatmapId][entry.dayId][entry.player];
        if (!record.exists || score > record.bestScore) {
            record.exists = true;
            record.bestScore = score;
        }
        emit ScoreRecorded(entry.beatmapId, entry.dayId, sessionId, entry.player, score, record.bestScore);
        DailyRound storage round = rounds[entry.beatmapId][entry.dayId];
        if (round.leader == address(0) || score > round.highestScore) {
            round.leader = entry.player;
            round.highestScore = score;
            emit LeaderChanged(entry.beatmapId, entry.dayId, entry.player, sessionId, score);
        }
    }

    /// @notice Anyone may trigger settlement; payment always goes to the winning player.
    function claim(bytes32 beatmapId, uint64 dayId) external nonReentrant {
        require(block.timestamp >= endAt(dayId), "round open");
        DailyRound storage round = rounds[beatmapId][dayId];
        require(round.leader != address(0) && !round.prizeClaimed, "no claimable prize");
        round.prizeClaimed = true;
        _callToken(abi.encodeCall(IEntryToken.transfer, (round.leader, round.totalPaid)));
        emit PrizeClaimed(beatmapId, dayId, round.leader, round.totalPaid);
    }

    function refund(bytes32 beatmapId, uint64 dayId) external nonReentrant {
        require(block.timestamp >= endAt(dayId), "round open");
        DailyRound storage round = rounds[beatmapId][dayId];
        require(round.leader == address(0), "round has winner");
        uint256 amount = refundablePayments[beatmapId][dayId][msg.sender];
        require(amount != 0, "nothing to refund");
        refundablePayments[beatmapId][dayId][msg.sender] = 0;
        round.totalRefunded += amount;
        _callToken(abi.encodeCall(IEntryToken.transfer, (msg.sender, amount)));
        emit EntryRefunded(beatmapId, dayId, msg.sender, amount);
    }

    function _callToken(bytes memory data) private {
        (bool ok, bytes memory result) = address(token).call(data);
        require(ok && (result.length == 0 || (result.length == 32 && abi.decode(result, (bool)))), "token transfer failed");
    }
}
