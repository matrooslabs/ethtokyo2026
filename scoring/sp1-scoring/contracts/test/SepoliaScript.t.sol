// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ManiaScoreVerifier, ISP1Verifier} from "../src/ManiaScoreVerifier.sol";
import {
    DeploySepolia,
    RegisterDeviceSepolia,
    OpenSessionSepolia,
    ExportSessionSepolia,
    SubmitScoreSepolia
} from "../script/Sepolia.s.sol";

interface ScriptTestVm {
    function chainId(uint256) external;
    function etch(address, bytes calldata) external;
    function setEnv(string calldata, string calldata) external;
    function writeFile(string calldata, string calldata) external;
    function readFile(string calldata) external view returns (string memory);
    function createDir(string calldata, bool) external;
    function toString(address) external pure returns (string memory);
    function toString(bytes calldata) external pure returns (string memory);
    function toString(bytes32) external pure returns (string memory);
    function toString(uint256) external pure returns (string memory);
    function parseJsonBytes32(string calldata, string calldata) external pure returns (bytes32);
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function expectRevert() external;
}

/// Application/script test double ONLY. Never used by deployment scripts.
contract ScriptMockGateway is ISP1Verifier {
    bytes32 expected;

    function expectValues(bytes calldata values) external {
        expected = keccak256(values);
    }

    function verifyProof(bytes32 key, bytes calldata values, bytes calldata proof) external view {
        require(key == bytes32(uint256(123)), "bad key");
        require(expected == keccak256(values) && keccak256(proof) == keccak256(hex"01020304cafe"), "bad proof");
    }
}

contract SepoliaScriptTest {
    ScriptTestVm constant vm = ScriptTestVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant GATEWAY = 0x397A5f7f3dBd538f23DE225B51f532c34448dA9B;
    uint256 constant DEVICE_KEY = 123456;
    ManiaScoreVerifier app;

    function setUp() public {
        vm.chainId(11155111);
        vm.etch(GATEWAY, address(new ScriptMockGateway()).code);
        vm.createDir("../artifacts", true);
        vm.writeFile(
            "../artifacts/script-test-vkey.json",
            '{"vkey":"0x000000000000000000000000000000000000000000000000000000000000007b"}'
        );
        vm.setEnv("VKEY_FILE", "../artifacts/script-test-vkey.json");
        app = new DeploySepolia().run();
        vm.setEnv("MANIA_VERIFIER", vm.toString(address(app)));
        vm.setEnv("DEVICE_SIGNER", vm.toString(vm.addr(DEVICE_KEY)));
        vm.setEnv("BITSTREAM_HASH", vm.toString(bytes32(uint256(456))));
        vm.setEnv("PLAYER_ADDRESS", vm.toString(address(0xBEEF)));
        vm.setEnv("MATCH_ID", vm.toString(bytes32(uint256(1))));
        vm.setEnv("CHART_HASH", vm.toString(bytes32(uint256(2))));
        vm.setEnv("SESSION_EXPIRES_AT", vm.toString(block.timestamp + 3600));
    }

    // vm.setEnv mutates the process environment. Keep all environment-driven scenarios
    // in one test to avoid racing other test threads' PROOF_FILE/VKEY_FILE values.
    function testSepoliaWorkflowAndRejections() public {
        checkDeployRegisterOpenExportAndSubmitMaximum();
        checkRejectCoreProofFile();
        checkRejectInvalidCryptographicProofDespiteJsonFlags();
        checkRejectWrongLocalProgramKey();
        checkRejectWrongChainOrAbsentGateway();
    }

    function open() internal returns (bytes32 id) {
        new RegisterDeviceSepolia().run();
        id = new OpenSessionSepolia().run();
        vm.setEnv("SESSION_ID", vm.toString(id));
    }

    function prepareProof(string memory path, string memory mode, bytes memory proof) internal returns (bytes32 id) {
        id = open();
        ManiaScoreVerifier.PublicValues memory p;
        p.sessionId = id;
        p.chartHash = bytes32(uint256(2));
        p.rulesetId = app.RULESET_ID();
        p.traceRoot = bytes32(uint256(3));
        p.eventCount = 8;
        p.durationUs = 3_000_000;
        p.score = 1_000_000;
        p.achievedPoints = 1600;
        p.maximumPoints = 1600;
        p.judgements = [uint32(5), 0, 0, 0, 0, 0];
        p.sessionDigest = app.sessionDigest(app.getSession(id).header, p);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(DEVICE_KEY, p.sessionDigest);
        vm.writeFile(
            string.concat(path, ".sig.json"),
            string.concat('{"signature":"', vm.toString(abi.encodePacked(r, s, v)), '"}')
        );
        vm.setEnv("DEVICE_SIGNATURE_FILE", string.concat(path, ".sig.json"));
        vm.writeFile(
            path,
            string.concat(
                '{"mode":"',
                mode,
                '","proofGenerated":true,"locallyVerified":true,"vkey":"',
                vm.toString(app.programVKey()),
                '","publicValues":"',
                vm.toString(abi.encode(p)),
                '","proof":"',
                vm.toString(proof),
                '"}'
            )
        );
        vm.setEnv("PROOF_FILE", path);
        ScriptMockGateway(GATEWAY).expectValues(abi.encode(p));
    }

    function checkDeployRegisterOpenExportAndSubmitMaximum() internal {
        bytes32 id = prepareProof("../artifacts/script-test-valid.json", "groth16", hex"01020304cafe");
        require(address(app.sp1Verifier()) == GATEWAY && app.programVKey() == bytes32(uint256(123)));
        require(app.organizer() != address(0) && app.organizer() != address(this));
        vm.setEnv("SESSION_FILE", "../artifacts/script-test-session.json");
        new ExportSessionSepolia().run();
        string memory exported = vm.readFile("../artifacts/script-test-session.json");
        require(vm.parseJsonBytes32(exported, ".session_id") == id);
        require(vm.parseJsonBytes32(exported, ".challenge") == app.getSession(id).header.challenge);
        new SubmitScoreSepolia().run();
        require(app.getSession(id).consumed && app.getSession(id).score == 1_000_000);
    }

    function checkRejectCoreProofFile() internal {
        bytes32 id = prepareProof("../artifacts/script-test-core.json", "core", hex"01020304cafe");
        SubmitScoreSepolia script = new SubmitScoreSepolia();
        vm.expectRevert();
        script.run();
        require(!app.getSession(id).consumed);
    }

    function checkRejectInvalidCryptographicProofDespiteJsonFlags() internal {
        bytes32 id = prepareProof("../artifacts/script-test-bad.json", "groth16", hex"000000000000");
        SubmitScoreSepolia script = new SubmitScoreSepolia();
        vm.expectRevert();
        script.run();
        require(!app.getSession(id).consumed);
    }

    function checkRejectWrongChainOrAbsentGateway() internal {
        DeploySepolia script = new DeploySepolia();
        vm.chainId(1);
        vm.expectRevert();
        script.run();
        vm.chainId(11155111);
        vm.etch(GATEWAY, hex"");
        vm.expectRevert();
        script.run();
    }

    function checkRejectWrongLocalProgramKey() internal {
        vm.writeFile(
            "../artifacts/script-test-wrong-vkey.json",
            '{"vkey":"0x000000000000000000000000000000000000000000000000000000000000007c"}'
        );
        vm.setEnv("VKEY_FILE", "../artifacts/script-test-wrong-vkey.json");
        RegisterDeviceSepolia script = new RegisterDeviceSepolia();
        vm.expectRevert();
        script.run();
    }
}
