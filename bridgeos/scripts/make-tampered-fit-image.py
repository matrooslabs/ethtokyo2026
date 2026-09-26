#!/usr/bin/env python3
"""Make one deliberately invalid signed-lab SD image. Never writes a device or OTP."""
import argparse
import hashlib
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile

PROJECT = Path(__file__).resolve().parent.parent
BOOT_OFFSET = 16 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise SystemExit('Refusing FIT tamper image: ' + message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', type=Path, default=PROJECT / 'output-signed-lab/images/radxa-zero3-rt.img')
    parser.add_argument('--out', type=Path, required=True, help='NEW test-only image; will never overwrite an existing file')
    args = parser.parse_args()
    source = args.image.resolve(strict=True)
    destination = args.out.resolve()
    require(source != destination, 'source and output paths are identical')
    require(not destination.exists(), 'output already exists')
    images = source.parent
    filesystem = images / 'boot.ext4'
    fit = images / 'kernel.itb'
    debugfs = PROJECT / 'output-signed-lab/host/sbin/debugfs'
    verifier = PROJECT / 'sources/boot-firmware/build/u-boot/tools/fit_check_sign'
    trusted = PROJECT / 'sources/boot-firmware/out-optee-signed-lab/u-boot.dtb'
    for path in (filesystem, fit, debugfs, verifier, trusted):
        require(path.is_file(), f'missing signed-lab input {path}')
    with source.open('rb') as disk, filesystem.open('rb') as boot:
        disk.seek(BOOT_OFFSET)
        while chunk := boot.read(1024 * 1024):
            require(disk.read(len(chunk)) == chunk, 'boot.ext4 differs from flash image')
    with filesystem.open('rb') as boot:
        boot.seek(1024 + 24)  # ext4 superblock s_log_block_size
        log_size = struct.unpack('<I', boot.read(4))[0]
    require(log_size <= 2, 'unreasonable ext4 block size')
    block_size = 1024 << log_size
    logical = fit.stat().st_size - 2048  # inside signed ramdisk payload, not FIT header
    require(logical > 0, 'signed FIT is too small')
    logical_block, within = divmod(logical, block_size)
    mapped = subprocess.run([str(debugfs), '-R', f'bmap /boot/kernel.itb {logical_block}',
                             str(filesystem)], check=True, capture_output=True, text=True)
    physical = int(mapped.stdout.strip())
    require(physical > 0 and (physical + 1) * block_size <= filesystem.stat().st_size,
            'target file block is not allocated in boot.ext4')
    inside_fs = physical * block_size + within
    with filesystem.open('rb') as boot, fit.open('rb') as src:
        boot.seek(inside_fs)
        src.seek(logical)
        require(boot.read(1) == src.read(1), 'file block does not match signed FIT')

    with tempfile.TemporaryDirectory(prefix='zero3-fit-tamper-check-') as temp:
        tempboot, extracted = Path(temp) / 'boot.ext4', Path(temp) / 'kernel.itb'
        shutil.copyfile(filesystem, tempboot)
        with tempboot.open('r+b') as boot:
            boot.seek(inside_fs)
            original = boot.read(1)
            boot.seek(inside_fs)
            boot.write(bytes([original[0] ^ 1]))
        subprocess.run([str(debugfs), '-R', f'dump /boot/kernel.itb {extracted}',
                        str(tempboot)], check=True, capture_output=True)
        require(extracted.is_file() and extracted.stat().st_size == fit.stat().st_size,
                'could not read tampered FIT from ext4')
        check = subprocess.run([str(verifier), '-f', str(extracted), '-k', str(trusted),
                                '-c', 'conf-1'], capture_output=True)
        require(check.returncode != 0 and b'Bad Data Hash' in check.stdout + check.stderr,
                'tampered FIT was not rejected for payload hash mismatch')

    # Create only after proving the copied filesystem contains a FIT with one
    # intentional data mutation. Original image and boot filesystem stay intact.
    created = False
    try:
        with source.open('rb') as src, destination.open('xb') as dst:
            created = True
            shutil.copyfileobj(src, dst, length=1024 * 1024)
        with destination.open('r+b') as disk:
            disk.seek(BOOT_OFFSET + inside_fs)
            value = disk.read(1)
            require(bool(value), 'test-image mutation offset exceeds disk image')
            disk.seek(BOOT_OFFSET + inside_fs)
            disk.write(bytes([value[0] ^ 1]))
    except BaseException:
        if created:
            destination.unlink(missing_ok=True)
        raise
    with destination.open('rb') as image:
        digest = hashlib.file_digest(image, 'sha256').hexdigest()
    print(f'TEST ONLY: {destination} sha256={digest}; signed FIT payload differs by one byte')
    print('Expected: U-Boot rejects kernel FIT and enters reset loop; never enroll this key in OTP.')


if __name__ == '__main__':
    main()
