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
optee-debug|optee-runtime|hardware-root|signed-lab|mvp-keyed)
    project="$(cd "$(dirname "$0")/../.." && pwd)"
    mode=dev
    if [ "${2:-}" = hardware-root ]; then mode=hardware; fi
    if [ "${2:-}" = mvp-keyed ]; then mode=mvp-keyed; fi
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
        if [ "${2:-}" = mvp-keyed ]; then
            # Reused Buildroot targets retain previously installed files.
            rm -f "$target/etc/init.d/S99zzdiag" \
                  "$target/etc/osumania-provision.conf" \
                  "$target/usr/bin/osumania-optee-test" \
                  "$target/usr/bin/cyclictest" "$target/usr/bin/cyclicdeadline" \
                  "$target/usr/bin/deadline_test" "$target/usr/bin/hackbench" \
                  "$target/usr/bin/pi_stress" "$target/usr/bin/pip_stress" \
                  "$target/usr/bin/pmqtest" "$target/usr/bin/ptsematest" \
                  "$target/usr/bin/rt-migrate-test" "$target/usr/bin/signaltest" \
                  "$target/usr/bin/sigwaittest" "$target/usr/bin/svsematest" \
                  "$target/usr/bin/queuelat" "$target/usr/bin/ssdd" \
                  "$target/usr/bin/oslat" "$target/usr/bin/determine_maximum_mpps.sh" \
                  "$target/usr/bin/trace-cmd" "$target/usr/bin/stress-ng" \
                  "$target/usr/share/osumania/srs-g1-be.bin" \
                  "$target/usr/share/osumania/srs-manifest.json"
            printf '%s\n' 'OSUMANIA_SIGNER_BACKEND=optee' \
                'OSUMANIA_SRS=/usr/share/osumania/srs-g1-be.bin' > "$target/etc/bridge-rt.conf"
            printf '%s\n' 'mvp-keyed-extractable-ta-key' > "$target/etc/optee-runtime-mode"
            : "${OSUMANIA_MVP_SRS_BANK:?mvp-keyed requires externally sourced OSUMANIA_MVP_SRS_BANK}"
            python3 - "$project" "$OSUMANIA_MVP_SRS_BANK" "$target/usr/share/osumania" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

project, supplied, dest = map(Path, sys.argv[1:])
bank = supplied.resolve(strict=True)
if bank.is_relative_to(project.parent):
    raise SystemExit('MVP SRS must be external to the ethtokyo2026 checkout')
pin = json.loads((project / 'manifests/sources.lock').read_text())['device_srs_ceremony']
points = pin['device_point_count']
if points != 200000 or bank.stat().st_size != points * 64:
    raise SystemExit('MVP SRS must contain exactly 200000 affine G1 points')
with bank.open('rb') as stream:
    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
if digest != pin['device_bank_sha256']:
    raise SystemExit('MVP SRS bank does not match pinned source ceremony hash')
dest.mkdir(parents=True, exist_ok=True)
installed = dest / 'srs-g1-be.bin'
shutil.copyfile(bank, installed)
os.chmod(installed, 0o444)
public = {
    'bytesPerPoint': 64,
    'curve': 'BN254',
    'file': 'srs-g1-be.bin',
    'firstExponent': 0,
    'format': 'G1_AFFINE_BE_XY_V1',
    'pointCount': points,
    'sha256': '0x' + digest,
    'srsId': '0x' + pin['srs_id'],
    'maxEvents': points // 4,
    'keyProtection': 'extractable private scalar compiled into OP-TEE TA; not hardware protected',
    'keyExtractable': True,
    'hardwareRoot': False,
    'bitstreamAttestation': False,
    'otpProvenance': False,
    'romFuseEnforcementVerified': False,
    'bitstreamField': 'deterministic build marker; not FPGA attestation',
}
record = dest / 'srs-manifest.json'
record.write_text(json.dumps(public, sort_keys=True, indent=2) + '\n')
os.chmod(record, 0o444)
PY
        else
            printf '%s\n' 'OSUMANIA_SIGNER_BACKEND=optee' \
                'OSUMANIA_SRS=/usr/share/osumania/srs-g1-be.bin' > "$target/etc/bridge-rt.conf"
        fi
        chmod 0444 "$target/etc/bridge-rt.conf"
    fi
    if [ "${2:-}" = hardware-root ]; then
        srs="$project/sources/optee-os-artifacts/hardware/srs-g1-be.bin"
        test -s "$srs" || { echo 'Approved SRS artifact missing' >&2; exit 1; }
        install -D -m 0444 "$srs" "$target/usr/share/osumania/srs-g1-be.bin"
    fi
;;
rng-lab|otp-lab)
    rm -f "$target/etc/init.d/S99bridge" "$target/etc/bridge-rt.conf" \
          "$target/usr/bin/osumania-optee-test" \
          "$target/lib/optee_armtz/91fc6874-8551-4b42-a95d-6ee4a147f421.ta" \
          "$target/usr/share/osumania/srs-g1-be.bin"
    printf '%s\n' "${2:-}" > "$target/etc/optee-runtime-mode"
;;
*) rm -f "$target/usr/bin/osumania-optee-test" ;;
esac

