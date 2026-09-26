#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -lt 2 ] || [ "$#" -gt 3 ] || [ "$2" != '--erase-device' ]; then
    echo "Usage: $0 /dev/WHOLE_REMOVABLE_DEVICE --erase-device [production|debug|optee-debug|optee-runtime|signed-lab]" >&2
    exit 2
fi
device="$1"
profile="${3:-production}"
case "$profile" in
    production) out=output ;;
    debug) out=output-debug ;;
    optee-debug) out=output-optee-debug ;;
    optee-runtime) out=output-optee-runtime ;;
    signed-lab) out=output-signed-lab ;;
    *) echo 'Unknown image profile' >&2; exit 2 ;;
esac
project="$(cd "$(dirname "$0")/.." && pwd)"
image="$project/$out/images/radxa-zero3-rt.img"
[ -b "$device" ] && [ -f "$image" ] || { echo 'Block device or image missing' >&2; exit 1; }
[ "$(lsblk -dn -o TYPE "$device")" = disk ] || { echo 'Pass whole disk, not partition' >&2; exit 1; }
[ "$(lsblk -dn -o RM "$device")" = 1 ] || { echo 'Refusing non-removable device' >&2; exit 1; }
mountpoints="$(lsblk -nr -o MOUNTPOINT "$device" | sed '/^$/d')"
[ -z "$mountpoints" ] || { echo 'Device contains mounted filesystem(s)' >&2; exit 1; }
printf 'ERASE %s with %s? Type ERASE: ' "$device" "$image" >&2
read -r answer
[ "$answer" = ERASE ] || exit 1
dd if="$image" of="$device" bs=4M status=progress conv=fsync
image_bytes=$(stat -c %s "$image")
cmp -n "$image_bytes" "$image" "$device"
echo "FLASH VERIFIED: profile=$profile sha256=$(sha256sum "$image" | cut -d' ' -f1)" >&2
sync
