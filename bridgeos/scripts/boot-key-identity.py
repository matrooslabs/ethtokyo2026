#!/usr/bin/env python3
"""Compare signed SPL/U-Boot verification keys. This does NOT calculate an RK3566 OTP fuse payload."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def property_words(dtb, name):
    result = subprocess.run(['fdtget', '-t', 'x', str(dtb), '/signature/key-boot', name],
                            check=True, capture_output=True, text=True)
    return [int(word, 16) for word in result.stdout.split()]


def trust_key(dtb):
    required = subprocess.run(['fdtget', '-t', 's', str(dtb), '/signature/key-boot', 'required'],
                              check=True, capture_output=True, text=True).stdout.strip()
    bits = property_words(dtb, 'rsa,num-bits')
    exponent = property_words(dtb, 'rsa,exponent')
    words = property_words(dtb, 'rsa,modulus')
    if required != 'conf' or bits != [2048] or exponent != [0, 65537] or len(words) != 64:
        raise ValueError(f'no required RSA-2048 signed-configuration key in {dtb}')
    return b''.join(word.to_bytes(4, 'big') for word in words)


def main():
    if len(sys.argv) != 4:
        raise SystemExit('Usage: boot-key-identity.py SPL-key.dtb U-Boot-key.dtb output.json')
    spl, proper, destination = map(Path, sys.argv[1:])
    a, b = trust_key(spl), trust_key(proper)
    if a != b:
        raise SystemExit('SPL and U-Boot verification public keys do not match')
    data = {
        'algorithm': 'sha256,rsa2048',
        'required': 'conf',
        'public_modulus_sha256': hashlib.sha256(a).hexdigest(),
        'meaning': 'Public verification-key fingerprint only; NOT an RK3566 ROM/OTP fuse payload',
        'rom_fuse_enforcement_verified': False,
    }
    destination.write_text(json.dumps(data, sort_keys=True, indent=2) + '\n')
    print('SPL/U-Boot public-key fingerprint:', data['public_modulus_sha256'])


if __name__ == '__main__':
    try:
        main()
    except (subprocess.CalledProcessError, ValueError) as error:
        raise SystemExit(f'Boot key identity check failed: {error}') from error
