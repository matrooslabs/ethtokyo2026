#!/usr/bin/env python3
"""Validate externally approved, non-secret production inputs. Never programs OTP."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

PROJECT = Path(__file__).resolve().parent.parent
SECURE_OTP_BYTES = 896  # TF-A rk3568/drivers/otp/otp.h: 448 secure halfwords
UPSTREAM_DEV_TA_PUBKEY_SHA256 = 'cac7bcfaf8674a57e5eaa8ef1a7c9b67af1fd5562a06440d88d5e3c632e88c48'


def fail(message):
    raise SystemExit('hardware provisioning preflight: ' + message)


def outside_project(value, name):
    path = Path(value).expanduser().resolve(strict=True)
    if path == PROJECT.parent or PROJECT.parent in path.parents:
        fail(name + ' must be outside the ethtokyo2026 checkout')
    if not path.is_file():
        fail(name + ' is not a regular file')
    return path


def hex32(value, name):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-fA-F]{64}', value):
        fail(name + ' must be 32 hex-encoded bytes')
    data = bytes.fromhex(value)
    if data in (bytes(32), bytes([255]) * 32):
        fail(name + ' is unprovisioned')
    return data


def public_der(path, private=False):
    args = ['openssl', 'pkey', '-in', str(path), '-pubout', '-outform', 'DER']
    if not private:
        args.insert(2, '-pubin')
    return subprocess.run(args, check=True, capture_output=True).stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('record', help='external, separately reviewed provisioning JSON')
    parser.add_argument('output', help='generated public policy header inside build artifacts')
    args = parser.parse_args()
    record_path = outside_project(args.record, 'provisioning record')
    record = json.loads(record_path.read_text())
    if record.get('board') != 'radxa-zero-3w-rk3566':
        fail('record board is not Radxa ZERO 3W / RK3566')
    if record.get('approved_secure_otp_slot') is not True:
        fail('secure OTP slot needs independent review/approval before burning')
    offset = record.get('secure_otp_huk_byte_offset')
    if type(offset) is not int or offset < 0 or offset % 2 or offset + 16 > SECURE_OTP_BYTES:
        fail('16-byte HUK offset must fit in TF-A secure OTP, aligned to a halfword')
    serial = record.get('device_serial')
    if not record.get('otp_slot_reference') or not isinstance(serial, str) or not serial:
        fail('record must identify reviewed OTP slot reference and device serial')
    bank = Path(record['srs_bank']).expanduser().resolve(strict=True)
    if not bank.is_file():
        fail('approved BLS12-381 SRS bank is not a regular file')
    expected_bank_hash = hex32(record.get('srs_sha256'), 'srs_sha256')
    digest = hashlib.sha256()
    count = 0
    with bank.open('rb') as f:
        while chunk := f.read(65536):
            digest.update(chunk)
            count += len(chunk)
    if digest.digest() != expected_bank_hash or count != 200000 * 48:
        fail('BLS12-381 SRS bank/hash mismatch or bank is not exactly 200000 compressed G1 points')
    key = outside_project(record['ta_sign_key'], 'TA signing key')
    public = outside_project(record['ta_public_key'], 'TA public key')
    if key == public or b'PRIVATE KEY' in public.read_bytes():
        fail('TA trust anchor must be a distinct public-only key file')
    trusted_public = public_der(public)
    if public_der(key, private=True) != trusted_public:
        fail('TA signing key does not match OP-TEE trust anchor')
    if hashlib.sha256(trusted_public).hexdigest() == UPSTREAM_DEV_TA_PUBKEY_SHA256:
        fail('upstream OP-TEE development TA trust key is forbidden')
    if record.get('ta_key_reviewed') is not True:
        fail('TA trust key requires separate review')
    # This legacy bitstream_hash field is only a public, reproducible build
    # identifier while there is no FPGA bitstream artifact to attest.
    bitstream = hashlib.sha256(
        b'OSUMANIA_BUILD_MARKER_V1\0' +
        hashlib.sha256((PROJECT / 'manifests/sources.lock').read_bytes()).digest() +
        digest.digest() + hashlib.sha256(trusted_public).digest() +
        offset.to_bytes(4, 'big') + serial.encode('utf-8')
    ).digest()
    output = Path(args.output).resolve()
    if not (PROJECT / 'sources/optee-os-artifacts/hardware-policy') in output.parents:
        fail('generated header must remain in hardware-policy directory')
    output.parent.mkdir(parents=True, exist_ok=True)
    initializer = lambda data: '{' + ','.join('0x%02x' % b for b in data) + '}'
    output.write_text('/* Public build marker, NOT an FPGA bitstream attestation. */\n'
                      '#define OSUMANIA_PROVISIONED_BITSTREAM_HASH ' + initializer(bitstream) + '\n'
                      '#define OSUMANIA_PROVISIONED_SRS 1\n'
                      '#define OSUMANIA_PROVISIONED_SRS_HASH ' + initializer(digest.digest()) + '\n'
                      '#define OSUMANIA_PROVISIONED_SRS_POINTS 200000\n')
    print(json.dumps({'offset': offset, 'srs_bank': str(bank),
                      'srs_sha256': digest.hexdigest(), 'ta_sign_key': str(key),
                      'ta_public_key': str(public), 'build_marker': bitstream.hex(),
                      'header': str(output)}, sort_keys=True))


if __name__ == '__main__':
    main()
