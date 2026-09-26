#!/usr/bin/env bash
set -euo pipefail
project="$(cd "$(dirname "$0")/.." && pwd)"
profile="${1:-production}"
case "$profile" in
    production) config=radxa_zero3_rt_defconfig; out="$project/output" ;;
    debug) config=radxa_zero3_rt_debug_defconfig; out="$project/output-debug" ;;
    optee-debug) config=radxa_zero3_optee_debug_defconfig; out="$project/output-optee-debug" ;;
    optee-runtime) config=radxa_zero3_optee_runtime_defconfig; out="$project/output-optee-runtime" ;;
    *) echo "Usage: $0 [production|debug|optee-debug|optee-runtime]" >&2; exit 2 ;;
esac
"$project/scripts/fetch.sh"
make -C "$project/sources/buildroot" BR2_EXTERNAL="$project" O="$out" "$config"
if [ "$profile" = optee-debug ] || [ "$profile" = optee-runtime ]; then
    make -C "$project/sources/buildroot" BR2_EXTERNAL="$project" O="$out" toolchain -j"${JOBS:-$(nproc)}"
    optee_log_args=()
    if [ "$profile" = optee-runtime ]; then
        optee_log_args=(OPTEE_CORE_LOG_LEVEL=0 OPTEE_TA_LOG_LEVEL=0)
    fi
    env "${optee_log_args[@]}" CROSS_COMPILE64="$out/host/bin/aarch64-buildroot-linux-gnu-" \
        "$project/scripts/build-firmware-optee.sh" dev
fi
firmware="$project/sources/boot-firmware/out/u-boot-rockchip.bin"
if [ ! -s "$firmware" ]; then
    if command -v aarch64-linux-gnu-gcc >/dev/null 2>&1; then
        (cd "$project/sources/boot-firmware" && MAKEFLAGS="-j${JOBS:-$(nproc)}" bash scripts/build/all.sh)
    else
        command -v docker >/dev/null 2>&1 || { echo 'Install aarch64-linux-gnu-gcc or usable Docker for pinned firmware' >&2; exit 1; }
        docker build -t zero3-boot-firmware "$project/sources/boot-firmware"
        mkdir -p "$(dirname "$firmware")"
        docker run --rm -v "$(dirname "$firmware"):/out" -e BUILD_DIR=/build -e OUT_DIR=/out zero3-boot-firmware
    fi
fi
[ -s "$firmware" ] || { echo 'Firmware build did not produce u-boot-rockchip.bin' >&2; exit 1; }
make -C "$project/sources/buildroot" BR2_EXTERNAL="$project" O="$out" -j"$(nproc)"
"$project/scripts/verify.sh" "$out" "$profile"
