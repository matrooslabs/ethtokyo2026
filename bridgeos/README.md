# Radxa ZERO 3W real-time USB HID appliance

Buildroot external tree for an arm64 PREEMPT_RT kernel, storage-independent initramfs, two-function ConfigFS HID gadget, source-built mainline U-Boot/TF-A firmware and directly flashable SD image. The rootfs is immutable on disk but writable in RAM; `/run` is tmpfs. A user has reported board boot and **missing PC-side OTG enumeration**; no board logs or latency measurements have been captured here.

## Rebuild

Host: Linux, Docker (or an equivalent local cross-toolchain for the pinned boot firmware), Buildroot dependencies including C/C++ compiler, make, git, bison, flex, Perl, Python 3, tar, gzip, patch, and sufficient free disk. Source identities in `manifests/sources.lock`; only the pinned rkbin DDR-init blob is opaque. The wrapper checks the pinned Buildroot and firmware commits. Buildroot downloads the kernel at the exact pinned Git SHA.

```sh
./scripts/build.sh production
# or make
./scripts/build.sh debug
# Source OP-TEE 4.9 diagnostic image
./scripts/build.sh optee-debug
# Source OP-TEE 4.9 runtime image
./scripts/build.sh optee-runtime
./scripts/verify.sh output production
(cd output/images && sha256sum -c SHA256SUMS)
```

```sh
# Canonical protocol/SHA/BN254/signing regression checks
./tests/check_bridge.py

# Corrected RK3566 BL32 + TF-A(opteed) + U-Boot FIT is built automatically by:
./scripts/build.sh optee-debug
```

## macOS Vendor HID TA check

Install Python hidapi and query `GET_INFO` through the `0xff60:0x0001` Vendor HID collection:

```sh
python3 -m pip install --user hidapi
python3 tools/macos-vendor-hid-get-info.py --list
python3 tools/macos-vendor-hid-get-info.py
# machine-readable output
python3 tools/macos-vendor-hid-get-info.py --json
```

The default VID:PID is `d86a:1000`; override with `--vid 0xNNNN --pid 0xNNNN`. A successful response prints `TA startup: OK` only after `TEEC_OpenSession` and the TA-backed `OSUMANIA_TA_GET_DEVICE` command succeed. `GET_STATUS` alone is not accepted as TA proof. `OSUM_NOT_READY` with `detail=SRS` means the USB gadget and Normal World daemon work but the TA signer or SRS is unavailable.

For full commitment verification, copy `tools/macos-vendor-hid-get-info.py` (or `info.py`) and `tools/macos-vendor-hid-signing-test.py` (or `sign.py`) to the Mac. The development image (`max_events=65`) uses the bundled 260-point `tests/vendor-hid/vectors/srs-g1-be.bin`; copy that file as `srs-g1-be.bin` beside `sign.py`. The `mvp-keyed` image (`max_events=50000`) instead needs its **200,000-point, 12,800,000-byte** SRS bank (not the development fixture) and `output-mvp-keyed/images/mvp-identity.json` copied from the **same image build**. The ceremony-derived bank on this build host is `/tmp/zero3-pse-device-srs-200k.bin`, SHA-256 `a5d4aebef0045376737ba894f3be285fe6dcadecd5b0f1273fc35b8e44630fe9`. `--identity` pins the expected device address, public build marker, SRS hash and 50,000-event contract cap; a full run hashes the entire local SRS bank and recomputes `C_E` from the received trace.

```sh
python3 -m pip install hidapi pycryptodome
# Full keyed-image verification, after copying the public identity and matching bank to the Mac:
python3 sign.py --identity ./mvp-identity.json --capture-seconds 5 --min-events 4 \
  --srs ./zero3-pse-device-srs-200k.bin
# Immediate keyed-image signing smoke without the bank (NOT commitment verification):
python3 sign.py --identity ./mvp-identity.json --capture-seconds 5 --min-events 4 --signature-only
```

`--signature-only` still validates the recorded trace, SHA trace root and recovered secp256k1 signature/address. It explicitly marks the BN254 commitment **unchecked**; do not use that result as proof of a verified score. The device's self-reported SRS hash alone is not an approval source.


Production artifacts live in `output/images/` (`radxa-zero3-rt.img`, `boot.ext4`, firmware, `Image`, ZERO 3W DTB, initramfs, saved configs and checksums). `output-debug/images/radxa-zero3-rt.img` is a **125,849,600-byte** diagnostic image with benchmark tools plus an 8 MiB FAT partition `RTDIAG` readable by macOS after removing the SD card. Its startup script is configured to write one boot snapshot (`STATUS.TXT`, `STARTUP.TXT`, `DMESG.TXT`) if init reaches it and mounts the partition; this has not yet been observed on a board. Production never mounts a writable diagnostics filesystem. Both profiles use user-supplied `d86a:1000` (assignment not independently verified). Flash a checked removable whole disk with `./scripts/flash.sh /dev/<DISK> --erase-device debug` for diagnosis, or omit `debug` for production. See `docs/usb-topology.md` for interpretation.

## Boot and roles

Earlier board snapshots showed two fixed startup blockers: false ConfigFS `UDC` binding detection, then missing host IRQ discovery. After those corrections the user reported functioning keyboard forwarding on macOS. An interval=1 experiment subsequently caused no forwarded input; reverting via an optional interval path still failed by user report. The current production image **restores the original gadget script exactly and has the same SHA-256 as the pre-experiment production image**. This establishes the on-disk bytes are identical, but does not explain the later macOS/board behavior; runtime report counts and host HID interpretation must be separated with the matching debug profile.

The selected kernel is Radxa `linux-6.18.2` at `559f4f921a01e5358602153364c618fe2a3e431e`. The older 6.1 candidate did not expose arm64 `ARCH_SUPPORTS_RT`; blindly setting `PREEMPT_RT` there would not produce an RT kernel. Build-time verification rejects that state. The production fragment retains the board's upstream arm64 baseline rather than starting from tinyconfig. Kernel and userspace feature trimming beyond verified board bring-up remains dependent on hardware measurement.

Production and debug images now use the same firmware baseline that boots the user's ZERO 3W. Debug adds diagnostics and the explicitly insecure 260-point development SRS (`maxEvents=65`), but does not automatically install the unverified RK3566 OP-TEE BL32. `./scripts/build-firmware-optee.sh dev` still produces the separate source-built BL32 artifact for later hardware bring-up; QEMU CA/TA validation remains passing.

## Build verification on this host

`./scripts/build.sh production`, `./scripts/build.sh debug`, both static verifiers, `./tests/check_bridge.py`, the RK3566 OP-TEE firmware build, and the QEMU CA/TA invocation passed. Production: `Image` 40,585,728 bytes, `rootfs.cpio.gz` 13,807,189 bytes, DTB 113,265 bytes, firmware 9,588,224 bytes, flash image **117,460,992 bytes**, image SHA-256 `b674a9c2f39e2cd1c96c6aa5c2291319fd985f0d5b0d3defed513725b12d336a`. Kernel `.config` SHA-256 is `02cb58a29a3988611d07cc6a0ab1d8bef0c4203516f81795114ed526a24e5803`.

Debug forwarding image: `output-debug/images/radxa-zero3-rt.img`, SHA-256 `03ef002934958ff35b77694fdc951c71cba2c4ae1c6a0d0bf49ba4e86e55475a`. RT-policy discovery failures now warn but cannot suppress daemon startup. Keyboard endpoint backpressure uses a fixed 1024-transition queue instead of overwriting one pending report, gadget disconnect loops back off, and held-key state is resubmitted after PC reconnect.

Source OP-TEE forwarding image: `output-optee-debug/images/radxa-zero3-rt.img`, SHA-256 `370991499786820e197bbac67260141ba36b67e7c6690b50000ba5ae183ae221`. It uses source OP-TEE 4.9.0, static BL31, contiguous `tee-raw.bin`, explicit 32 MiB TZDRAM plus 4 MiB shared-memory reservations, and the current OP-TEE TA ABI. The bridge selects the OP-TEE signer, logs exact context/session/invoke result and origin values, and keeps keyboard forwarding active after TEE failure. A standalone smoke runs only when bridge TA acquisition failed, so it provides a second exact error without racing an active bridge-owned TA.

Stable source-TEE runtime image: `output-optee-runtime/images/radxa-zero3-rt.img`, SHA-256 `be23d520406835c540924f05f1beeb8e473408546883334330d2ed4f1e486376`. The `GENERIC/origin=TEE` loader failure had two concrete REE-FS blockers: bootstrap TA rollback database `ta_ver.db` required a HUK, while development mode had none; and tee-supplicant defaulted to `/data/tee` on a read-only appliance root. Development mode now supplies an explicit manifest-hashed insecure HUK and routes REE-FS to volatile writable `/run/tee`. Hardware mode still requires a reviewed OTP HUK offset and cannot fall back. TA initialization remains fail-closed and diagnostic. This is a development stability image, not production trust.

Hardware verification: macOS Vendor HID `GET_INFO` succeeded on the ZERO 3W with device address `0xf15e068b7a61cc36391fab39512fd9e6f9c9e8f0`, expected development bitstream/policy/SRS hashes, and `max_events=65`. This proves source OP-TEE 4.9 driver/core operation, tee-supplicant RPC, bootstrap TA loading and rollback DB access, TA signature/ELF initialization, `TA_CreateEntryPoint`, `TEEC_OpenSession`, and `OSUMANIA_TA_GET_DEVICE`. It does not yet prove the full stateful signing flow or production trust.

The opaque rkbin `rk3568_bl32_v2.16.bin` is never packaged. It is retained only as a disassembly reference for RK3566 register addresses, secure-memory layout and platform behavior; all executable TEE/TA paths use source OP-TEE 4.9 and its current Internal API ABI.

## Signed-boot laboratory image (no OTP changes)

`signed-lab` keeps the explicitly insecure development HUK/TA and adds externally keyed signed idblock, SPL firmware FIT, and kernel/DTB/initramfs FIT. It tests boot-chain packaging on SD **before** any OTP or Secure Boot fuses are programmed; it does not establish ROM enforcement or a hardware identity. The pinned `rk_sign_tool` is an opaque host-side utility, not boot firmware.

Generate the lab signing key **once** outside the checkout; do not reuse it as a production trust key. On subsequent builds, run only the final `BOOT_SIGN_KEY_DIR=... ./scripts/build.sh signed-lab` line with the same keys. Regenerating keys changes the firmware trust anchor.

```sh
mkdir -m 700 "$HOME/zero3-signed-lab-keys"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$HOME/zero3-signed-lab-keys/boot.key"
openssl req -batch -new -x509 -key "$HOME/zero3-signed-lab-keys/boot.key" -out "$HOME/zero3-signed-lab-keys/boot.crt" -subj '/CN=ZERO3-SIGNED-LAB-ONLY'
openssl pkey -in "$HOME/zero3-signed-lab-keys/boot.key" -pubout -out "$HOME/zero3-signed-lab-keys/boot.pubkey"
BOOT_SIGN_KEY_DIR="$HOME/zero3-signed-lab-keys" ./scripts/build.sh signed-lab
```

Flash `output-signed-lab/images/radxa-zero3-rt.img` with Etcher on the separate macOS computer. This profile includes `RTDIAG` for boot results and uses the same development signing identity as `optee-debug`. If it does not boot, return to the earlier unsigned debug image; **do not burn fuses to make a failing lab image boot**. Run `python3 tests/test_idblock_signature.py` and `python3 tests/test_signed_kernel_fit.py` on the Linux build host for offline tamper checks.

The build publishes `output-signed-lab/images/boot-key-identity.json`, proving that signed SPL and U-Boot proper carry the same required public verification key. Its `public_modulus_sha256` is **not** an RK3566 ROM fuse payload. The RK3588-only Secure Boot PTA in OP-TEE 4.9 cannot be used to program the ZERO 3W; consult `docs/hardware-key-provisioning.md` before any factory provisioning.

On macOS, check `shasum -a 256 radxa-zero3-rt.img`, flash it with Etcher, boot the ZERO 3W and inspect the SD card's `RTDIAG/STARTUP.TXT`, `STATUS.TXT`, and `OPTEE.TXT`. If the board reaches Linux and enumerates the HID gadget, run `python3 tools/macos-vendor-hid-get-info.py`; it must report the **development** `max_events=65`, not a production identity. The full signing test remains `python3 tools/macos-vendor-hid-signing-test.py --capture-seconds 8 --min-events 4`. A boot failure before Linux leaves RTDIAG empty; that is a blocker, not evidence of fuse enforcement.

Observed on the user's ZERO 3W with the signed-lab image: boot succeeded; macOS Vendor HID signing script completed with **38 captured events**, `D=5,005,695 µs`, SHA trace root `f627b24865d6f1be0cdd88608ca5586c6490134b8a83093a651633d46e6b1368`, low-s signature (`v=28`) and recovered address `0xf15e068b7a61cc36391fab39512fd9e6f9c9e8f0` equal to GET_INFO. That script version did **not** recompute the BN254 commitment. The updated script checks it using the matching development SRS; the reported 38-event session cannot be retrospectively checked without its 14-byte GET_TRACE records. ROM fuse enforcement, device-unique HUK and forwarding latency remain unverified.

A subsequent user-run Mac session captured **25 events**, `D=5,010,458 µs`, low-s `v=28`, and recovered the same development address. The updated script independently recomputed both `traceRoot=df2297b4b6d10dfe5d64eb45fd9c710d60d0063ad278433b2a794ae1f6bb5279` and `C_E=1356e49073bacb2b2ceef484210e5b1b56fc58a0262cbd74fa8afdaa600be94109cdb58b34bf3569c30b03d4d621ec1d4e5167ed4225048cf482a7b18912d350` against the trusted 260-point dev SRS. This is an observed signed-lab functional result, not fused ROM trust or device-unique key evidence.

The rebuilt signed-lab U-Boot config has `BOOTDELAY=-2`, `AUTOBOOT_KEYED=y`, Ctrl-C interruption disabled during bootcmd, and a fixed SD `kernel.itb` boot followed by an endless reset loop if loading or signature verification returns. The compiled `u-boot.bin` contains that bootcmd. **This new failure path has not been exercised on the user's board.** An invalid FIT or missing SD may reset repeatedly and cannot write RTDIAG before Linux. Do not enroll the lab signing key hash in ROM fuses.

The user subsequently reported that the rebuilt signed-lab image **works on the ZERO 3W**. This confirms its normal boot path at the stated observation level; no deliberately altered FIT has been booted, so the reset-on-failure branch and ROM fuse enforcement remain hardware-unverified.

Optional **unfused laboratory board, spare SD card only**: on the Linux build host run `python3 scripts/make-tampered-fit-image.py --out /tmp/zero3-TEST-ONLY-invalid-FIT.img`. The script copies the signed-lab image, changes exactly one byte in `/boot/kernel.itb`'s ramdisk payload, independently confirms `fit_check_sign` rejects it, and leaves the original image/firmware/GPT unchanged. Flash **that separate test image** with Etcher on the spare card. Expected behavior is no Linux/HID enumeration and repeated reset; there will be no RTDIAG if Linux never starts. If it boots normally, stop: signature enforcement is broken. Reflash the known-good image afterward. This checks U-Boot's rejection path, **not** RK3566 BootROM fuse enforcement; do not perform it after irreversible provisioning.

Repeated builds with the **same boot key and pinned sources** produced identical `Image`, `tee-raw.bin` and signed U-Boot FIT, but different signed TA and idblock bytes: their RSA-PSS signing is randomized. Those differences propagate into `rootfs.cpio.gz`, kernel FIT and whole image. Use the `SHA256SUMS` from **that exact build**; do not expect a previous image hash after rebuilding. This is source/input reproducibility, not bit-for-bit image reproducibility.

## Hardware-root signing profile

`./scripts/build.sh hardware-root` and direct `./scripts/build-optee.sh hardware` **refuse to emit an image**. `signed-lab` now has signed idblock, firmware FIT, and kernel FIT, but uses a disposable **development HUK** and no verified ROM trust-anchor fuse: its signatures do not prevent alternate SD firmware on an unfused ZERO 3W. With the present raw Secure OTP reader, an alternate BL32 can export the HUK. A qualified Secure World RNG, approved OTP slot/write-lock procedure, ROM-enforced signed loader/recovery policy, debug lock, persistent rollback storage, and hardware boot proof are still required before factory-only on-chip HUK generation. No OTP write occurs. Existing `optee-runtime` is development-only despite successful GET_INFO. See `docs/hardware-key-provisioning.md`.

For the requested **Linux cannot see the signing key; a trusted TA signs only the session preimage** boundary, an on-chip Secure OTP root plus OP-TEE TA is sufficient in principle; an on-chip secp256k1 accelerator and ROM fuse enrollment are not prerequisites for that narrower model. The current TA already derives a scalar and signs inside Secure World, but only from the public development root. A truthful hardware-key image still requires a verified RK3566 customer Secure OTP slot/provisioning state and a qualified Secure World RNG; neither has been established for this board/build. ROM enforcement is required for the stronger claim that replacing BL32 on removable media cannot expose the root.

The [Rockchip OTP developer guide](https://raw.githubusercontent.com/DeciHD/rockchip_docs/main/rv1103_rv1106/RV1106_EN/security/Rockchip_Developer_Guide_OTP_EN.pdf#page=7) confirms a 224-byte **Protected OEM Zone** for RK3566/RK3568. Offline reverse analysis maps its TA-relative range to Secure OTP bytes `0x2A0–0x37F` and four separate OEM cipher-key slots to `0x200–0x27F`. Source OP-TEE's **read-only** lab observer checks only zero/nonzero status; no key is generated or programmed, and RK3566 write lock is unsupported. The `rng-lab` image is a separate no-key TRNG control observer whose start acknowledgment is not entropy proof. See `docs/hardware-key-provisioning.md`.

`rng-lab` intentionally omits `S99bridge`, so **no OTG/HID device enumerates on the PC**; this alone says nothing about whether Linux booted. After Linux `/init` reaches BusyBox init and runs `S99zzdiag start`, that script waits **60 seconds**, finds the `RTDIAG` partition, writes `STATUS.TXT` once, calls `sync`, and unmounts. Allow at least ~90 seconds after power-on before powering down and reading `RTDIAG` from the SD card on the Mac. An empty partition means diagnostics did not complete, not that the RNG was tested.

`output-otp-lab/images/radxa-zero3-rt.img` is a separate **unsigned, no-key, no-TA** spare-SD diagnostic with no OTG gadget. Source OP-TEE reads the first Protected OEM 16 bytes (`0x2A0–0x2AF`) and each of four separate OEM cipher-key slots (`0x200`, `0x220`, `0x240`, `0x260`; 32 bytes each) **twice**. Only status and a four-bit nonzero mask—not any OTP bytes—reach `RTDIAG/STATUS.TXT`. Wait at least ~90 seconds after power-on: `otp_lab_status=0x4F545004` means the first Protected OEM 16 bytes read zero twice; `oem_key_slots=0x4B455900` means all four OEM key slots read zero twice, low nibble `1..F` marks nonzero slots, `...FE/FF` means inconsistent reads/read error. A nonzero slot is **not** proof of a known secure sealing key. These results do not authorize an irreversible OTP burn or constitute a signing image. Restore the known-good SD after testing.

Device/TA/GET_TRACE accept the current on-chain **50,000-event** limit when given 200,000 BN254 G1 points. The verified PSE ceremony-derived bank is external (`manifests/sources.lock` SHA-256 `a5d4aebef0045376737ba894f3be285fe6dcadecd5b0f1273fc35b8e44630fe9`); `tools/convert-ppot-srs.py` reproduces it from the pinned 0080 power-22 transcript and the matching scoring SRS/G2 ID. A host-only protocol smoke covers event 50,000, signed result, 700,000-byte trace and event 50,001 overflow (`python3 tests/bridge-capacity.py`). The on-chain charts still cap at 10,000 notes. Physical throughput is unverified.

## Explicit extractable-key MVP image (not a hardware root)

`mvp-keyed` is a separate signed-boot image without RTDIAG, debugfs, diagnostic init scripts, RT benchmark tools or the development signer backend. It embeds an external secp256k1 scalar in the signed OP-TEE TA and packages the PSE 200,000-point bank. **Anyone with the SD image can extract and reuse this private key.** Neither secure hardware identity, ROM fuse enforcement, OTP lock nor bitstream attestation is claimed; do not fund a valuable prize pot or provision fuses based on this image. `output-signed-lab` and `output-otp-lab` remain separate images.

Keep `BOOT_SIGN_KEY_DIR` (`boot.key`, `boot.crt`, `boot.pubkey`), `TA_SIGN_KEY` (RSA private PEM), its matching `TA_PUBLIC_KEY` PEM, and `OSUMANIA_MVP_DEVICE_KEY_FILE` (secp256k1 private PEM) **outside the checkout**. Supply the approved bank with `OSUMANIA_MVP_SRS_BANK`. Build with `BOOT_SIGN_KEY_DIR=... TA_SIGN_KEY=... TA_PUBLIC_KEY=... OSUMANIA_MVP_DEVICE_KEY_FILE=... OSUMANIA_MVP_SRS_BANK=... ./scripts/build.sh mvp-keyed`; inspect `output-mvp-keyed/images/SHA256SUMS`, `mvp-identity.json`, and `radxa-zero3-rt.img`. This build's image is **117,460,992 bytes**, SHA-256 `b098843e9c21208f7d0c9c7eca756f8c62dfb408842b8602dba947f3e3c97396`; public address `0x1e2dabc75362bef35d84b85a7b3138706e229b10`. The Mac signing command above is still a **board-only** check; no physical-board result for this keyed image has been observed. Preserve the known-good signed-lab SD as rollback; an unfused board can boot it if the new image fails.

## Latency contract

The target is p99.9 ≤100 µs from *report observed by host software* to *corresponding gadget report queued*, distinct from USB wire timing. HID transitions are retained in a fixed preallocated queue when `/dev/hidg0` returns `EAGAIN`; queue overflow is counted and collapses to the latest full keyboard state rather than allocating in the hot path. Debug snapshots remain diagnostic I/O and are not latency-test conditions. Neither p99.9 software latency nor wire-to-wire latency has been measured on the rebuilt images.

See `docs/kernel-selection.md`, `docs/usb-topology.md`, `docs/boot-chain.md`, `docs/realtime-tuning.md` and `docs/benchmarking.md` for source evidence, topology, controls and unverified assumptions.
