// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ManiaScoreVerifier, ISP1Verifier} from "../src/ManiaScoreVerifier.sol";

interface Vm {
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
    function warp(uint256) external;
    function expectRevert() external;
    function readFile(string calldata) external view returns (string memory);
    function parseJsonBytes(string calldata, string calldata) external pure returns (bytes memory);
}

/// @dev Tests application binding only. This is deliberately NOT a cryptographic SP1 verifier.
contract MockSP1Verifier is ISP1Verifier {
    bytes32 public expected;

    function setExpected(bytes memory values) external {
        expected = keccak256(values);
    }

    function verifyProof(bytes32 vkey, bytes calldata values, bytes calldata proof) external view {
        require(
            vkey == bytes32(uint256(123)) && keccak256(values) == expected && keccak256(proof) == keccak256(hex"cafe"),
            "mock rejection"
        );
    }
}

contract ManiaScoreVerifierTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant DEVICE_KEY = 123456;
    bytes32 constant BITSTREAM = bytes32(uint256(456));
    MockSP1Verifier mock;
    ManiaScoreVerifier target;
    address signer;

    function setUp() public {
        mock = new MockSP1Verifier();
        target = new ManiaScoreVerifier(address(mock), bytes32(uint256(123)));
        signer = vm.addr(DEVICE_KEY);
        target.setDevice(signer, BITSTREAM, true);
    }

    function play() internal returns (ManiaScoreVerifier.PublicValues memory p, bytes memory signature) {
        p.sessionId = target.openSession(
            bytes32(uint256(1)), bytes32(uint256(2)), address(0xBEEF), signer, uint64(block.timestamp + 3600)
        );
        p.chartHash = bytes32(uint256(2));
        p.rulesetId = target.RULESET_ID();
        p.traceRoot = bytes32(uint256(3));
        p.eventCount = 8;
        p.durationUs = 3_000_000;
        p.score = 987500;
        p.achievedPoints = 1580;
        p.maximumPoints = 1600;
        p.judgements = [uint32(4), 1, 0, 0, 0, 0];
        p.sessionDigest = target.sessionDigest(target.getSession(p.sessionId).header, p);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(DEVICE_KEY, p.sessionDigest);
        signature = abi.encodePacked(r, s, v);
        mock.setExpected(abi.encode(p));
    }

    function testAcceptAndRejectReplay() public {
        (ManiaScoreVerifier.PublicValues memory p, bytes memory sig) = play();
        vm.prank(address(0xCAFE)); // Relayer cannot steal score ownership.
        target.submit(abi.encode(p), hex"cafe", sig);
        ManiaScoreVerifier.Session memory session = target.getSession(p.sessionId);
        require(session.consumed && session.score == 987500 && session.header.player == address(0xBEEF));
        vm.expectRevert();
        target.submit(abi.encode(p), hex"cafe", sig);
    }

    function testAcceptOneMillionAndRejectAboveMaximum() public {
        (ManiaScoreVerifier.PublicValues memory p, bytes memory sig) = play();
        p.score = 1_000_001;
        mock.setExpected(abi.encode(p));
        vm.expectRevert();
        target.submit(abi.encode(p), hex"cafe", sig);
        require(!target.getSession(p.sessionId).consumed);

        p.score = 1_000_000;
        p.achievedPoints = 1600;
        p.judgements = [uint32(5), 0, 0, 0, 0, 0];
        mock.setExpected(abi.encode(p));
        target.submit(abi.encode(p), hex"cafe", sig);
        require(target.getSession(p.sessionId).score == 1_000_000);
    }

    function testRejectScoreMutationEvenWithValidDeviceSignature() public {
        (ManiaScoreVerifier.PublicValues memory p, bytes memory sig) = play();
        p.score++;
        vm.expectRevert();
        target.submit(abi.encode(p), hex"cafe", sig);
    }

    function testRejectInvalidProofAndDoNotConsume() public {
        (ManiaScoreVerifier.PublicValues memory p, bytes memory sig) = play();
        vm.expectRevert();
        target.submit(abi.encode(p), hex"00", sig);
        require(!target.getSession(p.sessionId).consumed);
        target.submit(abi.encode(p), hex"cafe", sig);
    }

    function testRejectForgedDeviceSignature() public {
        (ManiaScoreVerifier.PublicValues memory p,) = play();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(9999, p.sessionDigest);
        vm.expectRevert();
        target.submit(abi.encode(p), hex"cafe", abi.encodePacked(r, s, v));
    }

    function testRejectWrongChartRulesetRootAndDuration() public {
        (ManiaScoreVerifier.PublicValues memory p, bytes memory sig) = play();
        bytes memory original = abi.encode(p);
        p.chartHash = bytes32(0);
        vm.expectRevert();
        target.submit(abi.encode(p), hex"cafe", sig);
        p = abi.decode(original, (ManiaScoreVerifier.PublicValues));
        p.rulesetId = bytes32(0);
        vm.expectRevert();
        target.submit(abi.encode(p), hex"cafe", sig);
        p = abi.decode(original, (ManiaScoreVerifier.PublicValues));
        p.traceRoot = bytes32(0);
        vm.expectRevert();
        target.submit(abi.encode(p), hex"cafe", sig);
        p = abi.decode(original, (ManiaScoreVerifier.PublicValues));
        p.durationUs++;
        vm.expectRevert();
        target.submit(abi.encode(p), hex"cafe", sig);
    }

    function testRejectUnknownSessionAndTrailingBytes() public {
        (ManiaScoreVerifier.PublicValues memory p, bytes memory sig) = play();
        vm.expectRevert();
        target.submit(bytes.concat(abi.encode(p), hex"00"), hex"cafe", sig);
        p.sessionId = bytes32(uint256(987));
        vm.expectRevert();
        target.submit(abi.encode(p), hex"cafe", sig);
    }

    function testRevocationAndExpiration() public {
        (ManiaScoreVerifier.PublicValues memory p, bytes memory sig) = play();
        target.setDevice(signer, BITSTREAM, false);
        vm.expectRevert();
        target.submit(abi.encode(p), hex"cafe", sig);
        target.setDevice(signer, BITSTREAM, true);
        vm.warp(block.timestamp + 3601);
        vm.expectRevert();
        target.submit(abi.encode(p), hex"cafe", sig);
    }

    function testEnrollmentAndSessionsRequireOrganizer() public {
        vm.prank(address(1));
        vm.expectRevert();
        target.setDevice(vm.addr(42), BITSTREAM, true);
        vm.prank(address(1));
        vm.expectRevert();
        target.openSession(bytes32(uint256(1)), bytes32(uint256(2)), address(1), signer, uint64(block.timestamp + 100));
    }

    function testRustAbiAndHardwareDigestGoldenVector() public view {
        string memory json = vm.readFile("../fixtures/demo.expected.json");
        bytes memory encoded = vm.parseJsonBytes(json, ".publicValues");
        ManiaScoreVerifier.PublicValues memory p = abi.decode(encoded, (ManiaScoreVerifier.PublicValues));
        require(p.score == 987500 && p.judgements[0] == 4 && p.judgements[1] == 1 && p.eventCount == 8);
        require(keccak256(encoded) == keccak256(abi.encode(p)));
        ManiaScoreVerifier.Header memory h;
        h.chainId = 31337;
        h.verifier = address(0x1111111111111111111111111111111111111111);
        h.matchId = 0x0101010101010101010101010101010101010101010101010101010101010101;
        h.sessionId = p.sessionId;
        h.challenge = 0x0303030303030303030303030303030303030303030303030303030303030303;
        h.player = address(0x2222222222222222222222222222222222222222);
        h.device = address(0x3333333333333333333333333333333333333333);
        h.chartHash = p.chartHash;
        h.rulesetId = target.RULESET_ID();
        h.bitstreamHash = 0x0404040404040404040404040404040404040404040404040404040404040404;
        h.inputPolicyHash = target.INPUT_POLICY_HASH();
        require(target.sessionDigest(h, p) == p.sessionDigest, "Rust/Solidity digest mismatch");
    }
}
