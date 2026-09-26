#!/usr/bin/env bash
set -euo pipefail
project="$(cd "$(dirname "$0")/.." && pwd)"
profile="${1:-production}"
case "$profile" in
    production) config=radxa_zero3_rt_defconfig; out="$project/output" ;;
    debug) config=radxa_zero3_rt_debug_defconfig; out="$project/output-debug" ;;
    optee-debug) config=radxa_zero3_optee_debug_defconfig; out="$project/output-optee-debug" ;;
    optee-capacity-lab) config=radxa_zero3_optee_capacity_lab_defconfig; out="$project/output-optee-capacity-lab" ;;
    rng-lab) config=radxa_zero3_rng_lab_defconfig; out="$project/output-rng-lab" ;;
    optee-runtime) config=radxa_zero3_optee_runtime_defconfig; out="$project/output-optee-runtime" ;;
    signed-lab) config=radxa_zero3_signed_lab_defconfig; out="$project/output-signed-lab" ;;
    hardware-root) config=radxa_zero3_hardware_root_defconfig; out="$project/output-hardware-root" ;;
    *) echo "Usage: $0 [production|debug|optee-debug|optee-capacity-lab|rng-lab|optee-runtime|signed-lab|hardware-root]" >&2; exit 2 ;;
esac
if [ "$profile" = hardware-root ]; then
    : "${OSUMANIA_PROVISIONING_RECORD:?hardware-root requires externally reviewed provisioning record}"
    python3 "$project/scripts/prepare-hardware-root.py" "$OSUMANIA_PROVISIONING_RECORD" \
        "$project/sources/optee-os-artifacts/hardware-policy/policy.h" >/dev/null
    echo 'REFUSED hardware-root image: no approved/provisioned RK3566 Secure OTP root slot or qualified Secure World RNG driver. TA-only signing is supported in principle, but signed-lab uses a public development root; ROM enforcement against replacement BL32 is a separate, stronger requirement.' >&2
    exit 1
fi
if [ "$profile" = signed-lab ]; then
    : "${BOOT_SIGN_KEY_DIR:?signed-lab requires external boot signing key directory}"
    keydir="$(realpath "$BOOT_SIGN_KEY_DIR")"
    case "$keydir/" in "$(dirname "$project")/"*)
        echo 'Boot signing private key must remain outside the ethtokyo2026 checkout' >&2
        exit 1 ;;
    esac
    for part in boot.key boot.crt boot.pubkey; do
        test -s "$BOOT_SIGN_KEY_DIR/$part" || { echo "Missing boot signing input: $part" >&2; exit 1; }
    done
fi
"$project/scripts/fetch.sh"
make -C "$project/sources/buildroot" BR2_EXTERNAL="$project" O="$out" "$config"
if [ "$profile" = optee-debug ] || [ "$profile" = optee-capacity-lab ] || [ "$profile" = optee-runtime ] || [ "$profile" = rng-lab ] || [ "$profile" = signed-lab ] || [ "$profile" = hardware-root ]; then
    make -C "$project/sources/buildroot" BR2_EXTERNAL="$project" O="$out" toolchain -j"${JOBS:-$(nproc)}"
    optee_log_args=()
    if [ "$profile" = optee-runtime ] || [ "$profile" = hardware-root ]; then
        optee_log_args=(OPTEE_CORE_LOG_LEVEL=0 OPTEE_TA_LOG_LEVEL=0)
    fi
    mode=dev
    if [ "$profile" = hardware-root ]; then mode=hardware; fi
    if [ "$profile" = signed-lab ]; then mode=signed-lab; fi
    if [ "$profile" = rng-lab ]; then mode=rng-lab; fi
    env "${optee_log_args[@]}" CROSS_COMPILE64="$out/host/bin/aarch64-buildroot-linux-gnu-" \
        "$project/scripts/build-firmware-optee.sh" "$mode"
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
