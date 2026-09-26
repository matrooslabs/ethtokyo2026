#!/usr/bin/env bash
set -euo pipefail
board_dir="$(cd "$(dirname "$0")" && pwd)"
project="$(cd "$board_dir/../.." && pwd)"
profile="${2:-production}"
case "$profile" in
	production)
		firmware="$project/sources/boot-firmware/out/u-boot-rockchip.bin"
		image_cfg="$board_dir/genimage.cfg" ;;
	debug)
		# Keep diagnostics on the same firmware proven to boot this board.
		# OP-TEE BL32 remains an explicit hardware-validation artifact until
		# BL31 -> BL32 hand-off is demonstrated on RK3566.
		firmware="$project/sources/boot-firmware/out/u-boot-rockchip.bin"
		image_cfg="$board_dir/genimage-debug.cfg" ;;
    optee-debug)
        firmware="$project/sources/boot-firmware/out-optee-dev/u-boot-rockchip.bin"
        image_cfg="$board_dir/genimage-debug.cfg" ;;
    optee-runtime)
        firmware="$project/sources/boot-firmware/out-optee-dev/u-boot-rockchip.bin"
        image_cfg="$board_dir/genimage.cfg" ;;
    hardware-root)
        firmware="$project/sources/boot-firmware/out-optee-hardware/u-boot-rockchip.bin"
        image_cfg="$board_dir/genimage.cfg" ;;
    signed-lab)
        firmware="$project/sources/boot-firmware/out-optee-signed-lab/u-boot-rockchip.bin"
        image_cfg="$board_dir/genimage-debug.cfg" ;;
	*) echo "Unknown post-image profile: $profile" >&2; exit 2 ;;
esac
: "${BINARIES_DIR:?Buildroot BINARIES_DIR is required}"
: "${BUILD_DIR:?Buildroot BUILD_DIR is required}"
: "${ZERO3_DTB:=rk3566-radxa-zero-3w-rt.dtb}"
test -s "$firmware" || { echo "Missing source-built firmware: $firmware" >&2; exit 1; }
test "$(stat -c %s "$firmware")" -lt $((16*1024*1024-32*1024)) || { echo 'Firmware overlaps boot partition' >&2; exit 1; }
test -s "$BINARIES_DIR/Image" && test -s "$BINARIES_DIR/$ZERO3_DTB" && test -s "$BINARIES_DIR/rootfs.cpio.gz" || { echo 'Missing kernel, board DTB or initramfs' >&2; exit 1; }
cp "$firmware" "$BINARIES_DIR/u-boot-rockchip.bin"
boot="$BUILD_DIR/zero3-boot-files"
rm -rf "$boot"
if [ "$profile" = hardware-root ] || [ "$profile" = signed-lab ]; then
    : "${BOOT_SIGN_KEY_DIR:?signed boot requires externally held boot-signing keys}"
    mode=hardware
    if [ "$profile" = signed-lab ]; then mode=signed-lab; fi
    trusted="$project/sources/boot-firmware/out-optee-$mode/u-boot.dtb"
    test -s "$trusted" || { echo 'Signed U-Boot control DTB missing' >&2; exit 1; }
    "$project/scripts/build-signed-kernel-fit.sh" \
        "$BINARIES_DIR/Image" "$BINARIES_DIR/$ZERO3_DTB" "$BINARIES_DIR/rootfs.cpio.gz" \
        "$BOOT_SIGN_KEY_DIR" "$trusted" "$BINARIES_DIR/kernel.itb" "$profile"
    mkdir -p "$boot/boot"
    cp "$BINARIES_DIR/kernel.itb" "$boot/boot/kernel.itb"
else
    mkdir -p "$boot/boot/extlinux"
    cp "$BINARIES_DIR/Image" "$BINARIES_DIR/$ZERO3_DTB" "$BINARIES_DIR/rootfs.cpio.gz" "$boot/boot/"
    cat > "$boot/boot/extlinux/extlinux.conf" <<EOF
DEFAULT rt
TIMEOUT 0
LABEL rt
    LINUX /boot/Image
    FDT /boot/$ZERO3_DTB
    INITRD /boot/rootfs.cpio.gz
    APPEND console=ttyS2,1500000n8 earlycon loglevel=7 root=/dev/ram0 rdinit=/init ro bridgeos.profile=$profile
EOF
fi
rm -rf "$BUILD_DIR/genimage.tmp"
E2FSPROGS_FAKE_TIME=1779278600 genimage --rootpath "$boot" --tmppath "$BUILD_DIR/genimage.tmp" --inputpath "$BINARIES_DIR" --outputpath "$BINARIES_DIR" --config "$image_cfg"
test "$(stat -c %s "$BINARIES_DIR/radxa-zero3-rt.img")" -le $((128*1024*1024)) || { echo 'Image exceeds 128 MiB size ceiling' >&2; exit 1; }
