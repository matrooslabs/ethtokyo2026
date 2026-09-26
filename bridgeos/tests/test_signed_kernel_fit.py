#!/usr/bin/env python3
"""Offline signed-kernel FIT regression; never touches board, fuses or OTP."""
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
IMAGES = ROOT / 'output-optee-runtime/images'
TOOLS = ROOT / 'sources/boot-firmware/build/u-boot/tools'


class SignedKernelFitTest(unittest.TestCase):
    def test_signature_and_payload_tampering(self):
        for image in ('Image', 'rk3566-radxa-zero-3w-rt.dtb', 'rootfs.cpio.gz'):
            self.assertTrue((IMAGES / image).is_file(), 'build optee-runtime first: ' + image)
        with tempfile.TemporaryDirectory(prefix='signed-kernel-fit-') as temp:
            path = Path(temp)
            keys = path / 'keys'
            keys.mkdir()

            def key_pair(directory):
                directory.mkdir(exist_ok=True)
                subprocess.run(['openssl', 'genpkey', '-algorithm', 'RSA',
                                '-pkeyopt', 'rsa_keygen_bits:2048',
                                '-out', str(directory / 'boot.key')], check=True, capture_output=True)
                subprocess.run(['openssl', 'req', '-batch', '-new', '-x509',
                                '-key', str(directory / 'boot.key'),
                                '-out', str(directory / 'boot.crt'),
                                '-subj', '/CN=lab-test-only'], check=True, capture_output=True)
                trusted = directory / 'trusted.dtb'
                dts = directory / 'trusted.dts'
                dts.write_text('/dts-v1/; / { model = "test trust root"; };\n')
                subprocess.run(['dtc', '-I', 'dts', '-O', 'dtb', '-o', str(trusted), str(dts)],
                               check=True, capture_output=True)
                subprocess.run([str(TOOLS / 'fdt_add_pubkey'), '-a', 'sha256,rsa2048',
                                '-k', str(directory), '-n', 'boot', '-r', 'conf', str(trusted)],
                               check=True, capture_output=True)
                return trusted

            trusted = key_pair(keys)
            other = key_pair(path / 'other')
            signed = path / 'kernel.itb'
            subprocess.run([str(ROOT / 'scripts/build-signed-kernel-fit.sh'),
                            str(IMAGES / 'Image'), str(IMAGES / 'rk3566-radxa-zero-3w-rt.dtb'),
                            str(IMAGES / 'rootfs.cpio.gz'), str(keys), str(trusted), str(signed),
                            'signed-lab'], check=True, capture_output=True)
            verify = [str(TOOLS / 'fit_check_sign'), '-f', str(signed),
                      '-k', str(trusted), '-c', 'conf-1']
            self.assertEqual(subprocess.run(verify, capture_output=True).returncode, 0)
            verify[verify.index(str(trusted))] = str(other)
            self.assertNotEqual(subprocess.run(verify, capture_output=True).returncode, 0)
            corrupted = path / 'corrupted.itb'
            data = bytearray(signed.read_bytes())
            data[-2048] ^= 1  # Payload within the hashed initramfs in the current FIT layout.
            corrupted.write_bytes(data)
            verify[verify.index(str(other))] = str(trusted)
            verify[verify.index(str(signed))] = str(corrupted)
            self.assertNotEqual(subprocess.run(verify, capture_output=True).returncode, 0)


if __name__ == '__main__':
    unittest.main()
