// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ManiaScoreVerifier} from "../src/ManiaScoreVerifier.sol";

interface ScriptVm {
    function envAddress(string calldata) external view returns (address);
    function envBytes32(string calldata) external view returns (bytes32);
    function envUint(string calldata) external view returns (uint256);
    function envString(string calldata) external view returns (string memory);
    function readFile(string calldata) external view returns (string memory);
    function parseJsonBytes32(string calldata, string calldata) external pure returns (bytes32);
    function parseJsonBytes(string calldata, string calldata) external pure returns (bytes memory);
    function parseJsonString(string calldata, string calldata) external pure returns (string memory);
    function parseJsonBool(string calldata, string calldata) external pure returns (bool);
    function startBroadcast() external;
    function stopBroadcast() external;
    function serializeUint(string calldata, string calldata, uint256) external returns (string memory);
    function serializeAddress(string calldata, string calldata, address) external returns (string memory);
    function serializeBytes32(string calldata, string calldata, bytes32) external returns (string memory);
    function serializeBool(string calldata, string calldata, bool) external returns (string memory);
    function writeJson(string calldata, string calldata) external;
}

abstract contract SepoliaConfig {
    ScriptVm internal constant vm = ScriptVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    // Canonical Groth16 gateway, verified against Succinct's contract-addresses documentation.
    address public constant GATEWAY = 0x397A5f7f3dBd538f23DE225B51f532c34448dA9B;

    function checkChain() internal view {
        require(block.chainid == 11155111, "Sepolia only (chain 11155111)");
        require(GATEWAY.code.length != 0, "SP1 gateway has no code");
    }

    function programKey() internal view returns (bytes32 key) {
        key = vm.parseJsonBytes32(vm.readFile(vm.envString("VKEY_FILE")), ".vkey");
        require(key != bytes32(0), "zero program key");
    }

    function target() internal view returns (ManiaScoreVerifier app) {
        checkChain();
        address deployed = vm.envAddress("MANIA_VERIFIER");
        require(deployed.code.length != 0, "application has no code");
        app = ManiaScoreVerifier(deployed);
        require(address(app.sp1Verifier()) == GATEWAY, "unexpected SP1 gateway");
        require(app.programVKey() == programKey(), "deployed guest key differs from local guest");
    }
}

/// forge script script/Sepolia.s.sol:DeploySepolia --rpc-url sepolia --account ... --sender ... [--broadcast]
contract DeploySepolia is SepoliaConfig {
    function run() external returns (ManiaScoreVerifier deployed) {
        checkChain();
        bytes32 key = programKey();
        // Foundry's selected keystore/hardware wallet signs; this script never reads a private key.
        vm.startBroadcast();
        deployed = new ManiaScoreVerifier(GATEWAY, key);
        vm.stopBroadcast();
    }
}

contract RegisterDeviceSepolia is SepoliaConfig {
    function run() external {
        ManiaScoreVerifier app = target();
        address device = vm.envAddress("DEVICE_SIGNER");
        bytes32 bitstream = vm.envBytes32("BITSTREAM_HASH");
        vm.startBroadcast();
        app.setDevice(device, bitstream, true);
        vm.stopBroadcast();
    }
}

contract OpenSessionSepolia is SepoliaConfig {
    function run() external returns (bytes32 sessionId) {
        ManiaScoreVerifier app = target();
        bytes32 matchId = vm.envBytes32("MATCH_ID");
        bytes32 chartHash = vm.envBytes32("CHART_HASH");
        address player = vm.envAddress("PLAYER_ADDRESS");
        address device = vm.envAddress("DEVICE_SIGNER");
        uint256 deadline = vm.envUint("SESSION_EXPIRES_AT");
        require(deadline <= type(uint64).max && deadline > block.timestamp, "invalid deadline");
        vm.startBroadcast();
        sessionId = app.openSession(matchId, chartHash, player, device, uint64(deadline));
        vm.stopBroadcast();
        // The challenge depends on the mined block. NEVER export the simulated header here.
        // Read SESSION_ID from the confirmed SessionOpened event, then use ExportSessionSepolia.
    }
}

/// Read-only RPC script; run AFTER the session transaction is confirmed. No --broadcast needed.
contract ExportSessionSepolia is SepoliaConfig {
    function run() external returns (ManiaScoreVerifier.Session memory s) {
        ManiaScoreVerifier app = target();
        s = app.getSession(vm.envBytes32("SESSION_ID"));
        require(s.header.player != address(0), "session does not exist on this chain");
        require(!s.consumed && s.expiresAt >= block.timestamp, "session consumed or expired");
        ManiaScoreVerifier.Header memory h = s.header;
        string memory object = "confirmed-session";
        vm.serializeUint(object, "chain_id", h.chainId);
        vm.serializeAddress(object, "verifier", h.verifier);
        vm.serializeBytes32(object, "match_id", h.matchId);
        vm.serializeBytes32(object, "session_id", h.sessionId);
        vm.serializeBytes32(object, "challenge", h.challenge);
        vm.serializeAddress(object, "player", h.player);
        vm.serializeAddress(object, "device", h.device);
        vm.serializeBytes32(object, "chart_hash", h.chartHash);
        vm.serializeBytes32(object, "ruleset_id", h.rulesetId);
        vm.serializeBytes32(object, "bitstream_hash", h.bitstreamHash);
        vm.serializeBytes32(object, "input_policy_hash", h.inputPolicyHash);
        vm.serializeUint(object, "expires_at", s.expiresAt);
        vm.serializeBool(object, "consumed", s.consumed);
        string memory json = vm.serializeUint(object, "read_at_block", block.number);
        vm.writeJson(json, vm.envString("SESSION_FILE"));
    }
}

contract SubmitScoreSepolia is SepoliaConfig {
    function run() external {
        ManiaScoreVerifier app = target();
        string memory fixture = vm.readFile(vm.envString("PROOF_FILE"));
        require(
            keccak256(bytes(vm.parseJsonString(fixture, ".mode"))) == keccak256("groth16"),
            "EVM requires a Groth16 proof, not core"
        );
        require(
            vm.parseJsonBool(fixture, ".proofGenerated") && vm.parseJsonBool(fixture, ".locallyVerified"),
            "proof generation or local verification incomplete"
        );
        require(vm.parseJsonBytes32(fixture, ".vkey") == app.programVKey(), "proof program key mismatch");
        bytes memory publicValues = vm.parseJsonBytes(fixture, ".publicValues");
        bytes memory proof = vm.parseJsonBytes(fixture, ".proof");
        require(publicValues.length == 512 && proof.length > 4, "invalid EVM proof artifact");
        bytes memory signature = vm.parseJsonBytes(vm.readFile(vm.envString("DEVICE_SIGNATURE_FILE")), ".signature");
        require(signature.length == 65, "device signature must be 65 bytes");
        // eth_call-equivalent simulation verifies the real gateway route/proof AND device signature.
        // JSON flags are only preflight hints; the contract's cryptographic checks remain authoritative.
        vm.startBroadcast();
        app.submit(publicValues, proof, signature);
        vm.stopBroadcast();
    }
}
