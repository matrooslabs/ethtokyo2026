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

## Hardware-root signing profile

`./scripts/build.sh hardware-root` and direct `./scripts/build-optee.sh hardware` **refuse to emit an image**. On this unmodified ZERO 3W, the current Secure OTP interface returns raw HUK bytes to programmable BL32, while the existing SD boot chain is unsigned; an attacker could replace BL32 and export the HUK. No on-chip key-reader-only secp256k1 signer is documented. Also missing: RK3566 ROM-enforced boot authentication, debug-port lock, approved OTP slot/lock procedure and qualified Secure World RNG (`CFG_INSECURE=n` fails to link at `plat_rng_init`). No OTP write occurs. The existing `optee-runtime` image is **development-only** despite successful GET_INFO. See `docs/hardware-key-provisioning.md`.

## Latency contract

The target is p99.9 ≤100 µs from *report observed by host software* to *corresponding gadget report queued*, distinct from USB wire timing. HID transitions are retained in a fixed preallocated queue when `/dev/hidg0` returns `EAGAIN`; queue overflow is counted and collapses to the latest full keyboard state rather than allocating in the hot path. Debug snapshots remain diagnostic I/O and are not latency-test conditions. Neither p99.9 software latency nor wire-to-wire latency has been measured on the rebuilt images.

See `docs/kernel-selection.md`, `docs/usb-topology.md`, `docs/boot-chain.md`, `docs/realtime-tuning.md` and `docs/benchmarking.md` for source evidence, topology, controls and unverified assumptions.
