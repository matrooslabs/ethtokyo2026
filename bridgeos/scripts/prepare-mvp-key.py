#!/usr/bin/env python3
"""Generate one-build TA key header and public identity; never print the private scalar."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

PROJECT = Path(__file__).resolve().parent.parent
SECP256K1_ORDER = int('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', 16)


def refuse(reason):
    raise SystemExit('MVP key preparation refused: ' + reason)


def external_file(name):
    path = Path(name).expanduser().resolve(strict=True)
    if not path.is_file() or path == PROJECT.parent or PROJECT.parent in path.parents:
        refuse('private key and trust inputs must remain outside the ethtokyo2026 checkout')
    return path


def openssl(args):
    result = subprocess.run(['openssl', *args], capture_output=True)
    if result.returncode:
        refuse('OpenSSL key validation failed; private output suppressed')
    return result.stdout


def read_scalar(path):
    text = openssl(['pkey', '-in', str(path), '-text', '-noout']).decode('ascii')
    if 'ASN1 OID: secp256k1' not in text or '\npriv:\n' not in text or '\npub:\n' not in text:
        refuse('device key must be a secp256k1 private PEM')
    private = text.split('\npriv:\n', 1)[1].split('\npub:\n', 1)[0]
    scalar = bytes.fromhex(''.join(re.findall(r'[0-9a-fA-F]{2}', private)))
    if len(scalar) == 33 and scalar[0] == 0:
        scalar = scalar[1:]
    if len(scalar) != 32 or not 0 < int.from_bytes(scalar, 'big') < SECP256K1_ORDER:
        refuse('invalid secp256k1 private scalar')
    public = openssl(['pkey', '-in', str(path), '-pubout', '-outform', 'DER'])
    if len(public) < 65 or public[-65] != 4:
        refuse('device public key must be uncompressed secp256k1')
    spec = importlib.util.spec_from_file_location('srs_converter', PROJECT / 'tools/convert-ppot-srs.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if module.keccak256(b'').hex() != 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470':
        refuse('Keccak-256 implementation failed known-answer test')
    return scalar, module.keccak256(public[-64:])[-20:]


def main():
    if len(sys.argv) != 8:
        refuse('usage: prepare-mvp-key.py DEVICE_PEM SRS_BANK TA_PUB BOOT_PUB PUBLIC_H PRIVATE_H IDENTITY_JSON')
    device, ta_pub, boot_pub = map(external_file, (sys.argv[1], sys.argv[3], sys.argv[4]))
    bank = Path(sys.argv[2]).expanduser().resolve(strict=True)
    if not bank.is_file():
        refuse('device SRS bank must be a file')
    public_header, private_header, identity = map(lambda x: Path(x).resolve(), sys.argv[5:8])
    policy_dir = PROJECT / 'sources/optee-os-artifacts/mvp-policy'
    if public_header.parent != policy_dir or identity.parent != policy_dir:
        refuse('public policy and identity must be mvp-policy artifacts')
    if private_header == public_header or private_header.exists() or private_header.parent == PROJECT.parent or PROJECT.parent in private_header.parents:
        refuse('private header must be a new file outside the checkout')
    srs_id = os.environ.get('OSUMANIA_MVP_SRS_ID', '').removeprefix('0x').lower()
    if len(srs_id) != 64 or any(c not in '0123456789abcdef' for c in srs_id):
        refuse('OSUMANIA_MVP_SRS_ID must identify the scoring SRS')
    if bank.stat().st_size != 200000 * 48:
        refuse('Mode B device bank must contain exactly 200,000 compressed BLS12-381 G1 points')
    digest = hashlib.sha256()
    with bank.open('rb') as source:
        while chunk := source.read(1 << 20):
            digest.update(chunk)
    scalar, address = read_scalar(device)
    ta_der = openssl(['pkey', '-pubin', '-in', str(ta_pub), '-outform', 'DER'])
    boot_der = openssl(['pkey', '-pubin', '-in', str(boot_pub), '-outform', 'DER'])
    marker = hashlib.sha256(
        b'OSUMANIA_MVP_BUILD_ID_V1\0' +
        hashlib.sha256((PROJECT / 'manifests/sources.lock').read_bytes()).digest() +
        digest.digest() + hashlib.sha256(ta_der).digest() + hashlib.sha256(boot_der).digest() + address
    ).digest()
    public_header.parent.mkdir(parents=True, exist_ok=True)
    initializer = lambda value: '{' + ','.join(f'0x{byte:02x}' for byte in value) + '}'
    private_fd = os.open(private_header, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(private_fd, 'w') as target:
            target.write('#define OSUMANIA_MVP_PRIVATE_KEY_BYTES ' + initializer(scalar) + '\n')
        public_header.write_text('/* MVP public release marker, NOT an FPGA bitstream attestation. */\n'
                                 '#define OSUMANIA_PROVISIONED_BITSTREAM_HASH ' + initializer(marker) + '\n'
                                 '#define OSUMANIA_PROVISIONED_SRS 1\n'
                                 '#define OSUMANIA_PROVISIONED_SRS_HASH ' + initializer(digest.digest()) + '\n'
                                 '#define OSUMANIA_PROVISIONED_SRS_POINTS 200000\n')
        identity.write_text(json.dumps({
            'device_address': '0x' + address.hex(), 'build_marker': '0x' + marker.hex(),
            'srs_sha256': digest.hexdigest(), 'srs_id': '0x' + srs_id,
            'boot_public_der_sha256': hashlib.sha256(boot_der).hexdigest(),
            'ta_public_der_sha256': hashlib.sha256(ta_der).hexdigest(),
            'key_security': 'EXTRACTABLE_FROM_SD_IMAGE', 'hardware_root': False,
            'bitstream_attestation': False,
        }, sort_keys=True, indent=2) + '\n')
    except BaseException:
        private_header.unlink(missing_ok=True)
        raise
    print(json.dumps({'device_address': '0x' + address.hex(),
                      'build_marker': '0x' + marker.hex(),
                      'srs_sha256': digest.hexdigest(),
                      'warning': 'Private key is extractable from the flash image; no hardware root.'}, sort_keys=True))


if __name__ == '__main__':
    main()
