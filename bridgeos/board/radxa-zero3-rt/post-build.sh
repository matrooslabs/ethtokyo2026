#!/bin/sh
set -eu
target="$1"
# Fail closed against stale Buildroot target files from earlier configurations.
rm -f "$target/etc/init.d/S01syslogd" "$target/etc/init.d/S02klogd" \
      "$target/etc/init.d/S40network" "$target/sbin/syslogd" \
      "$target/sbin/klogd" "$target/sbin/logread"
rm -rf "$target/usr/lib/systemd"
rm -f "$target/lib/optee_armtz/91fc6874-8551-4b42-a95d-6ee4a147f421.ta"
case "${2:-}" in
optee-debug|optee-runtime|hardware-root|signed-lab)
    project="$(cd "$(dirname "$0")/../.." && pwd)"
    mode=dev
    if [ "${2:-}" = hardware-root ]; then mode=hardware; fi
    ta="$project/sources/optee-os-artifacts/$mode/91fc6874-8551-4b42-a95d-6ee4a147f421.ta"
    test -s "$ta" || { echo "Missing OP-TEE TA: $ta" >&2; exit 1; }
    install -D -m 0444 "$ta" \
        "$target/lib/optee_armtz/91fc6874-8551-4b42-a95d-6ee4a147f421.ta"
    supplicant_init="$target/etc/init.d/S30tee-supplicant"
    test -s "$supplicant_init" || { echo "Missing tee-supplicant init script" >&2; exit 1; }
    sed -i 's|^DAEMON_ARGS=.*|DAEMON_ARGS="-d /dev/teepriv0 -f /run/tee"|' "$supplicant_init"
    if [ "${2:-}" = optee-debug ] || [ "${2:-}" = signed-lab ]; then
        sed -i 's/^OSUMANIA_SIGNER_BACKEND=.*/OSUMANIA_SIGNER_BACKEND=optee/' \
            "$target/etc/bridge-rt.conf"
        printf '%s\n' optee-source-runtime > "$target/etc/optee-runtime-mode"
    else
        rm -f "$target/etc/bridge-rt.conf"
        printf '%s\n' 'OSUMANIA_SIGNER_BACKEND=optee' \
            'OSUMANIA_SRS=/usr/share/osumania/srs-g1-be.bin' > "$target/etc/bridge-rt.conf"
        chmod 0444 "$target/etc/bridge-rt.conf"
    fi
    if [ "${2:-}" = hardware-root ]; then
        srs="$project/sources/optee-os-artifacts/hardware/srs-g1-be.bin"
        test -s "$srs" || { echo 'Approved SRS artifact missing' >&2; exit 1; }
        install -D -m 0444 "$srs" "$target/usr/share/osumania/srs-g1-be.bin"
    fi
;;
*) rm -f "$target/usr/bin/osumania-optee-test" ;;
esac

