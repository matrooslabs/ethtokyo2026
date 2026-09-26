#!/usr/bin/env bash
set -euo pipefail
project="$(cd "$(dirname "$0")/.." && pwd)"
export SOURCE_DATE_EPOCH=1779278600
mode="${1:-dev}"
case "$mode" in dev|hardware) ;; *) echo "Usage: $0 [dev|hardware]" >&2; exit 2 ;; esac
commit=c2b0684fcd89929976a8726e6e3af922b48dd2c7
src="$project/sources/optee-os"
if [ ! -d "$src/.git" ]; then
    git clone https://github.com/OP-TEE/optee_os.git "$src"
fi
git -C "$src" fetch --tags origin
git -C "$src" checkout --detach "$commit"
git -C "$src" reset --hard "$commit"
git -C "$src" clean -fdx
git -C "$src" apply "$project"/board/radxa-zero3-rt/patches/optee-os/*.patch

cross="${CROSS_COMPILE64:-$project/output-debug/host/bin/aarch64-buildroot-linux-gnu-}"
[ -x "${cross}gcc" ] || cross="$project/output/host/bin/aarch64-buildroot-linux-musl-"
[ -x "${cross}gcc" ] || { echo 'Buildroot AArch64 cross compiler missing' >&2; exit 1; }
python="${PYTHON3:-$(command -v python3)}"
huk_offset="${RK3568_HUK_OFFSET:-0xffffffff}"
if [ "$mode" = hardware ] && [ "$huk_offset" = 0xffffffff ]; then
    echo 'hardware mode requires reviewed RK3568_HUK_OFFSET; OTP is never programmed by this script' >&2
    exit 1
fi
py_path="${PYTHONPATH:-$HOME/.local/lib/python3.11/site-packages}"
optee_args=()
if [ "$mode" = dev ]; then
    optee_args+=(CFG_RK3568_DEV_INSECURE_HUK=y)
fi
PYTHONPATH="$py_path" make -C "$src" -j"${JOBS:-$(nproc)}" \
    O=out/arm-plat-rockchip PLATFORM=rockchip PLATFORM_FLAVOR=rk3568 \
    CROSS_COMPILE64="$cross" PYTHON3="$python" CFG_ARM64_core=y \
    CFG_USER_TA_TARGETS=ta_arm64 CFG_RK3568_HUK_OFFSET="$huk_offset" \
    CFG_TEE_CORE_LOG_LEVEL="${OPTEE_CORE_LOG_LEVEL:-2}" \
    CFG_TEE_TA_LOG_LEVEL="${OPTEE_TA_LOG_LEVEL:-2}" "${optee_args[@]}"

sdk="$src/out/arm-plat-rockchip/export-ta_arm64"
ta_args=()
if [ "$mode" = dev ]; then ta_args+=(CFG_OSUMANIA_DEV_INSECURE_KEY=y); fi
PYTHONPATH="$py_path" make -C "$project/optee/osumania_signer/ta" clean \
    TA_DEV_KIT_DIR="$sdk" CROSS_COMPILE="$cross" "${ta_args[@]}"
PYTHONPATH="$py_path" make -C "$project/optee/osumania_signer/ta" -j"${JOBS:-$(nproc)}" \
    TA_DEV_KIT_DIR="$sdk" CROSS_COMPILE="$cross" PYTHON3="$python" "${ta_args[@]}"

out="$project/sources/optee-os-artifacts/$mode"
rm -rf "$out"
mkdir -p "$out"
cp "$src/out/arm-plat-rockchip/core/tee.elf" \
   "$src/out/arm-plat-rockchip/core/tee.bin" \
   "$src/out/arm-plat-rockchip/core/tee-raw.bin" "$out/"
cp "$project/optee/osumania_signer/ta/91fc6874-8551-4b42-a95d-6ee4a147f421.ta" "$out/"
(
    cd "$out"
    sha256sum tee.elf tee.bin tee-raw.bin \
        91fc6874-8551-4b42-a95d-6ee4a147f421.ta > SHA256SUMS
)
echo "OP-TEE RK3568 artifacts: $out"
