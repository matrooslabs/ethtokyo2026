#!/usr/bin/env bash
set -euo pipefail
project="$(cd "$(dirname "$0")/.." && pwd)"
profile="${1:-production}"
export JOBS="${JOBS:-32}"
case "$profile" in
    production) config=radxa_zero3_rt_defconfig; out="$project/output" ;;
    debug) config=radxa_zero3_rt_debug_defconfig; out="$project/output-debug" ;;
    optee-debug) config=radxa_zero3_optee_debug_defconfig; out="$project/output-optee-debug" ;;
    rng-lab) config=radxa_zero3_rng_lab_defconfig; out="$project/output-rng-lab" ;;
    otp-lab) config=radxa_zero3_otp_lab_defconfig; out="$project/output-otp-lab" ;;
    optee-runtime) config=radxa_zero3_optee_runtime_defconfig; out="$project/output-optee-runtime" ;;
    signed-lab) config=radxa_zero3_signed_lab_defconfig; out="$project/output-signed-lab" ;;
    mvp-keyed) config=radxa_zero3_mvp_keyed_defconfig; out="$project/output-mvp-keyed" ;;
    hardware-root) config=radxa_zero3_hardware_root_defconfig; out="$project/output-hardware-root" ;;
    *) echo "Usage: $0 [production|debug|optee-debug|rng-lab|otp-lab|optee-runtime|signed-lab|mvp-keyed|hardware-root]" >&2; exit 2 ;;
esac
if [ "$profile" = hardware-root ]; then
    : "${OSUMANIA_PROVISIONING_RECORD:?hardware-root requires externally reviewed provisioning record}"
    python3 "$project/scripts/prepare-hardware-root.py" "$OSUMANIA_PROVISIONING_RECORD" \
        "$project/sources/optee-os-artifacts/hardware-policy/policy.h" >/dev/null
    echo 'REFUSED hardware-root image: no approved/provisioned RK3566 Secure OTP root slot or qualified Secure World RNG driver. TA-only signing is supported in principle, but signed-lab uses a public development root; ROM enforcement against replacement BL32 is a separate, stronger requirement.' >&2
    exit 1
fi
if [ "$profile" = signed-lab ] || [ "$profile" = mvp-keyed ]; then
    : "${BOOT_SIGN_KEY_DIR:?signed boot requires external boot signing key directory}"
    keydir="$(realpath "$BOOT_SIGN_KEY_DIR")"
    case "$keydir/" in "$(dirname "$project")/"*)
        echo 'Boot signing private key must remain outside the ethtokyo2026 checkout' >&2
        exit 1 ;;
    esac
    for part in boot.key boot.crt boot.pubkey; do
        test -s "$BOOT_SIGN_KEY_DIR/$part" || { echo "Missing boot signing input: $part" >&2; exit 1; }
    done
fi
if [ "$profile" = mvp-keyed ]; then
    : "${OSUMANIA_MVP_DEVICE_KEY_FILE:?mvp-keyed needs external secp256k1 PEM}"
    : "${OSUMANIA_MVP_SRS_BANK:?mvp-keyed needs local BLS12-381 SRS bank matching scoring SRS}"
    : "${OSUMANIA_MVP_SRS_ID:?mvp-keyed needs corresponding smax=22 scoring SRS ID}"
    OSUMANIA_MVP_SRS_SHA256="$(sha256sum "$OSUMANIA_MVP_SRS_BANK" | cut -d' ' -f1)"
    export OSUMANIA_MVP_SRS_SHA256 OSUMANIA_MVP_SRS_ID
    : "${TA_SIGN_KEY:?mvp-keyed needs external TA signing private key}"
    : "${TA_PUBLIC_KEY:?mvp-keyed needs matching TA public key}"
    ta_private_pub="$(openssl pkey -in "$TA_SIGN_KEY" -pubout -outform DER | sha256sum | cut -d' ' -f1)"
    ta_trusted_pub="$(openssl pkey -pubin -in "$TA_PUBLIC_KEY" -outform DER | sha256sum | cut -d' ' -f1)"
    [ "$ta_private_pub" = "$ta_trusted_pub" ] || {
        echo 'TA signing private key does not match embedded public trust key' >&2
        exit 1
    }
    private_dir="$(mktemp -d -p "$(dirname "$OSUMANIA_MVP_DEVICE_KEY_FILE")" .bridgeos-mvp.XXXXXX)"
    trap 'rm -rf -- "$private_dir"' EXIT
    export OSUMANIA_MVP_PRIVATE_HEADER="$private_dir/private.h"
    export OSUMANIA_MVP_POLICY_HEADER="$project/sources/optee-os-artifacts/mvp-policy/policy.h"
    "$project/scripts/prepare-mvp-key.py" \
        "$OSUMANIA_MVP_DEVICE_KEY_FILE" "$OSUMANIA_MVP_SRS_BANK" \
        "$TA_PUBLIC_KEY" "$BOOT_SIGN_KEY_DIR/boot.pubkey" \
        "$OSUMANIA_MVP_POLICY_HEADER" "$OSUMANIA_MVP_PRIVATE_HEADER" \
        "$project/sources/optee-os-artifacts/mvp-policy/mvp-identity.json"
fi
"$project/scripts/fetch.sh"
make -C "$project/sources/buildroot" BR2_EXTERNAL="$project" O="$out" "$config"
if [ "$profile" = optee-debug ] || [ "$profile" = optee-runtime ] || [ "$profile" = rng-lab ] || [ "$profile" = otp-lab ] || [ "$profile" = signed-lab ] || [ "$profile" = mvp-keyed ] || [ "$profile" = hardware-root ]; then
    make -C "$project/sources/buildroot" BR2_EXTERNAL="$project" O="$out" toolchain -j"$JOBS"
    optee_log_args=()
    if [ "$profile" = optee-runtime ] || [ "$profile" = hardware-root ]; then
        optee_log_args=(OPTEE_CORE_LOG_LEVEL=0 OPTEE_TA_LOG_LEVEL=0)
    fi
    mode=dev
    if [ "$profile" = hardware-root ]; then mode=hardware; fi
    if [ "$profile" = signed-lab ]; then mode=signed-lab; fi
    if [ "$profile" = rng-lab ]; then mode=rng-lab; fi
    if [ "$profile" = otp-lab ]; then mode=otp-lab; fi
    if [ "$profile" = mvp-keyed ]; then
        mode=mvp-keyed
        CROSS_COMPILE64="$out/host/bin/aarch64-buildroot-linux-gnu-" \
            "$project/scripts/build-optee.sh" "$mode"
    fi
    env "${optee_log_args[@]}" CROSS_COMPILE64="$out/host/bin/aarch64-buildroot-linux-gnu-" \
        "$project/scripts/build-firmware-optee.sh" "$mode"
fi
firmware="$project/sources/boot-firmware/out/u-boot-rockchip.bin"
if [ ! -s "$firmware" ]; then
    if command -v aarch64-linux-gnu-gcc >/dev/null 2>&1; then
        (cd "$project/sources/boot-firmware" && MAKEFLAGS="-j$JOBS" bash scripts/build/all.sh)
    else
        command -v docker >/dev/null 2>&1 || { echo 'Install aarch64-linux-gnu-gcc or usable Docker for pinned firmware' >&2; exit 1; }
        docker build -t zero3-boot-firmware "$project/sources/boot-firmware"
        mkdir -p "$(dirname "$firmware")"
        docker run --rm -v "$(dirname "$firmware"):/out" -e BUILD_DIR=/build -e OUT_DIR=/out zero3-boot-firmware
    fi
fi
[ -s "$firmware" ] || { echo 'Firmware build did not produce u-boot-rockchip.bin' >&2; exit 1; }
make -C "$project/sources/buildroot" BR2_EXTERNAL="$project" O="$out" -j"$JOBS"
"$project/scripts/verify.sh" "$out" "$profile"
