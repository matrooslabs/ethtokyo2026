#!/usr/bin/env python3
"""Signed-boot public-key consistency, not a ROM fuse programming test."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
SPL = ROOT / 'sources/boot-firmware/out-optee-signed-lab/u-boot-spl-pubkey.dtb'
UBOOT = ROOT / 'sources/boot-firmware/out-optee-signed-lab/u-boot.dtb'
SCRIPT = ROOT / 'scripts/boot-key-identity.py'


class KeyIdentityTest(unittest.TestCase):
    def test_same_key_and_changed_policy_or_modulus(self):
        with tempfile.TemporaryDirectory(prefix='zero3-key-check-') as directory:
            work = Path(directory)
            dest = work / 'identity.json'
            base = [str(SCRIPT), str(SPL), str(UBOOT), str(dest)]
            subprocess.run(base, check=True, capture_output=True)
            record = json.loads(dest.read_text())
            self.assertEqual(record['required'], 'conf')
            self.assertEqual(len(record['public_modulus_sha256']), 64)
            self.assertFalse(record['rom_fuse_enforcement_verified'])
            changed = work / 'changed.dtb'
            shutil.copyfile(UBOOT, changed)
            subprocess.run(['fdtput', '-t', 's', str(changed), '/signature/key-boot',
                            'required', 'image'], check=True)
            self.assertNotEqual(subprocess.run([str(SCRIPT), str(SPL), str(changed),
                                                str(dest)], capture_output=True).returncode, 0)
            shutil.copyfile(UBOOT, changed)
            words = subprocess.check_output(['fdtget', '-t', 'x', str(changed),
                                             '/signature/key-boot', 'rsa,modulus'], text=True).split()
            words[0] = format(int(words[0], 16) ^ 1, 'x')
            subprocess.run(['fdtput', '-t', 'x', str(changed), '/signature/key-boot',
                            'rsa,modulus', *words], check=True)
            self.assertNotEqual(subprocess.run([str(SCRIPT), str(SPL), str(changed),
                                                str(dest)], capture_output=True).returncode, 0)


if __name__ == '__main__':
    unittest.main()
