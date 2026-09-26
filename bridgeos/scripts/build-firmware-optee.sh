#!/usr/bin/env bash
set -euo pipefail
project="$(cd "$(dirname "$0")/.." && pwd)"
export SOURCE_DATE_EPOCH=1779278600
mode="${1:-dev}"
case "$mode" in
    dev|hardware) "$project/scripts/build-optee.sh" "$mode" ;;
    *) echo "Usage: $0 [dev|hardware]" >&2; exit 2 ;;
esac
firmware="$project/sources/boot-firmware"
build="$firmware/build"
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
rm -f "$out/u-boot-rockchip.bin" "$out/u-boot.itb" "$out/bl31.elf" \
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
tee="$project/sources/optee-os-artifacts/$mode/tee-raw.bin"
git -C "$uboot" reset --hard "$(cat "$firmware/pins/uboot/commit")"
git -C "$uboot" clean -fdx
git -C "$uboot" apply "$project"/board/radxa-zero3-rt/patches/u-boot/*.patch
make -C "$uboot" CROSS_COMPILE="$uboot_cross" mrproper
make -C "$uboot" CROSS_COMPILE="$uboot_cross" radxa-zero-3-rk3566_defconfig
"$uboot/scripts/config" --file "$uboot/.config" -e SPL_OPTEE_IMAGE \
    --set-val OPTEE_TZDRAM_SIZE 0x02000000
make -C "$uboot" olddefconfig CROSS_COMPILE="$uboot_cross"
make -C "$uboot" -j"${JOBS:-$(nproc)}" CROSS_COMPILE="$uboot_cross" \
    PYTHON3="$host/bin/python3" BL31="$bl31" TEE="$tee" ROCKCHIP_TPL="$ddr" \
    KBUILD_BUILD_USER=builder KBUILD_BUILD_HOST=build
cp "$uboot/u-boot-rockchip.bin" "$uboot/u-boot.itb" "$out/"
cp "$bl31" "$out/bl31.elf"
cp "$tee" "$out/tee-raw.bin"
sha256sum "$out"/u-boot-rockchip.bin "$out"/u-boot.itb "$out"/bl31.elf "$out"/tee-raw.bin > "$out/SHA256SUMS"
echo "RK3566 ZERO 3 OP-TEE firmware: $out/u-boot-rockchip.bin"
