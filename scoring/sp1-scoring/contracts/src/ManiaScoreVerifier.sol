// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ISP1Verifier {
    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view;
}

/// @notice Prototype result registry: real device signatures + an externally deployed SP1 verifier.
/// @dev No escrow, hardware enrollment attestation, or official lazer score compatibility.
contract ManiaScoreVerifier {
    bytes32 public constant RULESET_ID = sha256("OSUMANIA_ONCHAIN_RULESET_V1");
    bytes32 public constant INPUT_POLICY_HASH = sha256("OSUMANIA_INPUT_POLICY_V1");
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

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

    // Field order and widths must match core::PublicValues::abi_encode().
    struct PublicValues {
        bytes32 sessionId;
        bytes32 chartHash;
        bytes32 rulesetId;
        bytes32 traceRoot;
        bytes32 sessionDigest;
        uint32 eventCount;
        uint64 durationUs;
        uint32 score;
        uint64 achievedPoints;
        uint64 maximumPoints;
        uint32[6] judgements;
    }

    struct Session {
        Header header;
        uint64 expiresAt;
        bool consumed;
        uint32 score;
    }

    address public immutable organizer;
    ISP1Verifier public immutable sp1Verifier;
    bytes32 public immutable programVKey;
    uint256 private nonce;
    mapping(address => Device) public devices;
    mapping(bytes32 => Session) private sessions;
    event SessionOpened(bytes32 indexed sessionId, address indexed player, address indexed device);
    event ScoreAccepted(bytes32 indexed sessionId, address indexed player, uint32 score);

    constructor(address verifier_, bytes32 vkey_) {
        require(verifier_.code.length != 0 && vkey_ != bytes32(0), "invalid SP1 configuration");
        organizer = msg.sender;
        sp1Verifier = ISP1Verifier(verifier_);
        programVKey = vkey_;
    }

    modifier onlyOrganizer() {
        require(msg.sender == organizer, "organizer only");
        _;
    }

    function setDevice(address signer, bytes32 bitstreamHash, bool active) external onlyOrganizer {
        require(signer != address(0) && bitstreamHash != bytes32(0), "invalid device");
        devices[signer] = Device(bitstreamHash, active);
    }

    /// @dev Organizer is the chart/match authority in this prototype. No user-supplied chart substitution.
    function openSession(bytes32 matchId, bytes32 chartHash, address player, address device, uint64 expiresAt)
        external
        onlyOrganizer
        returns (bytes32 id)
    {
        require(block.chainid <= type(uint64).max, "chain id too large");
        require(devices[device].active && player != address(0), "invalid participant");
        require(chartHash != bytes32(0) && expiresAt > block.timestamp, "invalid chart or deadline");
        id = keccak256(abi.encode(block.chainid, address(this), ++nonce, matchId, player, device));
        // Fresh domain separation, not a claim of unpredictable cryptographic randomness.
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
            INPUT_POLICY_HASH
        );
        sessions[id] = Session(h, expiresAt, false, 0);
        emit SessionOpened(id, player, device);
    }

    function getSession(bytes32 id) external view returns (Session memory) {
        return sessions[id];
    }

    /// @dev Raw SHA256 prehash, NOT personal_sign or EIP-191. SE050 DER signatures need r,s conversion
    /// and public-key recovery-id derivation/low-s normalization before submission.
    function sessionDigest(Header memory h, PublicValues memory p) public pure returns (bytes32) {
        return sha256(
            bytes.concat(
                abi.encodePacked(
                    "OSUMANIA_HARDWARE_SESSION_V1",
                    uint16(1),
                    h.chainId,
                    h.verifier,
                    h.matchId,
                    h.sessionId,
                    h.challenge,
                    h.player,
                    h.device
                ),
                abi.encodePacked(
                    h.chartHash,
                    h.rulesetId,
                    h.bitstreamHash,
                    h.inputPolicyHash,
                    p.eventCount,
                    p.durationUs,
                    p.traceRoot
                )
            )
        );
    }

    /// @notice Anyone may relay; score ownership always comes from the previously opened session.
    function submit(bytes calldata publicValues, bytes calldata proofBytes, bytes calldata deviceSignature) external {
        require(publicValues.length == 512, "invalid public values length");
        PublicValues memory p = abi.decode(publicValues, (PublicValues));
        Session storage s = sessions[p.sessionId];
        require(s.header.player != address(0) && !s.consumed, "unknown or consumed session");
        require(block.timestamp <= s.expiresAt, "session expired");
        require(s.header.chainId == block.chainid && s.header.verifier == address(this), "wrong domain");
        Device memory device = devices[s.header.device];
        require(device.active && device.bitstreamHash == s.header.bitstreamHash, "device revoked or changed");
        require(p.chartHash == s.header.chartHash && p.rulesetId == RULESET_ID, "wrong chart or ruleset");
        require(p.sessionDigest == sessionDigest(s.header, p), "wrong session digest");
        require(
            p.score <= 1_000_000 && p.eventCount <= 50_000 && p.durationUs <= 1_800_000_000, "invalid result bounds"
        );
        require(deviceSignature.length == 65, "invalid signature length");
        bytes32 r;
        bytes32 sigS;
        uint8 v;
        assembly {
            r := calldataload(deviceSignature.offset)
            sigS := calldataload(add(deviceSignature.offset, 32))
            v := byte(0, calldataload(add(deviceSignature.offset, 64)))
        }
        require((v == 27 || v == 28) && uint256(sigS) <= HALF_ORDER, "noncanonical signature");
        require(ecrecover(p.sessionDigest, v, r, sigS) == s.header.device, "invalid device signature");
        sp1Verifier.verifyProof(programVKey, publicValues, proofBytes);
        s.consumed = true;
        s.score = p.score;
        emit ScoreAccepted(p.sessionId, s.header.player, p.score);
    }
}
