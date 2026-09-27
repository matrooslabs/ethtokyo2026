#!/usr/bin/env python3
"""Compare the macOS HID verifier against an independent BLS12-381 trace oracle."""
import importlib.util
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parent.parent
script = ROOT / 'tools/macos-vendor-hid-signing-test.py'
spec = importlib.util.spec_from_file_location('macos_signing_test', script)
mac = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mac
spec.loader.exec_module(mac)
sys.path.insert(0, str(ROOT / 'tests/vendor-hid'))
import check_vectors as bls
VECTORS = ROOT / 'tests/vendor-hid/vectors'
BANK = VECTORS / 'srs-g1-bls12381.bin'
BANK_HASH = hashlib.sha256(BANK.read_bytes()).hexdigest()
CASES = json.loads((VECTORS / 'device-vectors.json').read_text())['cases']


class MacCommitmentTest(unittest.TestCase):
    def test_canonical_event_boundaries_and_tampering(self):
        info = SimpleNamespace(max_events=65, bitstream_hash='04' * 32,
                               srs_hash=BANK_HASH)
        bank = mac.load_srs(BANK, info, BANK_HASH)
        self.assertEqual(len(bank), 260 * 48)
        for case in CASES:
            trace = bytes.fromhex(case['eventBytes'][2:])
            commitment = bls.commitment(bank, case['events'])
            with self.subTest(case=case['name']):
                self.assertEqual(mac.trace_root(bytes(case['headerV2']['session_id']), trace),
                                 bytes.fromhex(case['traceRoot'][2:]))
                mac.verify_commitment(trace, commitment, bank)
                changed = bytearray(commitment)
                changed[-1] ^= 1
                with self.assertRaisesRegex(RuntimeError, 'commitment mismatch'):
                    mac.verify_commitment(trace, bytes(changed), bank)

    def test_srs_hash_provenance_and_invalid_point(self):
        info = SimpleNamespace(max_events=65, bitstream_hash='04' * 32,
                               srs_hash=BANK_HASH)
        with self.assertRaisesRegex(RuntimeError, 'hash differs'):
            mac.load_srs(BANK, SimpleNamespace(max_events=65,
                         bitstream_hash=info.bitstream_hash, srs_hash='00' * 32), BANK_HASH)
        with self.assertRaisesRegex(RuntimeError, 'requires --srs-sha256'):
            mac.load_srs(BANK, SimpleNamespace(max_events=65,
                         bitstream_hash='ab' * 32, srs_hash=info.srs_hash))
        with self.assertRaisesRegex(RuntimeError, 'hash differs'):
            mac.load_srs(BANK, info, 'ff' * 32)
        corrupted_bank = bytearray(BANK.read_bytes())
        corrupted_bank[5 * 48:6 * 48] = b'\xff' * 48
        case = next(case for case in CASES if case['name'] == 'boundary-2')
        trace = bytes.fromhex(case['eventBytes'][2:])
        expected = bls.commitment(BANK.read_bytes(), case['events'])
        with self.assertRaisesRegex(RuntimeError, 'invalid BLS12-381 G1 point'):
            mac.verify_commitment(trace, expected, bytes(corrupted_bank))

    def test_failed_signed_root_preserves_original_capture(self):
        case = next(case for case in CASES if case['name'] == 'boundary-1')
        trace = bytes.fromhex(case['eventBytes'][2:])
        header = bytes.fromhex(case['headerPackedV2'][2:])
        result = header + (1).to_bytes(4, 'big') + (1000).to_bytes(8, 'big') + bytes(32) + b'\xc0' + bytes(47 + 65)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'failed-capture.json'
            mac.save_capture(output, header, result, trace)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            saved = json.loads(output.read_text())
            self.assertEqual(bytes.fromhex(saved['headerHex']), header)
            self.assertEqual(bytes.fromhex(saved['resultHex']), result)
            self.assertEqual(bytes.fromhex(saved['traceHex']), trace)
            with self.assertRaises(FileExistsError):
                mac.save_capture(output, header, result, trace)
            info = SimpleNamespace(device_address='0x' + '00' * 20)
            expected_root = mac.trace_root(header[60:92], trace).hex()
            with self.assertRaisesRegex(RuntimeError, f'signed trace root {"00" * 32} does not match GET_TRACE root {expected_root}'):
                mac.verify_result(info, header, header[60:92], result, trace, 1)

    def test_secp256k1_arithmetic_unchanged(self):
        double_g = (
            int('c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5', 16),
            int('1ae168fea63dc339a3c58419466ceaeef7f632653266d0e1236431a950cfe52a', 16),
        )
        self.assertEqual(mac.point_add(mac.SECP256K1_G, mac.SECP256K1_G), double_g)
        self.assertEqual(mac.scalar_mul(2, mac.SECP256K1_G), double_g)



    def test_mvp_public_identity_rejects_wrong_device_and_release(self):
        expected = {'device_address': '0x' + '12' * 20,
                    'build_marker': '0x' + 'ab' * 32,
                    'srs_sha256': 'cd' * 32}
        info = SimpleNamespace(device_address=expected['device_address'],
                               bitstream_hash='ab' * 32, srs_hash='cd' * 32,
                               max_events=50000)
        with self.assertRaises(RuntimeError):
            mac.verify_expected_identity(SimpleNamespace(**{**vars(info), 'device_address': '0x' + '34' * 20}), expected)
        with self.assertRaises(RuntimeError):
            mac.verify_expected_identity(SimpleNamespace(**{**vars(info), 'bitstream_hash': 'ef' * 32}), expected)
        with self.assertRaises(RuntimeError):
            mac.verify_expected_identity(SimpleNamespace(**{**vars(info), 'srs_hash': 'ff' * 32}), expected)
        with self.assertRaises(RuntimeError):
            mac.verify_expected_identity(SimpleNamespace(**{**vars(info), 'max_events': 50001}), expected)

if __name__ == '__main__':
    unittest.main()
