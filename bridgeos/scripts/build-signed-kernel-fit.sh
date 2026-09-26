#!/usr/bin/env bash
# Build only the authenticated kernel handoff. Never programs OTP or boot fuses.
set -euo pipefail
if [ "$#" -ne 7 ]; then
    echo "Usage: $0 Image board.dtb rootfs.cpio.gz BOOT_SIGN_KEY_DIR trusted-u-boot.dtb output.itb signed-lab|hardware-root" >&2
    exit 2
fi
case "$7" in signed-lab|hardware-root) profile="$7" ;; *) echo 'Unsupported signed boot profile' >&2; exit 2 ;; esac
project="$(cd "$(dirname "$0")/.." && pwd)"
image="$(realpath "$1")"
dtb="$(realpath "$2")"
initrd="$(realpath "$3")"
keys="$(realpath "$4")"
trusted="$(realpath "$5")"
out="$(realpath -m "$6")"
mkimage="$project/sources/boot-firmware/build/u-boot/tools/mkimage"
checker="$project/sources/boot-firmware/build/u-boot/tools/fit_check_sign"
for file in "$image" "$dtb" "$initrd" "$keys/boot.key" "$keys/boot.crt" "$trusted" "$mkimage" "$checker"; do
    [ -s "$file" ] || { echo "Missing signed-boot input: $file" >&2; exit 1; }
done
[ "$out" != "$image" ] && [ "$out" != "$dtb" ] && [ "$out" != "$initrd" ] || {
    echo 'Refusing to overwrite input images' >&2; exit 1;
}
[ "$(fdtget -t s "$trusted" /signature/key-boot required)" = conf ] || {
    echo 'Trusted U-Boot DTB must require signed configurations' >&2; exit 1;
}
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp "$image" "$tmp/Image"
cp "$dtb" "$tmp/board.dtb"
cp "$initrd" "$tmp/rootfs.cpio.gz"
# The boot arguments reside in the signed FDT. U-Boot must not override them
# from mutable environment or offer a raw boot/extlinux escape hatch.
fdtput -t s "$tmp/board.dtb" /chosen bootargs "console=ttyS2,1500000n8 loglevel=3 rdinit=/init ro bridgeos.profile=$profile"
cat > "$tmp/kernel.its" <<'EOF'
/dts-v1/;
/ {
    description = "ZERO 3W authenticated PREEMPT_RT kernel + initramfs";
    #address-cells = <1>;
    images {
        kernel-1 {
            description = "arm64 Image";
            data = /incbin/("Image");
            type = "kernel";
            arch = "arm64";
            os = "linux";
            compression = "none";
            load = <0x02080000>;
            entry = <0x02080000>;
            hash-1 { algo = "sha256"; };
        };
        fdt-1 {
            description = "RK3566 ZERO 3W";
            data = /incbin/("board.dtb");
            type = "flat_dt";
            arch = "arm64";
            compression = "none";
            hash-1 { algo = "sha256"; };
        };
        ramdisk-1 {
            description = "read-only appliance initramfs";
            data = /incbin/("rootfs.cpio.gz");
            type = "ramdisk";
            arch = "arm64";
            os = "linux";
            compression = "none";
            hash-1 { algo = "sha256"; };
        };
    };
    configurations {
        default = "conf-1";
        conf-1 {
            description = "authenticated ZERO 3W";
            kernel = "kernel-1";
            fdt = "fdt-1";
            ramdisk = "ramdisk-1";
            signature-1 {
                algo = "sha256,rsa2048";
                key-name-hint = "boot";
                sign-images = "kernel", "fdt", "ramdisk";
            };
        };
    };
};
EOF
(
    cd "$tmp"
    SOURCE_DATE_EPOCH=1779278600 "$mkimage" -f kernel.its -k "$keys" -r kernel.itb >/dev/null
)
"$checker" -f "$tmp/kernel.itb" -k "$trusted" -c conf-1 >/dev/null
install -m 0644 "$tmp/kernel.itb" "$out"
echo "SIGNED KERNEL FIT VERIFIED: $out"
