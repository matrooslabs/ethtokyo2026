#!/usr/bin/env python3
"""Install the pinned PSE G1 bank into an explicitly insecure-key lab rootfs."""
import hashlib
import json
from pathlib import Path
import shutil
import sys

PROJECT = Path(__file__).resolve().parent.parent


def fail(message):
    raise SystemExit('50k-event SRS install refused: ' + message)


def main():
    if len(sys.argv) != 3:
        fail('usage: install-capacity-srs.py EXTERNAL_BANK TARGET_SHARE_DIR')
    bank = Path(sys.argv[1]).expanduser().resolve(strict=True)
    target = Path(sys.argv[2]).resolve()
    if PROJECT.parent == bank or PROJECT.parent in bank.parents or not bank.is_file():
        fail('ceremony bank must be a regular file outside the project checkout')
    source = json.loads((PROJECT / 'manifests/sources.lock').read_text())['device_srs_ceremony']
    if bank.stat().st_size != source['device_point_count'] * 64:
        fail('bank must contain exactly 200,000 canonical G1 points')
    digest = hashlib.sha256()
    with bank.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    if digest.hexdigest() != source['device_bank_sha256']:
        fail('bank differs from verified PSE power-22 derivation')
    target.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(bank, target / 'srs-g1-be.bin')
    (target / 'srs-manifest.json').write_text(json.dumps({
        'curve': 'BN254', 'format': 'G1_AFFINE_BE_XY_V1',
        'file': 'srs-g1-be.bin', 'firstExponent': 0,
        'pointCount': source['device_point_count'], 'maxEvents': 50000,
        'sha256': digest.hexdigest(), 'srsId': '0x' + source['srs_id'],
        'source': source['url'], 'sourceSha256': source['source_sha256'],
        'hardwareKey': False, 'production': False,
        'signingRoot': 'INSECURE public development key in optee-capacity-lab; never register on chain',
    }, sort_keys=True, indent=2) + '\n')


if __name__ == '__main__':
    main()
