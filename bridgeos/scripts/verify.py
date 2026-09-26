#!/usr/bin/env python3
"""Fail closed on build invariants and record deployable, hash-addressed artifacts."""
import hashlib
import json
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

out, profile, project = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
images = out / 'images'
config = out / '.config'
manifest = project / 'manifests/sources.lock'

def require(test, description):
    if not test:
        raise SystemExit('FAILED invariant: ' + description)

require(profile in ('production', 'debug', 'optee-debug', 'optee-runtime'),
        'known profile')
debug_profile = profile in ('debug', 'optee-debug')
optee_profile = profile in ('optee-debug', 'optee-runtime')
require(config.is_file(), 'Buildroot .config')
build_config = config.read_text()
require('BR2_aarch64=y' in build_config, 'aarch64 Buildroot target')
require(manifest.is_file(), 'source manifest')
locked = json.loads(manifest.read_text())
require(f'BR2_LINUX_KERNEL_CUSTOM_REPO_VERSION="{locked["kernel"]["commit"]}"' in build_config,
        'pinned kernel commit matches source manifest')
require(f'BR2_LINUX_KERNEL_CUSTOM_REPO_URL="{locked["kernel"]["repository"]}"' in build_config,
        'pinned kernel repository matches source manifest')
require('BR2_REPRODUCIBLE=y' in build_config, 'Buildroot reproducible mode')
linux = list((out / 'build').glob('linux-*/.config'))
require(len(linux) == 1, 'exactly one completed Linux .config')
kconfig = linux[0]
text = kconfig.read_text()
symbols = set(text.splitlines())
needed = ('CONFIG_ARM64=y', 'CONFIG_PREEMPT_RT=y', 'CONFIG_USB=y',
          'CONFIG_DEVTMPFS=y', 'CONFIG_CONFIGFS_FS=y',
          'CONFIG_USB_HID=y', 'CONFIG_USB_GADGET=y', 'CONFIG_USB_LIBCOMPOSITE=y',
          'CONFIG_USB_CONFIGFS=y', 'CONFIG_USB_CONFIGFS_F_HID=y', 'CONFIG_USB_F_HID=y',
          'CONFIG_USB_DWC3=y', 'CONFIG_USB_XHCI_HCD=y',
          'CONFIG_PHY_ROCKCHIP_INNO_USB2=y', 'CONFIG_PHY_ROCKCHIP_NANENG_COMBO_PHY=y',
          'CONFIG_ROCKCHIP_THERMAL=y', 'CONFIG_TEE=y', 'CONFIG_OPTEE=y')
for entry in needed:
    require(entry in symbols, entry)
require('CONFIG_USB_DWC3_GADGET=y' in symbols or 'CONFIG_USB_DWC3_DUAL_ROLE=y' in symbols,
        'DWC3 gadget-capable controller')
require('CONFIG_PREEMPT_DYNAMIC=y' not in symbols, 'not PREEMPT_DYNAMIC')
dtbs = list(images.glob('rk3566-radxa-zero-3w-rt.dtb'))
require(len(dtbs) == 1, 'exactly one ZERO 3W RT DTB')
with dtbs[0].open('rb') as stream:
    require(stream.read(4) == bytes.fromhex('d00dfeed'), 'DTB header')
fdtget = out / 'host/bin/fdtget'
require(fdtget.is_file(), 'host fdtget for DTB semantic verification')
def property_at(node, name):
    result = subprocess.run([str(fdtget), '-t', 's', str(dtbs[0]), node, name],
                            capture_output=True, text=True, check=True)
    return result.stdout.strip()
def hex_property_at(node, name):
    result = subprocess.run([str(fdtget), '-t', 'x', str(dtbs[0]), node, name],
                            capture_output=True, text=True, check=True)
    return result.stdout.split()
require(property_at('/', 'model') == 'Radxa ZERO 3W', 'actual ZERO 3W model')
require(property_at('/usb@fcc00000', 'dr_mode') == 'peripheral', 'PC gadget controller role')
require(property_at('/usb@fcc00000', 'maximum-speed') == 'high-speed', 'gadget USB2 HS capability')
require(property_at('/usb@fd000000', 'dr_mode') == 'host', 'keyboard host controller role')
for node in ('/usb@fcc00000', '/usb@fd000000'):
    require(property_at(node, 'status') in ('okay', 'ok'), f'{node} enabled')
if optee_profile:
    require(property_at('/firmware/optee', 'compatible') == 'linaro,optee-tz', 'Linux OP-TEE firmware node')
    require(property_at('/firmware/optee', 'method') == 'smc', 'OP-TEE SMC conduit')
    require(hex_property_at('/reserved-memory/optee_core@8400000', 'reg') ==
            ['0', '8400000', '0', '2000000'], '32 MiB OP-TEE TZDRAM reservation')
    require(hex_property_at('/reserved-memory/optee_shm@a400000', 'reg') ==
            ['0', 'a400000', '0', '400000'], '4 MiB OP-TEE shared-memory reservation')
require((images / 'Image').is_file(), 'arm64 Image')
require((images / 'rootfs.cpio.gz').is_file(), 'initramfs')
require((images / 'u-boot-rockchip.bin').is_file(), 'source-built firmware')
require((images / 'radxa-zero3-rt.img').is_file(), 'flashable disk image')
firmware = images / 'u-boot-rockchip.bin'
with (images / 'radxa-zero3-rt.img').open('rb') as disk, firmware.open('rb') as src:
    disk.seek(0x8000)
    while chunk := src.read(1024 * 1024):
        require(disk.read(len(chunk)) == chunk, 'firmware at sector 64')
disk_image = images / 'radxa-zero3-rt.img'
require(64 * 1024 * 1024 <= disk_image.stat().st_size <= 128 * 1024 * 1024,
        'flash image between 64 and 128 MiB')
expected_disk_uuid = uuid.UUID('58bcd5aa-99c4-5e34-91f7-162a6ca76d01')
expected_boot_uuid = uuid.UUID('8040131e-7d3a-5de1-9354-f2dcd9162f17')
expected_diag_uuid = uuid.UUID('d11a6e31-e257-5e9d-9ae3-c3744136f1ee')
with disk_image.open('rb') as disk:
    disk.seek(510)
    require(disk.read(2) == b'\x55\xaa', 'protective MBR signature')
    disk.seek(512)
    gpt = disk.read(92)
    require(gpt[:8] == b'EFI PART', 'GPT partition table')
    require(uuid.UUID(bytes_le=gpt[56:72]) == expected_disk_uuid,
            'reproducible GPT disk identity')
    entries_lba = int.from_bytes(gpt[72:80], 'little')
    disk.seek(entries_lba * 512)
    partition = disk.read(128)
    require(uuid.UUID(bytes_le=partition[:16]) == uuid.UUID('0fc63daf-8483-4772-8e79-3d69d8477de4'),
            'Linux filesystem GPT partition')
    require(uuid.UUID(bytes_le=partition[16:32]) == expected_boot_uuid,
            'reproducible GPT partition identity')
    require(int.from_bytes(partition[32:40], 'little') == 32768,
            'boot partition at 16 MiB after firmware')
    require(int.from_bytes(partition[48:56], 'little') == 0,
            'GPT boot attributes match Debian reference')
if debug_profile:
    require('CONFIG_VFAT_FS=y' in symbols, 'built-in FAT diagnostic filesystem')
    diag_image = images / 'diag.vfat'
    require(diag_image.is_file() and diag_image.stat().st_size == 8 * 1024 * 1024,
            '8 MiB Mac-readable debug partition')
    with disk_image.open('rb') as disk, diag_image.open('rb') as src:
        disk.seek(entries_lba * 512 + 128)
        diag = disk.read(128)
        require(uuid.UUID(bytes_le=diag[:16]) == uuid.UUID('ebd0a0a2-b9e5-4433-87c0-68b6b72699c7'),
                'Mac-compatible GPT Basic Data type')
        require(uuid.UUID(bytes_le=diag[16:32]) == expected_diag_uuid,
                'debug partition identity')
        require(int.from_bytes(diag[32:40], 'little') == 229376,
                'diagnosis partition at 112 MiB')
        disk.seek(112 * 1024 * 1024)
        while chunk := src.read(1024 * 1024):
            require(disk.read(len(chunk)) == chunk, 'FAT diagnostics in flash image')
boot_image = images / 'boot.ext4'
require(boot_image.is_file(), 'generated ext4 boot filesystem')
with disk_image.open('rb') as disk, boot_image.open('rb') as src:
    disk.seek(16 * 1024 * 1024)
    while chunk := src.read(1024 * 1024):
        require(disk.read(len(chunk)) == chunk, 'boot filesystem in flash partition')
debugfs = out / 'host/sbin/debugfs'
require(debugfs.is_file(), 'host debugfs for extlinux verification')
extlinux = subprocess.run([str(debugfs), '-R', 'cat /boot/extlinux/extlinux.conf', str(boot_image)],
                         capture_output=True, text=True, check=True).stdout
for entry in ('LINUX /boot/Image', 'FDT /boot/rk3566-radxa-zero-3w-rt.dtb',
              'INITRD /boot/rootfs.cpio.gz', 'rdinit=/init',
              'console=ttyS2,1500000n8 earlycon loglevel=7'):
    require(entry in extlinux, 'boot configuration entry ' + entry)
root = out / 'target'
require((root / 'init').exists(), '/init')
require((root / 'usr/bin/bridge-daemon').exists(), 'bridge daemon')
cpio = out / 'host/bin/cpio'
require(cpio.is_file(), 'Buildroot host cpio')
with subprocess.Popen(['gzip', '-dc', str(images / 'rootfs.cpio.gz')], stdout=subprocess.PIPE) as unpack:
    listing = subprocess.run([str(cpio), '-t'], stdin=unpack.stdout,
                             capture_output=True, text=True, check=True)
    unpack.stdout.close()
    require(unpack.wait() == 0, 'readable compressed initramfs')
members = {name.removeprefix('./').lstrip('/') for name in listing.stdout.splitlines()}
required_members = {'init', 'usr/bin/bridge-daemon', 'usr/sbin/bridge-gadget',
                    'usr/sbin/bridge-rt-policy', 'etc/init.d/S03optee-stage',
                    'etc/init.d/S99bridge'}
require(required_members <= members, 'bridge daemon, gadget policy and init in CPIO')
if debug_profile:
    require({'etc/init.d/S99zzdiag', 'etc/bridge-rt.conf'} <= members,
            'debug diagnostics and bridge startup configuration')
    if optee_profile:
        require({'usr/bin/osumania-optee-test',
                 'lib/optee_armtz/91fc6874-8551-4b42-a95d-6ee4a147f421.ta'} <= members,
                'OP-TEE smoke client and constrained TA')
        expected_firmware = project / 'sources/boot-firmware/out-optee-dev/u-boot-rockchip.bin'
        description = 'OP-TEE debug image uses corrected source 4.9 BL32 firmware'
    else:
        expected_firmware = project / 'sources/boot-firmware/out/u-boot-rockchip.bin'
        description = 'debug flash image uses known-bootable baseline firmware'
    require(expected_firmware.is_file() and
            hashlib.sha256(firmware.read_bytes()).digest() == hashlib.sha256(expected_firmware.read_bytes()).digest(),
            description)
else:
    require('etc/init.d/S99zzdiag' not in members and
            not (images / 'diag.vfat').exists(), 'no writable diagnostics in production')
    if profile == 'optee-runtime':
        require({'etc/bridge-rt.conf',
                 'lib/optee_armtz/91fc6874-8551-4b42-a95d-6ee4a147f421.ta'} <= members,
                'source OP-TEE runtime TA and configuration')
        require('usr/bin/osumania-optee-test' not in members,
                'no competing standalone TEE smoke client in runtime')
        supplicant_init = root / 'etc/init.d/S30tee-supplicant'
        require(supplicant_init.is_file() and '-f /run/tee' in supplicant_init.read_text(),
                'source OP-TEE runtime REE-FS uses writable volatile tmpfs')
        expected_firmware = project / 'sources/boot-firmware/out-optee-dev/u-boot-rockchip.bin'
        require(expected_firmware.is_file() and
                hashlib.sha256(firmware.read_bytes()).digest() == hashlib.sha256(expected_firmware.read_bytes()).digest(),
                'source OP-TEE runtime uses corrected source BL32 firmware')
tuning = root / 'etc/bridge-rt.conf'
require(not tuning.exists() or 'BRIDGE_KEYBOARD_HID_INTERVAL=' not in tuning.read_text(),
        'both profiles use the same kernel-default HID interval')
identity = root / 'etc/bridge-gadget.conf'
require(identity.is_file() and 'etc/bridge-gadget.conf' in members,
        'provisioned gadget identity in initramfs')
settings = dict(line.split('=', 1) for line in identity.read_text().splitlines()
                if line.startswith(('BRIDGE_USB_VID=', 'BRIDGE_USB_PID=')))
require(settings.get('BRIDGE_USB_VID') == locked['usb_gadget']['vid'] and
        settings.get('BRIDGE_USB_PID') == locked['usb_gadget']['pid'],
        'supplied USB VID:PID matches manifest')
if profile in ('production', 'optee-runtime'):
    require('# CONFIG_DEBUG_FS is not set' in symbols, 'no production debugfs')
    for path in ('lib/systemd', 'usr/lib/systemd', 'usr/bin/python3',
                 'usr/bin/python', 'usr/bin/apt', 'usr/bin/apt-get', 'usr/bin/dpkg',
                 'usr/bin/opkg', 'usr/bin/rpm', 'usr/bin/pacman', 'usr/sbin/sshd',
                 'usr/bin/dbus-daemon', 'usr/sbin/NetworkManager',
                 'sbin/syslogd', 'usr/sbin/syslogd', 'etc/init.d/S40network'):
        require(not (root / path).exists() and path not in members,
                'forbidden production path ' + path)
shutil.copy2(kconfig, images / 'kernel.config')
shutil.copy2(config, images / 'buildroot.config')
shutil.copy2(manifest, images / 'sources.lock')
files = [images / x for x in ('kernel.config', 'buildroot.config', 'sources.lock',
         'Image', 'boot.ext4', 'rootfs.cpio.gz', 'u-boot-rockchip.bin', 'radxa-zero3-rt.img')]
files.extend(dtbs)
if debug_profile:
    files.append(images / 'diag.vfat')
with (images / 'SHA256SUMS').open('w') as sums:
    for file in sorted(files):
        require(file.is_file() and file.stat().st_size, str(file))
        with file.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        sums.write(f'{digest}  {file.name}\n')
print('BUILD VERIFIED: PREEMPT_RT arm64 kernel, ZERO 3W DTB, source firmware, initramfs and disk image')
print('HARDWARE NOT VERIFIED; latency NOT MEASURED')
