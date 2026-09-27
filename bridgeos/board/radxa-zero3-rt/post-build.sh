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
                  "$target/usr/share/osumania/srs-g1-bls12381.bin" \
                  "$target/usr/share/osumania/srs-manifest.json"
            printf '%s\n' 'OSUMANIA_SIGNER_BACKEND=optee' \
                'OSUMANIA_SRS=/usr/share/osumania/srs-g1-bls12381.bin' > "$target/etc/bridge-rt.conf"
            printf '%s\n' 'mvp-keyed-extractable-ta-key' > "$target/etc/optee-runtime-mode"
            : "${OSUMANIA_MVP_SRS_BANK:?mvp-keyed requires a generated BLS12-381 device bank}"
            : "${OSUMANIA_MVP_SRS_SHA256:?mvp-keyed requires the bank SHA-256 pinned in the TA}"
            : "${OSUMANIA_MVP_SRS_ID:?mvp-keyed requires the corresponding scoring SRS ID}"
            python3 - "$OSUMANIA_MVP_SRS_BANK" "$target/usr/share/osumania" "$OSUMANIA_MVP_SRS_SHA256" "$OSUMANIA_MVP_SRS_ID" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

supplied, dest = map(Path, sys.argv[1:3])
expected_hash, srs_id = (v.removeprefix('0x').lower() for v in sys.argv[3:5])
bank = supplied.resolve(strict=True)
points = 200000
if bank.stat().st_size != points * 48:
    raise SystemExit('Mode B bank must contain exactly 200000 compressed BLS12-381 G1 points')
with bank.open('rb') as stream:
    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
if digest != expected_hash or len(srs_id) != 64 or any(c not in '0123456789abcdef' for c in srs_id):
    raise SystemExit('Mode B bank hash/SRS ID does not match the supplied SRS provisioning record')
dest.mkdir(parents=True, exist_ok=True)
installed = dest / 'srs-g1-bls12381.bin'
shutil.copyfile(bank, installed)
os.chmod(installed, 0o444)
public = {
    'bytesPerPoint': 48,
    'curve': 'BLS12-381',
    'file': 'srs-g1-bls12381.bin',
    'firstExponent': 0,
    'format': 'G1_ZCASH_COMPRESSED_V1',
    'pointCount': points,
    'sha256': '0x' + digest,
    'srsId': '0x' + srs_id,
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
                'OSUMANIA_SRS=/usr/share/osumania/srs-g1-bls12381.bin' > "$target/etc/bridge-rt.conf"
        fi
        chmod 0444 "$target/etc/bridge-rt.conf"
    fi
    if [ "${2:-}" = hardware-root ]; then
        srs="$project/sources/optee-os-artifacts/hardware/srs-g1-bls12381.bin"
        test -s "$srs" || { echo 'Approved BLS12-381 SRS bank missing' >&2; exit 1; }
        install -D -m 0444 "$srs" "$target/usr/share/osumania/srs-g1-bls12381.bin"
    fi
;;
rng-lab|otp-lab)
    rm -f "$target/etc/init.d/S99bridge" "$target/etc/bridge-rt.conf" \
          "$target/usr/bin/osumania-optee-test" \
          "$target/lib/optee_armtz/91fc6874-8551-4b42-a95d-6ee4a147f421.ta" \
          "$target/usr/share/osumania/srs-g1-be.bin" \
          "$target/usr/share/osumania/srs-g1-bls12381.bin"
    printf '%s\n' "${2:-}" > "$target/etc/optee-runtime-mode"
;;
*) rm -f "$target/usr/bin/osumania-optee-test" ;;
esac

