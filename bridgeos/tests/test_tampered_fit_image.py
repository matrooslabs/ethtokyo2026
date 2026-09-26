#!/usr/bin/env python3
"""Ensure the test-only image changes signed payload, not firmware or partition metadata."""
from pathlib import Path
import subprocess
import tempfile
import unittest

PROJECT = Path(__file__).resolve().parent.parent
SOURCE = PROJECT / 'output-signed-lab/images/radxa-zero3-rt.img'
GENERATOR = PROJECT / 'scripts/make-tampered-fit-image.py'
BOOT_BEGIN = 16 * 1024 * 1024
BOOT_END = 112 * 1024 * 1024


class TamperedFitImageTest(unittest.TestCase):
    def test_single_data_byte_and_no_overwrite(self):
        with tempfile.TemporaryDirectory(prefix='zero3-image-tamper-') as temp:
            changed = Path(temp) / 'TEST-ONLY-invalid-signature.img'
            command = ['python3', str(GENERATOR), '--image', str(SOURCE),
                       '--out', str(changed)]
            first = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertIn('TEST ONLY:', first.stdout)
            differences = []
            position = 0
            with SOURCE.open('rb') as original, changed.open('rb') as altered:
                while block := original.read(1024 * 1024):
                    other = altered.read(len(block))
                    self.assertEqual(len(other), len(block))
                    differences.extend(position + i for i, (left, right)
                                       in enumerate(zip(block, other)) if left != right)
                    position += len(block)
                self.assertEqual(altered.read(1), b'')
            self.assertEqual(len(differences), 1)
            self.assertTrue(BOOT_BEGIN <= differences[0] < BOOT_END,
                            'firmware, GPT and diagnostic partition must remain untouched')
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0,
                                'never overwrite an existing test image')
            self.assertNotEqual(subprocess.run(['python3', str(GENERATOR),
                                                '--image', str(SOURCE), '--out', str(SOURCE)],
                                               capture_output=True).returncode, 0)


if __name__ == '__main__':
    unittest.main()
