#!/usr/bin/env python3
"""Host-only RK3566 idblock signing test; never touches OTP or a boot device."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
RKBIN = ROOT / 'sources/boot-firmware/build/rkbin/tools/rk_sign_tool'
IDBLOCK = ROOT / 'sources/boot-firmware/build/u-boot/idbloader.img'
FIRMWARE = ROOT / 'sources/boot-firmware/out-optee-dev/u-boot-rockchip.bin'


class SignedIdblockTest(unittest.TestCase):
    def test_sign_verify_and_reject_tampering(self):
        for source in (RKBIN, IDBLOCK, FIRMWARE):
            self.assertTrue(source.is_file(), f'build pinned firmware first: {source}')
        with tempfile.TemporaryDirectory(prefix='rk3566-sign-test-') as directory:
            work = Path(directory)
            image = work / 'idbloader.img'
            shutil.copyfile(IDBLOCK, image)
            with FIRMWARE.open('rb') as firmware:
                self.assertEqual(image.read_bytes(), firmware.read(image.stat().st_size),
                                 'signing an idblock unrelated to the flash image is unsafe')

            def command(*args):
                return subprocess.run([str(RKBIN), *map(str, args)], cwd=work,
                                      capture_output=True, text=True)

            for name in ('original', 'other'):
                private = work / (name + '.key')
                public = work / (name + '.pubkey')
                subprocess.run(['openssl', 'genrsa', '-out', str(private), '2048'],
                               capture_output=True, check=True)
                subprocess.run(['openssl', 'rsa', '-in', str(private), '-pubout',
                                '-out', str(public)], capture_output=True, check=True)
            self.assertEqual(command('cc', '--chip', '3566').returncode, 0)
            self.assertEqual(command('lk', '--key', work / 'original.key',
                                     '--pubkey', work / 'original.pubkey').returncode, 0)
            self.assertEqual(command('sb', '--idb', image).returncode, 0)
            self.assertEqual(command('vb', '--idb', image).returncode, 0)
            self.assertEqual(command('lk', '--key', work / 'other.key',
                                     '--pubkey', work / 'other.pubkey').returncode, 0)
            self.assertNotEqual(command('vb', '--idb', image).returncode, 0,
                                'another trust anchor must not verify the image')
            signed = bytearray(image.read_bytes())
            signed[8192] ^= 1
            image.write_bytes(signed)
            self.assertNotEqual(command('vb', '--idb', image).returncode, 0,
                                'modified loader must not verify')


if __name__ == '__main__':
    unittest.main()
