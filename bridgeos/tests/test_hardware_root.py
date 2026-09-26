#!/usr/bin/env python3
"""Boundary checks using synthetic external inputs; NEVER an OTP programming test."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

PROJECT = Path(__file__).resolve().parent.parent
PREPARE = PROJECT / 'scripts/prepare-hardware-root.py'


class HardwarePreflight(unittest.TestCase):
    def test_missing_record_fails_before_build(self):
        run = subprocess.run(['bash', str(PROJECT / 'scripts/build.sh'), 'hardware-root'],
                             env={'PATH': '/usr/bin:/bin'}, text=True, capture_output=True)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn('OSUMANIA_PROVISIONING_RECORD', run.stderr)
    def test_direct_hardware_firmware_builder_refuses(self):
        run = subprocess.run(['bash', str(PROJECT / 'scripts/build-optee.sh'), 'hardware'],
                             text=True, capture_output=True)
        self.assertNotEqual(run.returncode, 0)
        self.assertIn('REFUSED: RK3566 raw OTP HUK', run.stderr)


    def test_reviewed_inputs_and_rejection_boundaries(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            bank = directory / 'bank.bin'
            # Synthetic repeating bytes exercise size/hash handling, NOT SRS approval.
            bank.write_bytes(bytes(range(64)) * 200000)
            key = directory / 'ta.pem'
            pub = directory / 'ta.pub'
            subprocess.run(['openssl', 'genpkey', '-algorithm', 'RSA', '-pkeyopt',
                            'rsa_keygen_bits:2048', '-out', str(key)], check=True, capture_output=True)
            subprocess.run(['openssl', 'pkey', '-in', str(key), '-pubout', '-out', str(pub)],
                           check=True, capture_output=True)
            record = {'board': 'radxa-zero-3w-rk3566', 'device_serial': 'synthetic-test',
                      'otp_slot_reference': 'synthetic-test-only',
                      'approved_secure_otp_slot': True, 'secure_otp_huk_byte_offset': 880,
                      'srs_bank': str(bank), 'srs_sha256': hashlib.sha256(bank.read_bytes()).hexdigest(),
                      'bitstream_hash': 'ab' * 32, 'ta_sign_key': str(key),
                      'ta_public_key': str(pub), 'ta_key_reviewed': True}
            record_file = directory / 'record.json'
            header = PROJECT / 'sources/optee-os-artifacts/hardware-policy/test-policy.h'

            def check(changes, success):
                record_file.write_text(json.dumps({**record, **changes}))
                run = subprocess.run(['python3', str(PREPARE), str(record_file), str(header)],
                                     text=True, capture_output=True)
                self.assertEqual(run.returncode == 0, success, run.stderr)

            try:
                check({}, True)
                self.assertIn('#define OSUMANIA_PROVISIONED_SRS 1', header.read_text())
                run = subprocess.run(['bash', str(PROJECT / 'scripts/build.sh'), 'hardware-root'],
                                     env={**os.environ, 'OSUMANIA_PROVISIONING_RECORD': str(record_file)},
                                     text=True, capture_output=True)
                self.assertNotEqual(run.returncode, 0)
                self.assertIn('REFUSED hardware-root image', run.stderr)
                check({'secure_otp_huk_byte_offset': 881}, False)
                check({'secure_otp_huk_byte_offset': 882}, False)
                check({'approved_secure_otp_slot': False}, False)
                check({'srs_sha256': 'cd' * 32}, False)
                check({'bitstream_hash': '00' * 32}, False)
                check({'bitstream_hash': '04' * 32}, False)
                check({'ta_public_key': str(key)}, False)
            finally:
                header.unlink(missing_ok=True)


if __name__ == '__main__':
    unittest.main()
