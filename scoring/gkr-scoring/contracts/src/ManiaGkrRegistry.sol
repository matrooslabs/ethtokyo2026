// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {GkrScoreVerifier} from "./GkrScoreVerifier.sol";

/// @notice Devices, charts, sessions and score recording for OSUMANIA_GKR_V1 (SPEC.md §8).
/// @dev Session/device semantics follow sp1-scoring's ManiaScoreVerifier; the SP1 proof is replaced
///      by a GKR/sumcheck proof checked by `GkrScoreVerifier`. No escrow or payout.
contract ManiaGkrRegistry {
    bytes32 public constant RULESET_ID = sha256("OSUMANIA_ONCHAIN_RULESET_V1");
    bytes32 public constant INPUT_POLICY_A = sha256("OSUMANIA_INPUT_POLICY_V1");
    bytes32 public constant INPUT_POLICY_B = sha256("OSUMANIA_INPUT_POLICY_V2_KZG");
    uint8 public constant MODE_CALLDATA = 1;
    uint8 public constant MODE_COMMITTED = 2;
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    uint256 private constant EVENT_BYTES = 14;
    uint256 private constant CHUNK_EVENTS = 32;
    uint256 private constant MAX_EVENTS = 50_000;

    struct Device {
        bytes32 bitstreamHash;
        bool active;
    }

    struct Header {
        uint64 chainId;
        address verifier;
        bytes32 matchId;
        bytes32 sessionId;
        bytes32 challenge;
        address player;
        address device;
        bytes32 chartHash;
        bytes32 rulesetId;
        bytes32 bitstreamHash;
        bytes32 inputPolicyHash;
    }

    struct Chart {
        uint256[2] commitment;
        uint64 m;
        uint8 bits;
        uint64 components;
        uint64 maxEnd;
        bool registered;
    }

    struct Session {
        Header header;
        uint8 mode;
        uint64 expiresAt;
        bool consumed;
        uint32 score;
        uint32[6] judgements;
    }

    struct Submission {
        uint64 duration;
        uint8[4] laneBits;
        uint32[5] counts;
    }

    address public immutable organizer;
    GkrScoreVerifier public immutable verifier;
    uint256 private nonce;
    mapping(address => Device) public devices;
    mapping(bytes32 => Chart) private charts;
    mapping(bytes32 => Session) private sessions;

    event ChartRegistered(bytes32 indexed chartHash, uint64 notes, uint64 components);
    event SessionOpened(bytes32 indexed sessionId, address indexed player, address indexed device, uint8 mode);
    event ScoreAccepted(bytes32 indexed sessionId, address indexed player, uint32 score);

    constructor(GkrScoreVerifier verifier_) {
        require(address(verifier_).code.length != 0, "invalid verifier");
        organizer = msg.sender;
        verifier = verifier_;
    }

    modifier onlyOrganizer() {
        require(msg.sender == organizer, "organizer only");
        _;
    }

    function setDevice(address signer, bytes32 bitstreamHash, bool active) external onlyOrganizer {
        require(signer != address(0) && bitstreamHash != bytes32(0), "invalid device");
        devices[signer] = Device(bitstreamHash, active);
    }

    /// @notice Validates the SP1-canonical chart bytes on-chain and binds them to a KZG commitment.
    function registerChart(bytes calldata chart, uint256[2] calldata commitment, uint256[] calldata proof)
        external
        onlyOrganizer
        returns (bytes32 chartHash)
    {
        GkrScoreVerifier.ChartInfo memory info = verifier.checkChart(chart, commitment, proof);
        chartHash = info.chartHash;
        require(!charts[chartHash].registered, "chart already registered");
        charts[chartHash] = Chart(commitment, info.m, info.bits, info.components, info.maxEnd, true);
        emit ChartRegistered(chartHash, info.m, info.components);
    }

    function getChart(bytes32 chartHash) external view returns (Chart memory) {
        return charts[chartHash];
    }

    function openSession(bytes32 matchId, bytes32 chartHash, address player, address device, uint64 expiresAt, uint8 mode)
        external
        onlyOrganizer
        returns (bytes32 id)
    {
        require(block.chainid <= type(uint64).max, "chain id too large");
        require(devices[device].active && player != address(0), "invalid participant");
        require(charts[chartHash].registered && expiresAt > block.timestamp, "invalid chart or deadline");
        require(mode == MODE_CALLDATA || mode == MODE_COMMITTED, "invalid mode");
        id = keccak256(abi.encode(block.chainid, address(this), ++nonce, matchId, player, device));
        bytes32 challenge = keccak256(abi.encode(id, block.prevrandao, blockhash(block.number - 1)));
        Header memory h = Header(
            uint64(block.chainid),
            address(this),
            matchId,
            id,
            challenge,
            player,
            device,
            chartHash,
            RULESET_ID,
            devices[device].bitstreamHash,
            mode == MODE_CALLDATA ? INPUT_POLICY_A : INPUT_POLICY_B
        );
        Session storage s = sessions[id];
        s.header = h;
        s.mode = mode;
        s.expiresAt = expiresAt;
        emit SessionOpened(id, player, device, mode);
    }

    function getSession(bytes32 id) external view returns (Session memory) {
        return sessions[id];
    }

    // ------------------------------------------------------------------ digests

    function _headerPrefix(Header memory h) internal pure returns (bytes memory) {
        return abi.encodePacked(
            h.chainId, h.verifier, h.matchId, h.sessionId, h.challenge, h.player, h.device, h.chartHash, h.rulesetId,
            h.bitstreamHash, h.inputPolicyHash
        );
    }

    /// SP1 V1 digest (unchanged hardware protocol).
    function sessionDigestV1(Header memory h, uint32 n, uint64 duration, bytes32 root)
        public
        pure
        returns (bytes32)
    {
        return sha256(
            bytes.concat(
                "OSUMANIA_HARDWARE_SESSION_V1", bytes2(uint16(1)), _headerPrefix(h), abi.encodePacked(n, duration, root)
            )
        );
    }

    /// Mode B digest: V1 fields plus the device's KZG trace commitment.
    function sessionDigestV2(Header memory h, uint32 n, uint64 duration, bytes32 root, uint256[2] memory tc)
        public
        pure
        returns (bytes32)
    {
        return sha256(
            bytes.concat(
                "OSUMANIA_HARDWARE_SESSION_V2",
                bytes2(uint16(2)),
                _headerPrefix(h),
                abi.encodePacked(n, duration, root, tc[0], tc[1])
            )
        );
    }

    /// SHA-256 hash chain over 32-event chunks (SP1 SPEC); also enforces seq == index.
    function traceRoot(bytes32 sessionId, bytes calldata events) public pure returns (bytes32 root) {
        require(events.length % EVENT_BYTES == 0, "bad trace encoding");
        uint256 n = events.length / EVENT_BYTES;
        for (uint256 j = 0; j < n; j++) {
            require(uint32(bytes4(events[j * EVENT_BYTES:j * EVENT_BYTES + 4])) == j, "bad sequence number");
        }
        root = sha256(abi.encodePacked("OSUMANIA_TRACE_V1", sessionId));
        for (uint256 i = 0; i * CHUNK_EVENTS < n; i++) {
            uint256 start = i * CHUNK_EVENTS;
            uint256 count = n - start < CHUNK_EVENTS ? n - start : CHUNK_EVENTS;
            root = sha256(
                abi.encodePacked(
                    root,
                    uint32(i),
                    uint16(count),
                    events[start * EVENT_BYTES:(start + count) * EVENT_BYTES]
                )
            );
        }
    }

    // ------------------------------------------------------------------ submission

    function _openSession(bytes32 id, uint8 mode) internal view returns (Session storage s) {
        s = sessions[id];
        require(s.header.player != address(0) && !s.consumed, "unknown or consumed session");
        require(s.mode == mode, "wrong session mode");
        require(block.timestamp <= s.expiresAt, "session expired");
        require(s.header.chainId == block.chainid && s.header.verifier == address(this), "wrong domain");
        Device memory d = devices[s.header.device];
        require(d.active && d.bitstreamHash == s.header.bitstreamHash, "device revoked or changed");
    }

    function _checkSignature(bytes32 digest, bytes calldata sig, address device) internal pure {
        require(sig.length == 65, "invalid signature length");
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        require((v == 27 || v == 28) && uint256(s) <= HALF_ORDER, "noncanonical signature");
        require(ecrecover(digest, v, r, s) == device, "invalid device signature");
    }

    function _statement(Session storage s, bytes32 digest, uint256 n, Submission calldata sub)
        internal
        view
        returns (GkrScoreVerifier.Statement memory st)
    {
        Chart storage ch = charts[s.header.chartHash];
        st.mode = s.mode;
        st.sessionDigest = digest;
        st.n = uint64(n);
        st.duration = sub.duration;
        st.chartCommitment = ch.commitment;
        st.m = ch.m;
        st.chartBits = ch.bits;
        st.components = ch.components;
        st.maxEnd = ch.maxEnd;
        st.laneBits = sub.laneBits;
        st.counts = sub.counts;
    }

    function _record(Session storage s, uint256[6] memory j, uint256 score) internal {
        s.consumed = true;
        s.score = uint32(score);
        for (uint256 i = 0; i < 6; i++) {
            s.judgements[i] = uint32(j[i]);
        }
        emit ScoreAccepted(s.header.sessionId, s.header.player, uint32(score));
    }

    /// @notice Mode A: the full trace is calldata; anyone may relay.
    function submitCalldata(
        bytes32 id,
        bytes calldata events,
        Submission calldata sub,
        uint256[] calldata proof,
        bytes calldata sig
    ) external {
        Session storage s = _openSession(id, MODE_CALLDATA);
        uint256 n = events.length / EVENT_BYTES;
        require(n <= MAX_EVENTS, "too many events");
        bytes32 root = traceRoot(id, events);
        bytes32 digest = sessionDigestV1(s.header, uint32(n), sub.duration, root);
        _checkSignature(digest, sig, s.header.device);
        GkrScoreVerifier.Statement memory st = _statement(s, digest, n, sub);
        (uint256[6] memory j, uint256 score) = verifier.verify(st, proof, events);
        _record(s, j, score);
    }

    /// @notice Mode B: the device signed a KZG commitment to the trace; the trace is not posted.
    function submitCommitted(
        bytes32 id,
        uint32 n,
        bytes32 root,
        uint256[2] calldata traceCommitment,
        Submission calldata sub,
        uint256[] calldata proof,
        bytes calldata sig
    ) external {
        Session storage s = _openSession(id, MODE_COMMITTED);
        require(n <= MAX_EVENTS, "too many events");
        bytes32 digest = sessionDigestV2(s.header, n, sub.duration, root, traceCommitment);
        _checkSignature(digest, sig, s.header.device);
        GkrScoreVerifier.Statement memory st = _statement(s, digest, n, sub);
        st.traceCommitment = traceCommitment;
        (uint256[6] memory j, uint256 score) = verifier.verify(st, proof, "");
        _record(s, j, score);
    }
}
