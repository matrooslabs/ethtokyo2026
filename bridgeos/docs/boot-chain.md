# ZERO 3W boot chain

## Sources and trust boundary

The firmware is built from the upstream [radxa-zero-3-boot-firmware](https://github.com/Warfront1/radxa-zero-3-boot-firmware) recipe at `50a0d9ca8dc5bb42b616cd544a40301bb8fe63eb` (`sources/boot-firmware`). It pins:

| Component | Source identity | Role |
| --- | --- | --- |
| U-Boot | [u-boot/u-boot](https://github.com/u-boot/u-boot), `v2026.07`, commit `ece349ade2973e220f524ce59e59711cc919263f` | SPL, U-Boot proper, board DTBs and FIT packaging |
| Trusted Firmware-A | [ARM-software/arm-trusted-firmware](https://github.com/ARM-software/arm-trusted-firmware), `lts-v2.14.6`, commit `8fe2e465a435eeaabba26b8e894e6b83858a346d` | Source-built BL31, `PLAT=rk3568` |
| Rockchip rkbin | [rockchip-linux/rkbin](https://github.com/rockchip-linux/rkbin), commit `ecb4fcbe954edf38b3ae037d5de6d9f5bccf81f4` | **Only** the proprietary DDR-init TPL blob |

The exact DDR blob is `bin/rk35/rk3566_ddr_1056MHz_v1.25.bin`, SHA-256 `c2a1b37673bf03ed338bc39efbe942136459cb3621dad09351144d744d78db26`. There is no open RK3566 DDR initializer available in this recipe. **No stock/vendor U-Boot or proprietary rkbin BL31 is used.** These source identities come from `sources/boot-firmware/pins/` and checked-out Git HEADs; they are not claims of hardware qualification.

## Build and image placement

The firmware repository's `scripts/build/all.sh` builds TF-A `bl31.elf`, then mainline U-Boot with `BL31` pointing to that ELF and `ROCKCHIP_TPL` pointing to the pinned DDR blob. The resulting single image is `sources/boot-firmware/out/u-boot-rockchip.bin`; `u-boot.itb` is also emitted for inspection but is already embedded in the single image. The repository's Dockerfile specifies its full Debian tool dependencies and a pinned Debian base image. Run from `sources/boot-firmware`:

```sh
docker build -t radxa-zero3-boot-firmware .
mkdir -p out
docker run --rm -v "$PWD/out:/out" -e BUILD_DIR=/build -e OUT_DIR=/out radxa-zero3-boot-firmware
```

The host build also works with an AArch64 GNU cross-compiler/binutils, native build dependencies listed in the Dockerfile, and `MAKEFLAGS=-jN bash scripts/build/all.sh`. Pin the toolchain if bit-for-bit repeatability across hosts is required; pinned inputs and timestamps alone do not guarantee identical outputs from different compilers.

Write `u-boot-rockchip.bin` to the **whole boot device**, not to a partition: sector 64 / byte offset `0x8000`. For an SD card represented as `/dev/sdX` (verify the device first):

```sh
sudo dd if=sources/boot-firmware/out/u-boot-rockchip.bin of=/dev/sdX bs=512 seek=64 conv=notrunc,fsync
```

The boot media partition table occupies the beginning of the device, so reserve the complete raw firmware span `[0x8000, 0x8000 + file size)` before starting any filesystem partition. The built 9,588,224-byte image has an `RKNS` header at relative offset `0`, the exact pinned DDR blob starting at relative offset `0x800`, U-Boot SPL and its DTB, and the embedded FIT at relative offset `0x7f8000`; the FIT contains U-Boot proper, TF-A BL31 and ZERO 3E/3W DTBs. The FIT starts at device offset `0x800000` when the image is written at sector 64. Do not overwrite this region with a partition or a second, separately flashed FIT. (The upstream recipe README says TPL starts at `0x1000`, but the pinned DDR blob's bytes start at `0x800` in this actual built image.)

## Linux hand-off

The Debian ZERO 3E reference image uses this exact `u-boot-rockchip.bin` at sector 64, a GPT ext4 partition beginning at 16 MiB, and `/boot/extlinux/extlinux.conf` with `/boot`-prefixed kernel, initrd and DTB paths. The appliance now matches that partition/file layout while supplying its own ZERO 3W RT kernel/DTB and external initramfs. U-Boot loads `/boot/Image`, `/boot/rk3566-radxa-zero-3w-rt.dtb` and `/boot/rootfs.cpio.gz`; `rdinit=/init` runs the unpacked initramfs directly, so no PARTUUID-backed root filesystem is necessary. SPL's FIT still carries distinct U-Boot firmware DTBs. This layout comparison is static evidence, **not** confirmation that the rebuilt image boots the user's board.

## Experimental OP-TEE boot chain

`./scripts/build-firmware-optee.sh dev` builds pinned OP-TEE OS 4.9.0 with the reviewable `board/radxa-zero3-rt/patches/optee-os/0001-plat-rockchip-add-rk3568.patch`, TF-A `PLAT=rk3568 SPD=opteed`, and mainline U-Boot with the project patch series. The resulting `sources/boot-firmware/out-optee-dev/u-boot-rockchip.bin` adds source-built BL32. Production and normal debug remain on the known-bootable baseline; only `./scripts/build.sh optee-debug` selects this experimental firmware and packages the TA plus hardware smoke client. `dumpimage -l out-optee-dev/u-boot.itb` reports two TF-A and two TEE loadable segments, but structural packaging is not boot proof.

The first hardware boot blocker found in the project port was the GICv3 initialization path: generic Rockchip code called `gic_init()` and therefore passed a zero redistributor base. RK3568 uses GIC-600 affinity routing with redistributors at `0xfd460000`. The corrected port calls `gic_init_v3(0, 0xfd400000, 0xfd460000)`; disassembly of the built `tee.elf` confirms those exact arguments. Hardware boot still determines whether this was the only blocker.

The decisive hint from the Warfront firmware recipe is its use of a freestanding `aarch64-linux-gnu-` firmware compiler. The first BL32 experiments reused Buildroot's glibc target compiler for TF-A; that compiler injected PIE/dynamic-linker defaults. The resulting `bl31.elf` contained `PT_INTERP /lib/ld-linux-aarch64.so.1`, a dynamic section, and a merged load segment beginning at `0x00030000`. Binman consequently generated the wrong FIT hand-off shape (`Firmware: u-boot` instead of `Firmware: atf-1`). The corrected builder uses Warfront's GNU cross compiler when available, or Clang with GNU AArch64 `ld.bfd`/binutils as a freestanding fallback. Corrected BL31 is statically linked, has no interpreter or dynamic section, enters at `0x00040000`, and the FIT now selects `atf-1` as firmware with `u-boot`, `op-tee`, `atf-2`, and `atf-3` as loadables.

The rkbin BL32 is a contiguous raw executable beginning directly with AArch64 entry instructions at `0x08400000`; it is not an ELF split across FIT nodes. The project now packages OP-TEE `tee-raw.bin` the same way as one FIT loadable at `0x08400000`. The generated FIT configuration explicitly lists `op-tee`, followed by the TF-A segments.

For UART-independent failure localization, source OP-TEE writes `0x4f500001` before console setup, `0x4f500002` after secure platform initialization begins, and `0x4f5000ff` before returning to Normal World into PMUGRF OS_REG11 (`0xfdc2022c`). On the next reset SPL copies a valid prior marker to OS_REG10 (`0xfdc20228`) before BL32 can overwrite it. Linux preserves and clears the live marker. There is no BL32 bypass and no diagnostic watchdog in the source runtime.

Secure DRAM starts at `0x08400000`: this matches Rockchip's RK3566/RK3568 reference `RKTRUST/*.ini` BL32 address in the pinned rkbin repository. The project reserves 32 MiB TZDRAM at `0x08400000..0x0a3fffff` and 4 MiB static shared memory at `0x0a400000..0x0a7fffff`; U-Boot excludes both ranges from Normal World RAM. The proprietary rkbin `rk3568_bl32_v2.16.bin` was used only as address/layout evidence and is not copied into the image.

## Vendor BL32 reverse-engineering reference

The pinned opaque `rk3568_bl32_v2.16.bin` is not a build profile and is never copied into an image. Static disassembly is used only to recover RK3566 hardware behavior for the source OP-TEE 4.9 port.

Recovered vendor behavior: BL32 loads at `0x08400000`; secure TZDRAM is `0x00e00000` bytes; static shared memory is `0x00200000` bytes at `0x09200000`. The DDR firewall routine at `0x0840dc40` accepts regions 0–7, programs bounds in 128 KiB units, and enables the selected region with a read/OR/write at `DDRSGRF + 0x80`. Its initialization call protects region 1 from `0x08400000` for 14 MiB. Source OP-TEE 4.9 keeps its larger 32 MiB TZDRAM plus 4 MiB shared-memory layout, but now uses the recovered firewall granularity, range encoding and enable semantics.

The vendor image references the same RK3566 bases used by the source port: DDRSGRF `0xfe200000`, secure OTP `0xfe3a0000`, OTP PHY `0xfe880000`, CRU `0xfdd20000`, secure CRU `0xfdd10000`, secure GRF `0xfdd18000`, GIC `0xfd400000`, and UART2 `0xfe660000`. It also references regular GRF `0xfdc60000`; this is recorded but not added to source OP-TEE without a demonstrated source-side use.

Vendor and source signed TAs use the same OP-TEE signed-header magic and RSA-PSS/SHA-256 algorithm ID `0x70414930`, but the vendor trust key is RSA-2048 while source OP-TEE 4.9 uses its own matching trust anchor and current TA ABI. No OP-TEE 3.13 SDK, GP 1.1 compatibility path, vendor key patch, or signature bypass remains.

The vendor OTP routines expose additional secure/PHY sequencing, but static evidence does not establish a board-provisioned HUK offset or production key policy. Source OP-TEE therefore continues to fail closed for hardware HUK mode until those values are independently provisioned and reviewed.

## Verification and limitations

The RK3566 source OP-TEE artifacts, current-ABI TA, firmware, rootfs and flash image build successfully and pass static hashes/invariants. Hardware evidence now proves source OP-TEE 4.9 initializes (`optee: revision 4.9`) and the bridge remains operational with correct CPU/IRQ affinity, but TA acquisition failed before the result stage was recorded. Image `370991499786820e197bbac67260141ba36b67e7c6690b50000ba5ae183ae221` logs exact TEEC context/session/invoke result and origin; when bridge acquisition fails, it runs the standalone smoke exactly once. TEE failure remains isolated from keyboard forwarding.

The preferred unified OP-TEE 4.9 development stability artifact is `output-optee-runtime/images/radxa-zero3-rt.img`, SHA-256 `be23d520406835c540924f05f1beeb8e473408546883334330d2ed4f1e486376`. The previous `TEE_ERROR_GENERIC`, origin TEE occurred before TA creation: the bootstrap TA load checks `ta_ver.db`, but the REE-FS key manager had no HUK; after that is fixed, the appliance's read-only root also makes the default `/data/tee` unusable. Development mode now uses an explicit insecure HUK and volatile `/run/tee`. Hardware/production mode still fails closed until a reviewed RK3566 HUK offset, persistent rollback storage, approved SRS/bitstream policy, private product TA signing key and authenticated boot are provisioned.

Hardware result: Vendor HID `GET_INFO` now succeeds through `OSUMANIA_TA_GET_DEVICE`. The HUK-backed REE-FS loader diagnosis is confirmed by the passing image after adding the development-only HUK and writable `/run/tee` storage. The returned development device address is `0xf15e068b7a61cc36391fab39512fd9e6f9c9e8f0`; production authenticity remains explicitly unverified.
