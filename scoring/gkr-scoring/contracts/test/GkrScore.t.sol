// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {GkrScoreVerifier} from "../src/GkrScoreVerifier.sol";
import {GkrRelation} from "../src/GkrRelation.sol";
import {ManiaGkrRegistry} from "../src/ManiaGkrRegistry.sol";

interface Vm {
    function readFile(string calldata) external view returns (string memory);
    function parseJsonUint(string calldata, string calldata) external pure returns (uint256);
    function parseJsonUintArray(string calldata, string calldata) external pure returns (uint256[] memory);
    function parseJsonBytes(string calldata, string calldata) external pure returns (bytes memory);
    function parseJsonBytes32(string calldata, string calldata) external pure returns (bytes32);
    function parseJsonStringArray(string calldata, string calldata) external pure returns (string[] memory);
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
    function expectRevert() external;
    function ffi(string[] calldata) external returns (bytes memory);
    function toString(bytes calldata) external pure returns (string memory);
    function warp(uint256) external;
}

contract GkrScoreTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    string constant DIR = "../artifacts/forge/";
    uint256 constant DEVICE_KEY = 0xD1CE;
    bytes32 constant BITSTREAM = bytes32(uint256(0xB175));

    event log_named_uint(string key, uint256 val);
    event log_named_string(string key, string val);

    GkrRelation relation;
    GkrScoreVerifier verifier;
    ManiaGkrRegistry registry;

    function setUp() public {
        string memory vkJson = vm.readFile(string.concat(DIR, "vk.json"));
        uint256 smax = vm.parseJsonUint(vkJson, ".smax");
        uint256[] memory one = vm.parseJsonUintArray(vkJson, ".g2One");
        uint256[] memory tau = vm.parseJsonUintArray(vkJson, ".g2Tau");
        uint256[] memory flat = vm.parseJsonUintArray(vkJson, ".g2Shift");
        uint256[4][] memory shift = new uint256[4][](smax + 1);
        for (uint256 i = 0; i <= smax; i++) {
            shift[i] = [flat[4 * i], flat[4 * i + 1], flat[4 * i + 2], flat[4 * i + 3]];
        }
        relation = new GkrRelation();
        verifier = new GkrScoreVerifier(relation, smax, [one[0], one[1], one[2], one[3]], [tau[0], tau[1], tau[2], tau[3]], shift);
        require(verifier.srsId() == vm.parseJsonBytes32(vkJson, ".srsId"), "srsId mismatch with Rust");
        registry = new ManiaGkrRegistry(verifier);
    }

    // ------------------------------------------------------------------ helpers

    function _case(string memory name) internal view returns (string memory) {
        return vm.readFile(string.concat(DIR, "case-", name, ".json"));
    }

    function _statement(string memory j) internal pure returns (GkrScoreVerifier.Statement memory st) {
        st.mode = uint8(vm.parseJsonUint(j, ".mode"));
        st.sessionDigest = vm.parseJsonBytes32(j, ".sessionDigest");
        st.n = uint64(vm.parseJsonUint(j, ".n"));
        st.duration = uint64(vm.parseJsonUint(j, ".duration"));
        uint256[] memory cc = vm.parseJsonUintArray(j, ".chart.commitment");
        st.chartCommitment = [cc[0], cc[1]];
        st.m = uint64(vm.parseJsonUint(j, ".chart.m"));
        st.chartBits = uint8(vm.parseJsonUint(j, ".chart.bits"));
        st.components = uint64(vm.parseJsonUint(j, ".chart.components"));
        st.maxEnd = uint64(vm.parseJsonUint(j, ".chart.maxEnd"));
        uint256[] memory tc = vm.parseJsonUintArray(j, ".traceCommitment");
        st.traceCommitment = [tc[0], tc[1]];
        uint256[] memory lb = vm.parseJsonUintArray(j, ".laneBits");
        for (uint256 i = 0; i < 4; i++) {
            st.laneBits[i] = uint8(lb[i]);
        }
        uint256[] memory ct = vm.parseJsonUintArray(j, ".counts");
        for (uint256 i = 0; i < 5; i++) {
            st.counts[i] = uint32(ct[i]);
        }
    }

    function _load(string memory name)
        internal
        view
        returns (GkrScoreVerifier.Statement memory st, uint256[] memory proof, bytes memory events, string memory j)
    {
        j = _case(name);
        st = _statement(j);
        proof = vm.parseJsonUintArray(j, ".proof");
        events = st.mode == 1 ? vm.parseJsonBytes(j, ".events") : bytes("");
    }

    function _accepts(GkrScoreVerifier.Statement memory st, uint256[] memory proof, bytes memory events)
        internal
        view
        returns (bool ok)
    {
        try verifier.verify(st, proof, events) returns (uint256[6] memory, uint256) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    // ------------------------------------------------------------------ verifier

    function testVerifyAllExportedCases() public {
        string[] memory names = vm.parseJsonStringArray(vm.readFile(string.concat(DIR, "index.json")), ".cases");
        for (uint256 i = 0; i < names.length; i++) {
            (GkrScoreVerifier.Statement memory st, uint256[] memory proof, bytes memory events, string memory j) =
                _load(names[i]);
            uint256 g0 = gasleft();
            (uint256[6] memory jd, uint256 score) = verifier.verify(st, proof, events);
            uint256 used = g0 - gasleft();
            uint256[] memory expected = vm.parseJsonUintArray(j, ".judgements");
            for (uint256 k = 0; k < 6; k++) {
                require(jd[k] == expected[k], "judgement mismatch with core::evaluate");
            }
            require(score == vm.parseJsonUint(j, ".score"), "score mismatch with core::evaluate");
            emit log_named_string("case", names[i]);
            emit log_named_uint("  verify execution gas", used);
            emit log_named_uint("  proof words", proof.length);
        }
    }

    function testTamperEveryProofSection() public view {
        (GkrScoreVerifier.Statement memory st, uint256[] memory proof, bytes memory events, string memory j) =
            _load("random0-a");
        require(_accepts(st, proof, events), "honest proof rejected");
        string[6] memory secs = ["gkr", "row", "claims", "red", "finals", "zm"];
        for (uint256 i = 0; i < secs.length; i++) {
            uint256 at = vm.parseJsonUint(j, string.concat(".sections.", secs[i]));
            for (uint256 d = 0; d < 3; d++) {
                uint256[] memory bad = _copy(proof);
                bad[at + d] = addmod(bad[at + d], 1, 21888242871839275222246405745257275088548364400416034343698204186575808495617);
                require(!_accepts(st, bad, events), string.concat("tampered section accepted: ", secs[i]));
            }
        }
        // advice commitment
        uint256[] memory b2 = _copy(proof);
        b2[0] = 1;
        b2[1] = 2;
        require(!_accepts(st, b2, events), "tampered advice commitment accepted");
        // truncated / extended
        uint256[] memory shortP = new uint256[](proof.length - 1);
        for (uint256 i = 0; i < shortP.length; i++) {
            shortP[i] = proof[i];
        }
        require(!_accepts(st, shortP, events), "truncated proof accepted");
        uint256[] memory longP = new uint256[](proof.length + 1);
        for (uint256 i = 0; i < proof.length; i++) {
            longP[i] = proof[i];
        }
        require(!_accepts(st, longP, events), "extended proof accepted");
        // non-canonical encoding of a field element (x + R)
        uint256[] memory nc = _copy(proof);
        uint256 at2 = vm.parseJsonUint(j, ".sections.row");
        nc[at2] = nc[at2] + 21888242871839275222246405745257275088548364400416034343698204186575808495617;
        require(!_accepts(st, nc, events), "non-canonical element accepted");
    }

    function testTamperStatementAndTrace() public view {
        (GkrScoreVerifier.Statement memory st, uint256[] memory proof, bytes memory events,) = _load("random0-a");
        GkrScoreVerifier.Statement memory s2 = _statementCopy(st);
        s2.counts[0] += 1;
        require(!_accepts(s2, proof, events), "inflated count accepted");
        s2 = _statementCopy(st);
        s2.sessionDigest = bytes32(uint256(st.sessionDigest) ^ 1);
        require(!_accepts(s2, proof, events), "other session accepted");
        s2 = _statementCopy(st);
        s2.duration += 1;
        require(!_accepts(s2, proof, events), "other duration accepted");
        s2 = _statementCopy(st);
        s2.laneBits[0] += 1;
        require(!_accepts(s2, proof, events), "other lane shape accepted");
        s2 = _statementCopy(st);
        s2.components += 1;
        require(!_accepts(s2, proof, events), "other chart accepted");
        bytes memory ev2 = bytes.concat(events);
        ev2[11] = bytes1(uint8(ev2[11]) ^ 1); // timestamp of event 0
        require(_accepts(st, proof, events), "honest proof rejected after copies");
        require(!_accepts(st, proof, ev2), "modified calldata trace accepted");
    }

    function testModeBBindsTraceCommitment() public view {
        (GkrScoreVerifier.Statement memory st, uint256[] memory proof,,) = _load("random0-b");
        require(_accepts(st, proof, ""), "honest mode B proof rejected");
        GkrScoreVerifier.Statement memory s2 = _statementCopy(st);
        (s2.traceCommitment[0], s2.traceCommitment[1]) = (1, 2);
        require(!_accepts(s2, proof, ""), "other trace commitment accepted");
        s2 = _statementCopy(st);
        s2.mode = 1;
        require(!_accepts(s2, proof, ""), "mode confusion accepted");
    }

    function _copy(uint256[] memory a) internal pure returns (uint256[] memory b) {
        b = new uint256[](a.length);
        for (uint256 i = 0; i < a.length; i++) {
            b[i] = a[i];
        }
    }

    function _statementCopy(GkrScoreVerifier.Statement memory st)
        internal
        pure
        returns (GkrScoreVerifier.Statement memory s2)
    {
        s2 = abi.decode(abi.encode(st), (GkrScoreVerifier.Statement));
    }

    // ------------------------------------------------------------------ chart registration

    function _registerChart(string memory j) internal returns (bytes32 h) {
        bytes memory chart = vm.parseJsonBytes(j, ".chart.bytes");
        uint256[] memory cc = vm.parseJsonUintArray(j, ".chart.commitment");
        uint256[] memory zm = vm.parseJsonUintArray(j, ".chart.proof");
        uint256 g0 = gasleft();
        h = registry.registerChart(chart, [cc[0], cc[1]], zm);
        emit log_named_uint("registerChart gas", g0 - gasleft());
        require(h == vm.parseJsonBytes32(j, ".chart.chartHash"), "chartHash differs from SP1 chart_hash");
    }

    function testChartRegistrationValidatesAndBinds() public {
        string memory j = _case("bench500-a");
        bytes32 h = _registerChart(j);
        ManiaGkrRegistry.Chart memory ch = registry.getChart(h);
        require(ch.registered && ch.m == 500 && ch.components == vm.parseJsonUint(j, ".chart.components"));
        require(ch.maxEnd == vm.parseJsonUint(j, ".chart.maxEnd"));
        vm.expectRevert();
        registry.registerChart(vm.parseJsonBytes(j, ".chart.bytes"), [ch.commitment[0], ch.commitment[1]], vm.parseJsonUintArray(j, ".chart.proof"));

        string memory k = _case("demo-a");
        bytes memory chart = vm.parseJsonBytes(k, ".chart.bytes");
        uint256[] memory cc = vm.parseJsonUintArray(k, ".chart.commitment");
        uint256[] memory zm = vm.parseJsonUintArray(k, ".chart.proof");
        // Commitment of a different chart.
        vm.expectRevert();
        registry.registerChart(chart, [ch.commitment[0], ch.commitment[1]], zm);
        // Content changed after commitment (note start +1 µs).
        bytes memory bad = bytes.concat(chart);
        bad[24 + 8] = bytes1(uint8(bad[24 + 8]) ^ 1);
        vm.expectRevert();
        registry.registerChart(bad, [cc[0], cc[1]], zm);
        // Invalid chart (swap two notes -> unsorted) is rejected by validation.
        bytes memory unsorted = bytes.concat(chart);
        for (uint256 i = 0; i < 17; i++) {
            (unsorted[24 + i], unsorted[41 + i]) = (unsorted[41 + i], unsorted[24 + i]);
        }
        vm.expectRevert();
        registry.registerChart(unsorted, [cc[0], cc[1]], zm);
        // Only the organizer.
        vm.prank(address(0xBAD));
        vm.expectRevert();
        registry.registerChart(chart, [cc[0], cc[1]], zm);
        registry.registerChart(chart, [cc[0], cc[1]], zm);
    }

    // ------------------------------------------------------------------ end-to-end with the Rust prover (FFI)

    function _proveSession(bytes32 id, string memory fixture, string memory mode) internal returns (uint256[] memory out) {
        ManiaGkrRegistry.Session memory s = registry.getSession(id);
        string[] memory cmd = new string[](10);
        cmd[0] = "../target/release/mania-gkr";
        cmd[1] = "prove-session";
        cmd[2] = "--srs";
        cmd[3] = "../artifacts/dev-srs-22.bin";
        cmd[4] = "--input";
        cmd[5] = fixture;
        cmd[6] = "--mode";
        cmd[7] = mode;
        cmd[8] = "--header";
        cmd[9] = vm.toString(abi.encode(s.header));
        out = abi.decode(vm.ffi(cmd), (uint256[]));
    }

    function _submission(uint256[] memory out) internal pure returns (ManiaGkrRegistry.Submission memory sub, uint256[] memory proof) {
        for (uint256 i = 0; i < 4; i++) {
            sub.laneBits[i] = uint8(out[i]);
        }
        for (uint256 i = 0; i < 5; i++) {
            sub.counts[i] = uint32(out[4 + i]);
        }
        sub.duration = uint64(out[13]);
        proof = new uint256[](out.length - 15);
        for (uint256 i = 0; i < proof.length; i++) {
            proof[i] = out[15 + i];
        }
    }

    function _events(string memory fixtureCase) internal view returns (bytes memory) {
        return vm.parseJsonBytes(_case(fixtureCase), ".events");
    }

    function testEndToEndModeA() public {
        bytes32 h = _registerChart(_case("demo-a"));
        address device = vm.addr(DEVICE_KEY);
        registry.setDevice(device, BITSTREAM, true);
        bytes32 id = registry.openSession(bytes32("match-1"), h, address(0xBEEF), device, uint64(block.timestamp + 3600), 1);
        uint256[] memory out = _proveSession(id, "../../fixtures/demo.json", "a");
        (ManiaGkrRegistry.Submission memory sub, uint256[] memory proof) = _submission(out);
        bytes memory events = _events("demo-a");
        bytes32 root = registry.traceRoot(id, events);
        require(root == bytes32(out[14]), "trace root differs from Rust");
        bytes32 digest = registry.sessionDigestV1(registry.getSession(id).header, uint32(events.length / 14), sub.duration, root);
        require(digest == bytes32(out[11]), "session digest differs from Rust");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(DEVICE_KEY, digest);
        bytes memory sig = abi.encodePacked(r, s, v);
        // Wrong device key is rejected and does not consume.
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(DEVICE_KEY + 1, digest);
        vm.expectRevert();
        registry.submitCalldata(id, events, sub, proof, abi.encodePacked(r2, s2, v2));
        // Relayer submits; the player from the session owns the score.
        vm.prank(address(0xCAFE));
        uint256 g0 = gasleft();
        registry.submitCalldata(id, events, sub, proof, sig);
        emit log_named_uint("submitCalldata execution gas (demo)", g0 - gasleft());
        ManiaGkrRegistry.Session memory st = registry.getSession(id);
        require(st.consumed && st.score == 987500 && st.header.player == address(0xBEEF), "score not recorded");
        require(st.judgements[0] == 4 && st.judgements[1] == 1, "judgements not recorded");
        vm.expectRevert();
        registry.submitCalldata(id, events, sub, proof, sig);
    }

    function testEndToEndModeB() public {
        bytes32 h = _registerChart(_case("perfect-b"));
        address device = vm.addr(DEVICE_KEY);
        registry.setDevice(device, BITSTREAM, true);
        bytes32 id = registry.openSession(bytes32("match-2"), h, address(0xBEEF), device, uint64(block.timestamp + 3600), 2);
        uint256[] memory out = _proveSession(id, "../../fixtures/perfect.json", "b");
        (ManiaGkrRegistry.Submission memory sub, uint256[] memory proof) = _submission(out);
        uint256[2] memory tc = [out[9], out[10]];
        uint32 n = uint32(out[12]);
        bytes32 root = bytes32(out[14]);
        bytes32 digest = registry.sessionDigestV2(registry.getSession(id).header, n, sub.duration, root, tc);
        require(digest == bytes32(out[11]), "V2 session digest differs from Rust");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(DEVICE_KEY, digest);
        bytes memory sig = abi.encodePacked(r, s, v);
        // A mode-A submission cannot be used for a mode-B session.
        vm.expectRevert();
        registry.submitCalldata(id, "", sub, proof, sig);
        uint256 g0 = gasleft();
        registry.submitCommitted(id, n, root, tc, sub, proof, sig);
        emit log_named_uint("submitCommitted execution gas (perfect)", g0 - gasleft());
        ManiaGkrRegistry.Session memory st = registry.getSession(id);
        require(st.consumed && st.score == 1_000_000, "score not recorded");
    }

    function testExpiredAndRevokedSessionsRejected() public {
        bytes32 h = _registerChart(_case("demo-a"));
        address device = vm.addr(DEVICE_KEY);
        registry.setDevice(device, BITSTREAM, true);
        bytes32 id = registry.openSession(bytes32("m"), h, address(0xBEEF), device, uint64(block.timestamp + 10), 1);
        uint256[] memory out = _proveSession(id, "../../fixtures/demo.json", "a");
        (ManiaGkrRegistry.Submission memory sub, uint256[] memory proof) = _submission(out);
        bytes memory events = _events("demo-a");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(DEVICE_KEY, bytes32(out[11]));
        bytes memory sig = abi.encodePacked(r, s, v);
        registry.setDevice(device, BITSTREAM, false);
        vm.expectRevert();
        registry.submitCalldata(id, events, sub, proof, sig);
        registry.setDevice(device, BITSTREAM, true);
        vm.warp(block.timestamp + 11);
        vm.expectRevert();
        registry.submitCalldata(id, events, sub, proof, sig);
    }

    // ------------------------------------------------------------------ transaction gas accounting

    function _intrinsic(bytes memory data) internal pure returns (uint256 g, uint256 nonzero) {
        g = 21000;
        for (uint256 i = 0; i < data.length; i++) {
            if (data[i] == 0) {
                g += 4;
            } else {
                g += 16;
                nonzero++;
            }
        }
    }

    function _gasCase(string memory name, bool modeA) internal {
        string memory j = _case(string.concat(name, modeA ? "-a" : "-b"));
        bytes32 h = _registerChart(j);
        address device = vm.addr(DEVICE_KEY);
        registry.setDevice(device, BITSTREAM, true);
        bytes32 id = registry.openSession(bytes32(bytes(name)), h, address(0xBEEF), device, uint64(block.timestamp + 3600), modeA ? 1 : 2);
        uint256[] memory out = _proveSession(id, string.concat("../artifacts/forge/play-", name, ".json"), modeA ? "a" : "b");
        (ManiaGkrRegistry.Submission memory sub, uint256[] memory proof) = _submission(out);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(DEVICE_KEY, bytes32(out[11]));
        bytes memory sig = abi.encodePacked(r, s, v);
        bytes memory data = modeA
            ? abi.encodeCall(registry.submitCalldata, (id, vm.parseJsonBytes(j, ".events"), sub, proof, sig))
            : abi.encodeCall(registry.submitCommitted, (id, uint32(out[12]), bytes32(out[14]), [out[9], out[10]], sub, proof, sig));
        uint256 g0 = gasleft();
        (bool ok,) = address(registry).call(data);
        uint256 exec = g0 - gasleft();
        require(ok && registry.getSession(id).consumed, "submission failed");
        (uint256 intrinsic, uint256 nz) = _intrinsic(data);
        emit log_named_string("gas case", string.concat(name, modeA ? " mode A (calldata trace)" : " mode B (device KZG)"));
        emit log_named_uint("  calldata bytes", data.length);
        emit log_named_uint("  calldata nonzero bytes", nz);
        emit log_named_uint("  execution gas (incl. CALL overhead)", exec);
        emit log_named_uint("  intrinsic gas (21000 + EIP-2028 calldata)", intrinsic);
        emit log_named_uint("  total transaction gas", exec + intrinsic);
    }

    function testGasAccountingBench() public {
        _gasCase("bench500", true);
        _gasCase("bench3000", true);
    }

    function testGasAccountingBenchB() public {
        _gasCase("bench500", false);
        _gasCase("bench3000", false);
    }
}
