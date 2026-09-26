#!/usr/bin/env python3
"""Compare the macOS HID verifier against independent canonical BN254 vectors."""
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parent.parent
script = ROOT / 'tools/macos-vendor-hid-signing-test.py'
spec = importlib.util.spec_from_file_location('macos_signing_test', script)
mac = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mac
spec.loader.exec_module(mac)
VECTORS = ROOT / 'tests/vendor-hid/vectors'
BANK = VECTORS / 'srs-g1-be.bin'
MANIFEST = json.loads((VECTORS / 'srs-manifest.json').read_text())
CASES = json.loads((VECTORS / 'device-vectors.json').read_text())['cases']


class MacCommitmentTest(unittest.TestCase):
    def test_canonical_event_boundaries_and_tampering(self):
        info = SimpleNamespace(max_events=65, bitstream_hash='04' * 32,
                               srs_hash=MANIFEST['sha256'][2:])
        bank = mac.load_srs(BANK, info)
        self.assertEqual(len(bank), 260 * 64)
        for case in CASES:
            trace = bytes.fromhex(case['eventBytes'][2:])
            commitment = b''.join(bytes.fromhex(part[2:])
                                  for part in case['traceCommitment'])
            with self.subTest(case=case['name']):
                mac.verify_commitment(trace, commitment, bank)
                changed = bytearray(commitment)
                changed[-1] ^= 1
                with self.assertRaisesRegex(RuntimeError, 'commitment mismatch'):
                    mac.verify_commitment(trace, bytes(changed), bank)

    def test_srs_hash_provenance_and_invalid_point(self):
        info = SimpleNamespace(max_events=65, bitstream_hash='04' * 32,
                               srs_hash=MANIFEST['sha256'][2:])
        with self.assertRaisesRegex(RuntimeError, 'hash differs'):
            mac.load_srs(BANK, SimpleNamespace(max_events=65,
                         bitstream_hash=info.bitstream_hash, srs_hash='00' * 32))
        with self.assertRaisesRegex(RuntimeError, 'requires --srs-sha256'):
            mac.load_srs(BANK, SimpleNamespace(max_events=65,
                         bitstream_hash='ab' * 32, srs_hash=info.srs_hash))
        with self.assertRaisesRegex(RuntimeError, 'hash differs'):
            mac.load_srs(BANK, info, 'ff' * 32)
        corrupted_bank = bytearray(BANK.read_bytes())
        corrupted_bank[5 * 64:5 * 64 + 32] = b'\xff' * 32
        case = next(case for case in CASES if case['name'] == 'boundary-2')
        trace = bytes.fromhex(case['eventBytes'][2:])
        expected = b''.join(bytes.fromhex(part[2:]) for part in case['traceCommitment'])
        with self.assertRaisesRegex(RuntimeError, 'invalid BN254 G1 point'):
            mac.verify_commitment(trace, expected, bytes(corrupted_bank))

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
