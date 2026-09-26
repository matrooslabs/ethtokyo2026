#!/usr/bin/env python3
"""Fail closed on build invariants and record deployable, hash-addressed artifacts."""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

out, profile, project = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
images = out / 'images'
config = out / '.config'
manifest = project / 'manifests/sources.lock'

def require(test, description):
    if not test:
        raise SystemExit('FAILED invariant: ' + description)

require(profile in ('production', 'debug', 'optee-debug', 'rng-lab', 'otp-lab', 'optee-runtime', 'signed-lab', 'mvp-keyed', 'hardware-root'),
        'known profile')
debug_profile = profile in ('debug', 'optee-debug', 'rng-lab', 'otp-lab', 'signed-lab')
optee_profile = profile in ('optee-debug', 'rng-lab', 'otp-lab', 'optee-runtime', 'signed-lab', 'mvp-keyed', 'hardware-root')
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
require(debugfs.is_file(), 'host debugfs for boot partition verification')
if profile in ('hardware-root', 'signed-lab', 'mvp-keyed'):
    fit = images / 'kernel.itb'
    mode = 'hardware' if profile == 'hardware-root' else profile
    trusted = project / f'sources/boot-firmware/out-optee-{mode}/u-boot.dtb'
    checker = project / 'sources/boot-firmware/build/u-boot/tools/fit_check_sign'
    require(fit.is_file() and trusted.is_file() and checker.is_file(),
            'signed kernel FIT and trusted U-Boot verifier')
    subprocess.run([str(checker), '-f', str(fit), '-k', str(trusted), '-c', 'conf-1'],
                   check=True, capture_output=True)
    dumpimage = project / 'sources/boot-firmware/build/u-boot/tools/dumpimage'
    require(dumpimage.is_file(), 'U-Boot FIT extractor')
    with tempfile.TemporaryDirectory(prefix='zero3-fit-verification-') as scratch:
        signed_fdt = Path(scratch) / 'board.dtb'
        subprocess.run([str(dumpimage), '-T', 'flat_dt', '-p', '1', '-o',
                        str(signed_fdt), str(fit)], check=True, capture_output=True)
        args = subprocess.run(['fdtget', '-t', 's', str(signed_fdt), '/chosen', 'bootargs'],
                              check=True, capture_output=True, text=True).stdout.strip()
        require(f'bridgeos.profile={profile}' in args and 'rdinit=/init' in args,
                'signed FDT owns appliance boot arguments')
    if profile in ('signed-lab', 'mvp-keyed'):
        published = images / 'boot-key-identity.json'
        require(published.is_file(), 'public boot-key identity record')
        with tempfile.TemporaryDirectory(prefix='zero3-key-verification-') as scratch:
            computed = Path(scratch) / 'identity.json'
            subprocess.run([str(project / 'scripts/boot-key-identity.py'),
                            str(project / f'sources/boot-firmware/out-optee-{mode}/u-boot-spl-pubkey.dtb'),
                            str(trusted), str(computed)], check=True, capture_output=True)
            require(published.read_bytes() == computed.read_bytes(),
                    'public boot key fingerprint matches both signed stages')
    if profile == 'mvp-keyed':
        firmware_dir = project / 'sources/boot-firmware/out-optee-mvp-keyed'
        firmware_fit = firmware_dir / 'u-boot.itb'
        spl_key = firmware_dir / 'u-boot-spl-pubkey.dtb'
        require(firmware_fit.is_file() and spl_key.is_file(),
                'keyed firmware FIT and SPL required public key')
        listed = subprocess.run([str(fdtget), '-l', str(firmware_fit), '/configurations'],
                                check=True, capture_output=True, text=True).stdout.split()
        require(bool(listed), 'firmware FIT has signed configurations')
        for name in listed:
            signed = subprocess.run([str(fdtget), '-t', 's', str(firmware_fit),
                                     f'/configurations/{name}/signature', 'sign-images'],
                                    check=True, capture_output=True, text=True).stdout.strip()
            require(signed == 'firmware loadables fdt', 'firmware, loadables and FDT signed')
            subprocess.run([str(checker), '-f', str(firmware_fit), '-k', str(spl_key),
                            '-c', name], check=True, capture_output=True)
        with (firmware_dir / 'u-boot-rockchip.bin').open('rb') as combined, firmware_fit.open('rb') as fit_source:
            combined.seek(0x7f8000)
            while part := fit_source.read(1024 * 1024):
                require(combined.read(len(part)) == part, 'signed firmware FIT embedded in flashed loader')
        idblock = firmware_dir / 'idbloader.img'
        require(idblock.is_file() and spl_key.read_bytes() in idblock.read_bytes(),
                'signed idblock contains the required SPL verification key')
        uboot_config = (project / 'sources/boot-firmware/build/u-boot/.config').read_text().splitlines()
        require('CONFIG_BRIDGEOS_SIGNED_BOOT=y' in uboot_config and
                'CONFIG_SPL_FIT_SIGNATURE=y' in uboot_config and
                'CONFIG_FIT_SIGNATURE=y' in uboot_config and
                'CONFIG_BOOTDELAY=-2' in uboot_config and
                'CONFIG_AUTOBOOT_KEYED=y' in uboot_config and
                'CONFIG_AUTOBOOT_KEYED_CTRLC=y' not in uboot_config and
                'CONFIG_BOOTCOMMAND="if mmc dev 1; then if ext4load mmc 1:1 0x10000000 /boot/kernel.itb; then bootm 0x10000000; fi; fi; while true; do reset; sleep 1; done"' in uboot_config,
                'keyed firmware boots only a signed kernel FIT and fails closed')
        for unsigned_path in ('CONFIG_BOOTSTD=y', 'CONFIG_BOOTMETH_EXTLINUX=y',
                              'CONFIG_BOOTMETH_EXTLINUX_PXE=y', 'CONFIG_BOOTMETH_SCRIPT=y',
                              'CONFIG_BOOTMETH_DISTRO=y', 'CONFIG_LEGACY_IMAGE_FORMAT=y',
                              'CONFIG_CMD_BOOTI=y', 'CONFIG_CMD_GO=y', 'CONFIG_CMD_SOURCE=y',
                              'CONFIG_CMD_BOOTEFI=y', 'CONFIG_BOOTM_EFI=y'):
            require(unsigned_path not in uboot_config, 'unsigned U-Boot path disabled: ' + unsigned_path)
        require(json.loads(published.read_text())['rom_fuse_enforcement_verified'] is False,
                'no claim of RK3566 ROM/OTP enforcement')
    boot_fit = subprocess.run([str(debugfs), '-R', 'stat /boot/kernel.itb', str(boot_image)],
                              capture_output=True, text=True, check=True)
    require('Inode:' in boot_fit.stdout, 'signed kernel FIT in boot partition')
    for unsigned in ('Image', 'rootfs.cpio.gz', 'rk3566-radxa-zero-3w-rt.dtb',
                     'extlinux/extlinux.conf'):
        listed = subprocess.run([str(debugfs), '-R', 'stat /boot/' + unsigned,
                                 str(boot_image)], capture_output=True, text=True, check=True)
        require('Inode:' not in listed.stdout, 'unsigned boot fallback excluded: ' + unsigned)
else:
    extlinux = subprocess.run([str(debugfs), '-R', 'cat /boot/extlinux/extlinux.conf', str(boot_image)],
                             capture_output=True, text=True, check=True).stdout
    for entry in ('LINUX /boot/Image', 'FDT /boot/rk3566-radxa-zero-3w-rt.dtb',
                  'INITRD /boot/rootfs.cpio.gz', 'rdinit=/init',
                  'console=ttyS2,1500000n8 earlycon loglevel=7'):
        require(entry in extlinux, 'boot configuration entry ' + entry)
root = out / 'target'
require((root / 'init').exists(), '/init')
if profile not in ('rng-lab', 'otp-lab'):
    require((root / 'usr/bin/bridge-daemon').exists(), 'bridge daemon')
cpio = out / 'host/bin/cpio'
require(cpio.is_file(), 'Buildroot host cpio')
with subprocess.Popen(['gzip', '-dc', str(images / 'rootfs.cpio.gz')], stdout=subprocess.PIPE) as unpack:
    listing = subprocess.run([str(cpio), '-t'], stdin=unpack.stdout,
                             capture_output=True, text=True, check=True)
    unpack.stdout.close()
    require(unpack.wait() == 0, 'readable compressed initramfs')
members = {name.removeprefix('./').lstrip('/') for name in listing.stdout.splitlines()}
required_members = {'init', 'etc/init.d/S03optee-stage'}
if profile not in ('rng-lab', 'otp-lab'):
    required_members |= {'usr/bin/bridge-daemon', 'usr/sbin/bridge-gadget',
                         'usr/sbin/bridge-rt-policy', 'etc/init.d/S99bridge'}
require(required_members <= members, 'required initramfs programs and init scripts')
if debug_profile:
    require('etc/init.d/S99zzdiag' in members, 'Mac-readable debug diagnostics')
    if profile in ('rng-lab', 'otp-lab'):
        for forbidden in ('etc/init.d/S99bridge', 'etc/bridge-rt.conf',
                          'usr/bin/bridge-daemon', 'usr/bin/osumania-optee-test',
                          'lib/optee_armtz/91fc6874-8551-4b42-a95d-6ee4a147f421.ta',
                          'usr/share/osumania/srs-g1-be.bin'):
            require(forbidden not in members, 'no signing surface in read-only lab: ' + forbidden)
        require((root / 'etc/optee-runtime-mode').read_text().strip() == profile,
                'explicit laboratory-only marker')
        core = project / f'sources/optee-os-artifacts/{profile}/tee.elf'
        require(core.is_file(), 'isolated OP-TEE core artifact')
        compiled = core.read_bytes()
        require(b'BridgeOS-dev-HUK' not in compiled,
                'no embedded development HUK in laboratory core')
        expected_firmware = project / f'sources/boot-firmware/out-optee-{profile}/u-boot-rockchip.bin'
        description = 'isolated laboratory firmware matches SD image'
    else:
        require('etc/bridge-rt.conf' in members, 'debug bridge startup configuration')
        if optee_profile:
            ta_member = 'lib/optee_armtz/91fc6874-8551-4b42-a95d-6ee4a147f421.ta'
            require({ta_member, 'usr/bin/osumania-optee-test'} <= members,
                    'selected OP-TEE TA and smoke client packaged in debug initramfs')
            mode = 'signed-lab' if profile == 'signed-lab' else 'dev'
            expected_firmware = project / f'sources/boot-firmware/out-optee-{mode}/u-boot-rockchip.bin'
            description = 'source OP-TEE debug firmware matches selected signed/unsigned profile'
        else:
            expected_firmware = project / 'sources/boot-firmware/out/u-boot-rockchip.bin'
            description = 'debug flash image uses known-bootable baseline firmware'
    require(expected_firmware.is_file() and
            hashlib.sha256(firmware.read_bytes()).digest() == hashlib.sha256(expected_firmware.read_bytes()).digest(),
            description)
else:
    require('etc/init.d/S99zzdiag' not in members and
            not (images / 'diag.vfat').exists(), 'no writable diagnostics in production')
    if profile in ('optee-runtime', 'hardware-root'):
        require({'etc/bridge-rt.conf',
                 'lib/optee_armtz/91fc6874-8551-4b42-a95d-6ee4a147f421.ta'} <= members,
                'source OP-TEE runtime TA and configuration')
        require('usr/bin/osumania-optee-test' not in members,
                'no competing standalone TEE smoke client in runtime')
        supplicant_init = root / 'etc/init.d/S30tee-supplicant'
        require(supplicant_init.is_file() and '-f /run/tee' in supplicant_init.read_text(),
                'source OP-TEE runtime REE-FS uses writable volatile tmpfs')
        mode = 'hardware' if profile == 'hardware-root' else 'dev'
        expected_firmware = project / f'sources/boot-firmware/out-optee-{mode}/u-boot-rockchip.bin'
        require(expected_firmware.is_file() and
                hashlib.sha256(firmware.read_bytes()).digest() == hashlib.sha256(expected_firmware.read_bytes()).digest(),
                'source OP-TEE runtime uses matching BL32 firmware')
        ta = root / 'lib/optee_armtz/91fc6874-8551-4b42-a95d-6ee4a147f421.ta'
        require(ta.is_file() and ta.read_bytes().startswith(b'HSTO'),
                'OP-TEE signed TA header packaged in initramfs')
        if profile == 'hardware-root':
            require('BR2_PACKAGE_BRIDGE_DAEMON_DEV_CRYPTO=y' not in build_config,
                    'hardware image excludes development signer/SRS')
            record_path = os.environ.get('OSUMANIA_PROVISIONING_RECORD')
            require(record_path and Path(record_path).is_file(), 'external reviewed provisioning record')
            record = json.loads(Path(record_path).read_text())
            bank = root / 'usr/share/osumania/srs-g1-be.bin'
            require(bank.is_file() and hashlib.sha256(bank.read_bytes()).hexdigest() == record['srs_sha256'].lower(),
                    'approved SRS bank in hardware rootfs')
            conf = (project / 'sources/optee-os/out/arm-plat-rockchip/conf.mk').read_text()
            require('CFG_RK3568_DEV_INSECURE_HUK=n' in conf and 'CFG_INSECURE=n' in conf and
                    f'CFG_RK3568_HUK_OFFSET={record["secure_otp_huk_byte_offset"]}' in conf,
                    'hardware OP-TEE uses reviewed OTP offset with no insecure HUK')
if profile == 'mvp-keyed':
    from stat import S_IMODE
    mvp_firmware = project / 'sources/boot-firmware/out-optee-mvp-keyed/u-boot-rockchip.bin'
    require(mvp_firmware.is_file() and
            hashlib.sha256(firmware.read_bytes()).digest() == hashlib.sha256(mvp_firmware.read_bytes()).digest(),
            'MVP disk includes its own signed OP-TEE firmware')
    public_identity = images / 'mvp-identity.json'
    source_identity = project / 'sources/optee-os-artifacts/mvp-policy/mvp-identity.json'
    require(public_identity.is_file() and source_identity.is_file() and
            public_identity.read_bytes() == source_identity.read_bytes(),
            'MVP public device identity accompanies flash image')
    identity_data = json.loads(public_identity.read_text())
    require(len(identity_data['device_address']) == 42 and
            len(identity_data['build_marker']) == 66 and
            identity_data['srs_sha256'] == locked['device_srs_ceremony']['device_bank_sha256'] and
            identity_data['hardware_root'] is False and
            identity_data['bitstream_attestation'] is False and
            identity_data['key_security'] == 'EXTRACTABLE_FROM_SD_IMAGE',
            'public MVP identity discloses actual key extraction boundary')

    require('BR2_ROOTFS_POST_SCRIPT_ARGS="mvp-keyed"' in build_config and
            'BR2_PACKAGE_BRIDGE_DAEMON_DEV_CRYPTO=y' not in build_config,
            'dedicated keyed image excludes public 260-point dev SRS/backend')
    require('etc/osumania-provision.conf' not in members and
            not (root / 'etc/osumania-provision.conf').exists() and
            'usr/bin/osumania-optee-test' not in members,
            'MVP initramfs excludes development key provision and competing TA test client')
    startup = dict(line.split('=', 1) for line in
                   (root / 'etc/bridge-rt.conf').read_text().splitlines() if '=' in line)
    require(startup.get('OSUMANIA_SIGNER_BACKEND') == 'optee' and
            startup.get('OSUMANIA_SRS') == '/usr/share/osumania/srs-g1-be.bin' and
            'BRIDGE_DIAG_LOG' not in startup,
            'MVP uses OP-TEE signer and PSE bank without diagnostic logging')
    daemon = root / 'usr/bin/bridge-daemon'
    require(daemon.is_file() and
            b'DEV_INSECURE_KEY_BACKEND active' not in daemon.read_bytes() and
            b'DEV_INSECURE_PRIVATE_KEY' not in daemon.read_bytes(),
            'MVP bridge binary does not contain a development signing backend')
    ta_path = 'lib/optee_armtz/91fc6874-8551-4b42-a95d-6ee4a147f421.ta'
    ta = root / ta_path
    source_ta = project / 'sources/optee-os-artifacts/mvp-keyed/91fc6874-8551-4b42-a95d-6ee4a147f421.ta'
    require(ta_path in members and ta.is_file() and source_ta.is_file(),
            'keyed signer TA exists in source artifacts and initramfs')
    packaged_ta = ta.read_bytes()
    require(packaged_ta.startswith(b'HSTO') and packaged_ta == source_ta.read_bytes() and
            b'DEV_INSECURE_KEY_BACKEND active' not in packaged_ta,
            'packaged signer TA matches keyed artifact without development fallback')
    compiled_core = project / 'sources/optee-os-artifacts/mvp-keyed/tee.elf'
    require(compiled_core.is_file() and b'BridgeOS-dev-HUK' not in compiled_core.read_bytes(),
            'keyed OP-TEE core excludes public development HUK')
    optee_source = Path(os.environ.get('OPTEE_SOURCE_DIR', project / 'sources/optee-os'))
    core_conf = (optee_source / 'out/arm-plat-rockchip/conf.mk').read_text().splitlines()
    require('CFG_RK3568_DEV_INSECURE_HUK=n' in core_conf and
            'CFG_RK3568_HUK_OFFSET=0xffffffff' in core_conf,
            'keyed OP-TEE core does not enable public development HUK')
    pin = locked['device_srs_ceremony']
    bank_path = 'usr/share/osumania/srs-g1-be.bin'
    record_path = 'usr/share/osumania/srs-manifest.json'
    bank = root / bank_path
    record = root / record_path
    require(pin['device_point_count'] == 200000 and pin['device_point_count'] // 4 == 50000 and
            bank_path in members and record_path in members and bank.is_file() and record.is_file() and
            bank.stat().st_size == pin['device_point_count'] * 64 and
            S_IMODE(bank.stat().st_mode) == 0o444 and S_IMODE(record.stat().st_mode) == 0o444,
            'read-only external 200000-point bank gives GET_INFO maxEvents=50000')
    with bank.open('rb') as stream:
        bank_sha = hashlib.file_digest(stream, 'sha256').hexdigest()
    require(bank_sha == pin['device_bank_sha256'] and
            bank_sha != locked['development_srs']['sha256'],
            'packaged bank matches only pinned PSE device ceremony')
    public = json.loads(record.read_text())
    require(public['pointCount'] == 200000 and public['bytesPerPoint'] == 64 and
            public['sha256'] == '0x' + bank_sha and
            public['srsId'] == '0x' + pin['srs_id'] and public['maxEvents'] == 50000 and
            public['keyExtractable'] is True and public['hardwareRoot'] is False and
            public['otpProvenance'] is False and public['romFuseEnforcementVerified'] is False and
            public['bitstreamAttestation'] is False,
            'MVP bank and security boundary public manifest')
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
if profile in ('production', 'optee-runtime', 'hardware-root', 'mvp-keyed'):
    require('# CONFIG_DEBUG_FS is not set' in symbols, 'no production debugfs')
    for path in ('lib/systemd', 'usr/lib/systemd', 'usr/bin/python3',
                 'usr/bin/python', 'usr/bin/apt', 'usr/bin/apt-get', 'usr/bin/dpkg',
                 'usr/bin/opkg', 'usr/bin/rpm', 'usr/bin/pacman', 'usr/sbin/sshd',
                 'usr/bin/dbus-daemon', 'usr/sbin/NetworkManager',
                 'sbin/syslogd', 'usr/sbin/syslogd', 'etc/init.d/S40network',
                 'etc/init.d/S99zzdiag', 'usr/bin/osumania-optee-test',
                 'usr/bin/cyclictest', 'usr/bin/cyclicdeadline', 'usr/bin/deadline_test',
                 'usr/bin/hackbench', 'usr/bin/pi_stress', 'usr/bin/pip_stress',
                 'usr/bin/pmqtest', 'usr/bin/ptsematest', 'usr/bin/rt-migrate-test',
                 'usr/bin/signaltest', 'usr/bin/sigwaittest', 'usr/bin/svsematest',
                 'usr/bin/queuelat', 'usr/bin/ssdd', 'usr/bin/oslat',
                 'usr/bin/determine_maximum_mpps.sh', 'usr/bin/trace-cmd',
                 'usr/bin/stress-ng'):
        require(not (root / path).exists() and path not in members,
                'forbidden production path ' + path)
shutil.copy2(kconfig, images / 'kernel.config')
shutil.copy2(config, images / 'buildroot.config')
shutil.copy2(manifest, images / 'sources.lock')
files = [images / x for x in ('kernel.config', 'buildroot.config', 'sources.lock',
         'Image', 'boot.ext4', 'rootfs.cpio.gz', 'u-boot-rockchip.bin', 'radxa-zero3-rt.img')]
files.extend(dtbs)
if profile in ('hardware-root', 'signed-lab', 'mvp-keyed'):
    files.append(images / 'kernel.itb')
if profile in ('signed-lab', 'mvp-keyed'):
    files.append(images / 'boot-key-identity.json')
if profile == 'mvp-keyed':
    files.append(images / 'mvp-identity.json')
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
