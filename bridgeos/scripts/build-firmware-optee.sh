#!/usr/bin/env bash
set -euo pipefail
project="$(cd "$(dirname "$0")/.." && pwd)"
export SOURCE_DATE_EPOCH=1779278600
mode="${1:-dev}"
case "$mode" in
    dev|rng-lab|otp-lab|signed-lab|mvp-keyed|hardware) ;;
    *) echo "Usage: $0 [dev|rng-lab|otp-lab|signed-lab|mvp-keyed|hardware]" >&2; exit 2 ;;
esac
if [ "$mode" = hardware ]; then
    echo 'REFUSED: TA-only hardware-key firmware needs an approved, provisioned RK3566 Secure OTP root and qualified Secure World RNG. No OTP provisioning is implemented. ROM enforcement against replacement BL32 is a separate stronger requirement.' >&2
    exit 1
fi
if [ "$mode" != dev ] && [ "$mode" != rng-lab ] && [ "$mode" != otp-lab ]; then
    : "${BOOT_SIGN_KEY_DIR:?Signed firmware requires an external BOOT_SIGN_KEY_DIR containing boot.key, boot.crt and boot.pubkey}"
    keydir="$(realpath -e "$BOOT_SIGN_KEY_DIR")"
    case "$keydir/" in "$(dirname "$project")/"*)
        echo 'Boot private key must be outside the ethtokyo2026 checkout' >&2; exit 1 ;;
    esac
    export BOOT_SIGN_KEY_DIR="$keydir"
    for key in boot.key boot.crt boot.pubkey; do
        [ -s "$keydir/$key" ] || { echo "Missing hardware boot key: $keydir/$key" >&2; exit 1; }
    done
    command -v openssl >/dev/null || { echo 'OpenSSL required for boot key checks' >&2; exit 1; }
    openssl pkey -in "$keydir/boot.key" -noout >/dev/null
    openssl x509 -in "$keydir/boot.crt" -noout >/dev/null
    private_pub="$(openssl pkey -in "$keydir/boot.key" -pubout -outform DER | sha256sum | cut -d' ' -f1)"
    cert_pub="$(openssl x509 -in "$keydir/boot.crt" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum | cut -d' ' -f1)"
    pub_pub="$(openssl pkey -pubin -in "$keydir/boot.pubkey" -outform DER | sha256sum | cut -d' ' -f1)"
    [ "$private_pub" = "$cert_pub" ] && [ "$private_pub" = "$pub_pub" ] || {
        echo 'boot.key, boot.crt and boot.pubkey must contain the same RSA public key' >&2; exit 1;
    }
    [ "$(openssl pkey -in "$keydir/boot.key" -text_pub -noout | sed -n 's/^Public-Key: (\([0-9]*\) bit).*/\1/p')" = 2048 ] || {
        echo 'Boot signing key must be RSA-2048 for the signed U-Boot FIT' >&2; exit 1;
    }
fi
if [ "$mode" = mvp-keyed ]; then
    # The orchestrator builds the keyed TA once while the external private
    # header exists; it removes that temporary header before firmware signing.
    artifacts="$project/sources/optee-os-artifacts/mvp-keyed"
    for part in tee-raw.bin 91fc6874-8551-4b42-a95d-6ee4a147f421.ta; do
        [ -s "$artifacts/$part" ] || { echo "Missing keyed OP-TEE artifact: $part" >&2; exit 1; }
    done
elif [ "$mode" = signed-lab ]; then
    "$project/scripts/build-optee.sh" dev
else
    "$project/scripts/build-optee.sh" "$mode"
fi
firmware="$project/sources/boot-firmware"
build="${FIRMWARE_SOURCE_BUILD_DIR:-$firmware/build}"
out="$firmware/out-optee-$mode"
cross="${CROSS_COMPILE64:-$project/output-debug/host/bin/aarch64-buildroot-linux-gnu-}"
[ -x "${cross}gcc" ] || cross="$project/output/host/bin/aarch64-buildroot-linux-musl-"
firmware_cross="${FIRMWARE_CROSS_COMPILE:-aarch64-linux-gnu-}"
if command -v "${firmware_cross}gcc" >/dev/null 2>&1; then
    tfa_tools=(CROSS_COMPILE="$firmware_cross")
    uboot_cross="$firmware_cross"
else
    command -v clang >/dev/null 2>&1 && command -v aarch64-linux-gnu-ld.bfd >/dev/null 2>&1 || {
        echo 'Need Warfront aarch64-linux-gnu-gcc or Clang plus GNU AArch64 binutils' >&2
        exit 1
    }
    tfa_tools=(CC=clang CPP=clang AS=clang LD=aarch64-linux-gnu-ld.bfd
               AR=aarch64-linux-gnu-ar OC=aarch64-linux-gnu-objcopy
               OD=aarch64-linux-gnu-objdump)
    uboot_cross="$cross"
fi
host="$(dirname "$(dirname "${cross}gcc")")"
export PATH="$host/bin:$PATH"
brout="$(dirname "$host")"
make -C "$project/sources/buildroot" BR2_EXTERNAL="$project" O="$brout" host-python-pyelftools
export PYTHONPATH="$host/lib/python3.14/site-packages${PYTHONPATH:+:$PYTHONPATH}"
mkdir -p "$out"
rm -f "$out/u-boot-rockchip.bin" "$out/u-boot.itb" "$out/idbloader.img" \
      "$out/u-boot.dtb" "$out/u-boot-spl-pubkey.dtb" "$out/bl31.elf" \
      "$out/tee.elf" "$out/tee-raw.bin" "$out/SHA256SUMS"

clone_pin() {
    local path=$1 url=$2 commit=$3
    [ -d "$path/.git" ] || git clone "$url" "$path"
    git -C "$path" fetch origin "$commit"
    git -C "$path" checkout --detach "$commit"
    git -C "$path" reset --hard "$commit"
    git -C "$path" clean -fdx
}
tfa="$build/arm-trusted-firmware"
uboot="$build/u-boot"
rkbin="$build/rkbin"
clone_pin "$tfa" https://github.com/ARM-software/arm-trusted-firmware.git "$(cat "$firmware/pins/tfa/commit")"
clone_pin "$uboot" https://github.com/u-boot/u-boot.git "$(cat "$firmware/pins/uboot/commit")"
clone_pin "$rkbin" https://github.com/rockchip-linux/rkbin.git "$(cat "$firmware/pins/rkbin/commit")"
make -C "$tfa" "${tfa_tools[@]}" PLAT=rk3568 SPD=opteed clean
make -C "$tfa" -j"${JOBS:-$(nproc)}" "${tfa_tools[@]}" PLAT=rk3568 SPD=opteed bl31
bl31="$tfa/build/rk3568/release/bl31/bl31.elf"
ddr_rel="$(cat "$firmware/pins/rkbin/ddr")"
ddr="$rkbin/$ddr_rel"
expected_ddr_sha=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["rkbin"]["ddr_blob_sha256"])' "$project/manifests/sources.lock")
actual_ddr_sha=$(sha256sum "$ddr" | cut -d' ' -f1)
[ "$actual_ddr_sha" = "$expected_ddr_sha" ] || {
    echo "RK3566 DDR blob hash mismatch: $actual_ddr_sha" >&2
    exit 1
}
tee_mode="$mode"
[ "$mode" = signed-lab ] && tee_mode=dev
tee="$project/sources/optee-os-artifacts/$tee_mode/tee-raw.bin"
git -C "$uboot" reset --hard "$(cat "$firmware/pins/uboot/commit")"
git -C "$uboot" clean -fdx
git -C "$uboot" apply "$project"/board/radxa-zero3-rt/patches/u-boot/*.patch
make -C "$uboot" CROSS_COMPILE="$uboot_cross" mrproper
make -C "$uboot" CROSS_COMPILE="$uboot_cross" radxa-zero-3-rk3566_defconfig
"$uboot/scripts/config" --file "$uboot/.config" -e SPL_OPTEE_IMAGE \
    --set-val OPTEE_TZDRAM_SIZE 0x02000000
if [ "$mode" != dev ] && [ "$mode" != rng-lab ] && [ "$mode" != otp-lab ]; then
    "$uboot/scripts/config" --file "$uboot/.config" -e BRIDGEOS_SIGNED_BOOT \
        -d LEGACY_IMAGE_FORMAT -d BOOTSTD -d BOOTSTD_FULL \
        -d BOOTMETH_EXTLINUX -d BOOTMETH_EXTLINUX_PXE \
        -d BOOTMETH_EFILOADER -d BOOTMETH_EFI_BOOTMGR \
        -d BOOTMETH_SCRIPT -d BOOTMETH_DISTRO \
        -d CMD_BOOTI -d CMD_BOOTZ -d CMD_GO -d CMD_ELF -d CMD_SOURCE \
        -d CMD_BOOTEFI -d BOOTM_EFI -d BOOTM_ELF \
        -e AUTOBOOT_KEYED -d AUTOBOOT_KEYED_CTRLC \
        --set-val BOOTDELAY -2 \
        --set-str BOOTCOMMAND 'if mmc dev 1; then if ext4load mmc 1:1 0x10000000 /boot/kernel.itb; then bootm 0x10000000; fi; fi; while true; do reset; sleep 1; done'
fi
make -C "$uboot" olddefconfig CROSS_COMPILE="$uboot_cross"
if [ "$mode" != dev ] && [ "$mode" != rng-lab ] && [ "$mode" != otp-lab ]; then
    for setting in CONFIG_BRIDGEOS_SIGNED_BOOT=y CONFIG_SPL_FIT_SIGNATURE=y CONFIG_FIT_SIGNATURE=y CONFIG_SPL_SHA256=y CONFIG_RSA_VERIFY=y; do
        grep -qx "$setting" "$uboot/.config" || { echo "Signed firmware requires $setting" >&2; exit 1; }
    done
    for forbidden in CONFIG_BOOTSTD=y CONFIG_BOOTMETH_EXTLINUX=y \
        CONFIG_BOOTMETH_EXTLINUX_PXE=y CONFIG_BOOTMETH_EFILOADER=y \
        CONFIG_BOOTMETH_EFI_BOOTMGR=y CONFIG_BOOTMETH_SCRIPT=y \
        CONFIG_BOOTMETH_DISTRO=y CONFIG_LEGACY_IMAGE_FORMAT=y \
        CONFIG_CMD_BOOTI=y CONFIG_CMD_GO=y CONFIG_CMD_SOURCE=y \
        CONFIG_CMD_BOOTEFI=y CONFIG_BOOTM_EFI=y; do
        ! grep -qx "$forbidden" "$uboot/.config" || { echo "Unsigned boot path still enabled: $forbidden" >&2; exit 1; }
    done
    grep -qx 'CONFIG_BOOTDELAY=-2' "$uboot/.config" || { echo 'Autoboot must be uninterruptible' >&2; exit 1; }
    grep -qx 'CONFIG_AUTOBOOT_KEYED=y' "$uboot/.config" || { echo 'Ctrl-C must be disabled during signed boot' >&2; exit 1; }
    ! grep -qx 'CONFIG_AUTOBOOT_KEYED_CTRLC=y' "$uboot/.config" || { echo 'Ctrl-C autoboot escape still enabled' >&2; exit 1; }
    grep -Fqx 'CONFIG_BOOTCOMMAND="if mmc dev 1; then if ext4load mmc 1:1 0x10000000 /boot/kernel.itb; then bootm 0x10000000; fi; fi; while true; do reset; sleep 1; done"' "$uboot/.config" || {
        echo 'Signed boot command does not fail closed' >&2; exit 1;
    }
    # Compile DTBs before binman; the patched U-Boot build rule inserts the
    # kernel verification key in u-boot.dtb, even if make rebuilds that DTB.
    make -C "$uboot" -j"${JOBS:-$(nproc)}" CROSS_COMPILE="$uboot_cross" \
        PYTHON3="$host/bin/python3" BL31="$bl31" TEE="$tee" \
        ROCKCHIP_TPL="$ddr" tools dtbs spl/u-boot-spl.bin
    make -C "$uboot" CROSS_COMPILE="$uboot_cross" u-boot.dtb
    [ "$(fdtget -t s "$uboot/u-boot.dtb" /signature/key-boot required)" = conf ] || {
        echo 'U-Boot control DTB has no required boot key' >&2; exit 1;
    }
fi
if [ "$mode" = dev ] || [ "$mode" = rng-lab ] || [ "$mode" = otp-lab ]; then
    make -C "$uboot" -j"${JOBS:-$(nproc)}" CROSS_COMPILE="$uboot_cross" \
        PYTHON3="$host/bin/python3" BL31="$bl31" TEE="$tee" ROCKCHIP_TPL="$ddr" \
        KBUILD_BUILD_USER=builder KBUILD_BUILD_HOST=build
    cp "$uboot/u-boot-rockchip.bin" "$uboot/u-boot.itb" "$out/"
else
    make -C "$uboot" -j"${JOBS:-$(nproc)}" CROSS_COMPILE="$uboot_cross" \
        PYTHON3="$host/bin/python3" BL31="$bl31" TEE="$tee" ROCKCHIP_TPL="$ddr" \
        BINMAN_INDIRS="$keydir" BINMAN_ALLOW_MISSING= \
        KBUILD_BUILD_USER=builder KBUILD_BUILD_HOST=build
    # The patched .binman_stamp recipe inserts keys after make has rebuilt
    # board DTBs, before binman reads the FIT FDT payloads.
    for dtb in \
        "$uboot/dts/upstream/src/arm64/rockchip/rk3566-radxa-zero-3w.dtb" \
        "$uboot/dts/upstream/src/arm64/rockchip/rk3566-radxa-zero-3e.dtb"; do
        [ "$(fdtget -t s "$dtb" /signature/key-boot required)" = conf ] || {
            echo "Firmware FIT FDT lost its required boot key: $dtb" >&2; exit 1;
        }
    done
    [ "$(fdtget -t s "$uboot/u-boot.dtb" /signature/key-boot required)" = conf ] || {
        echo 'Final U-Boot control DTB lost its required boot key' >&2; exit 1;
    }
    cp "$uboot/u-boot.itb" "$out/u-boot.itb"
    cp "$uboot/u-boot.dtb" "$out/u-boot.dtb"
    # Rockchip mkimage aligns SPL to 4 KiB: binman's logical map omits
    # that padding. Binman also relocates SPL symbols near its tail.
    # Extract the actual FDT after the compiled SPL prefix.
    python3 - "$uboot/idbloader.img" "$uboot/spl/u-boot-spl-nodtb.bin" "$out/u-boot-spl-pubkey.dtb" <<'PY'
import pathlib
import struct
import sys
idblock, code, output = map(pathlib.Path, sys.argv[1:])
data, spl = idblock.read_bytes(), code.read_bytes()
magic = b'\xd0\x0d\xfe\xed'
positions = [i for i in range(len(data)) if data.startswith(magic, i)]
if len(positions) != 1:
    raise SystemExit('Expected one actual SPL public-key DTB inside idblock')
position = positions[0]
if position < len(spl) or data[position - len(spl):position][:4096] != spl[:4096]:
    raise SystemExit('SPL public-key FDT is not attached to the compiled SPL prefix')
size = struct.unpack_from('>I', data, position + 4)[0]
if size < 64 or position + size > len(data):
    raise SystemExit('Invalid embedded SPL FDT length')
output.write_bytes(data[position:position + size])
PY
    [ "$(fdtget -t s "$out/u-boot-spl-pubkey.dtb" /signature/key-boot required)" = conf ] || {
        echo 'Final SPL DTB lost its required firmware key' >&2; exit 1;
    }
    configs="$(fdtget -l "$out/u-boot.itb" /configurations)"
    [ -n "$configs" ] || { echo 'No signed firmware FIT configurations' >&2; exit 1; }
    for config in $configs; do
        [ "$(fdtget -t s "$out/u-boot.itb" "/configurations/$config/signature" sign-images)" = 'firmware loadables fdt' ] || {
            echo "Unsigned firmware/loadables/FDT in $config" >&2; exit 1;
        }
        "$uboot/tools/fit_check_sign" -k "$out/u-boot-spl-pubkey.dtb" \
            -f "$out/u-boot.itb" -c "$config"
    done
    [ -s "$uboot/idbloader.img" ] || { echo 'Missing source-built idblock' >&2; exit 1; }
    cp "$uboot/idbloader.img" "$out/idbloader.img"
    signer="$rkbin/tools/rk_sign_tool"
    ( cd "$out"
      "$signer" cc --chip 3566
      "$signer" lk --key "$keydir/boot.key" --pubkey "$keydir/boot.pubkey"
      "$signer" sb --idb idbloader.img
      "$signer" vb --idb idbloader.img
    )
    python3 - "$out/idbloader.img" "$out/u-boot-spl-pubkey.dtb" <<'PY'
import pathlib
import sys
idblock, trusted = map(pathlib.Path, sys.argv[1:])
data, dtb = idblock.read_bytes(), trusted.read_bytes()
if data.count(b'\xd0\x0d\xfe\xed') != 1 or dtb not in data:
    raise SystemExit('Rockchip idblock signer changed embedded SPL public key')
PY
    fit_offset="$(sed -n 's/^CONFIG_SPL_PAD_TO=//p' "$uboot/.config")"
    [ "$fit_offset" = 0x7f8000 ] || {
        echo 'Signed image FIT offset no longer matches U-Boot SPL layout' >&2; exit 1;
    }
    python3 - "$out/idbloader.img" "$out/u-boot.itb" "$out/u-boot-rockchip.bin" "$fit_offset" <<'PY'
import pathlib
import shutil
import sys

idblock, fit, combined = map(pathlib.Path, sys.argv[1:4])
fit_offset = int(sys.argv[4], 0)
if idblock.stat().st_size > fit_offset:
    raise SystemExit('Signed idblock overlaps firmware FIT')
with combined.open('wb') as image, idblock.open('rb') as loader, fit.open('rb') as firmware:
    shutil.copyfileobj(loader, image)
    remaining = fit_offset - image.tell()
    while remaining:
        block = min(remaining, 4096)
        image.write(b'\xff' * block)
        remaining -= block
    shutil.copyfileobj(firmware, image)
PY
    cmp -n "$(stat -c %s "$out/u-boot.itb")" -i "$((fit_offset)):0" \
        "$out/u-boot-rockchip.bin" "$out/u-boot.itb"
fi
cp "$bl31" "$out/bl31.elf"
cp "$tee" "$out/tee-raw.bin"
if [ "$mode" = dev ] || [ "$mode" = rng-lab ] || [ "$mode" = otp-lab ]; then
    sha256sum "$out"/u-boot-rockchip.bin "$out"/u-boot.itb "$out"/bl31.elf "$out"/tee-raw.bin > "$out/SHA256SUMS"
else
    sha256sum "$out"/u-boot-rockchip.bin "$out"/idbloader.img "$out"/u-boot.itb \
        "$out"/u-boot.dtb "$out"/u-boot-spl-pubkey.dtb "$out"/bl31.elf \
        "$out"/tee-raw.bin > "$out/SHA256SUMS"
fi
echo "RK3566 ZERO 3 OP-TEE firmware: $out/u-boot-rockchip.bin"
