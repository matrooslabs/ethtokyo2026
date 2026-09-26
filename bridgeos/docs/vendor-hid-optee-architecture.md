# Vendor HID v1 and OP-TEE architecture

## Canonical source and implementation status

The supplied `osu!mania Hardware Vendor HID Protocol v1` is normative. `bridge-gadget` now advertises usage page `0xff60`, usage `0x01`, no report ID, and fixed 64-byte Input/Output reports. `bridge-daemon` implements magic `M`, big-endian 16-byte packet headers, 48-byte fragments, strict transfer ordering/padding, the canonical command state machine, trace streaming, SHA-256 chaining, BN254 commitment, and the constrained OP-TEE signer API.

The project builds pinned OP-TEE OS 4.9.0 for its RK3568/RK3566 `plat-rockchip` port, TF-A with `PLAT=rk3568 SPD=opteed`, and a source-built U-Boot FIT containing BL32. The user has booted the signed-lab OP-TEE image on a ZERO 3W and completed Vendor HID signing sessions; ROM fuse enforcement and a real OTP identity are still unverified. The same CA/TA contract passed a real `/dev/teepriv0` invocation.

The installed Mode B development SRS has 260 BN254 G1 points (`srs-g1-be.bin`, SHA-256 `9429d8e688b4879bcab8f84a7f8574d682277bcb6021841cca060ff969e9c2d7`), so that image truthfully advertises `maxEvents=65`. A distinct **200,000-point bank** was derived from PSE contribution 0080's verified BN254 power-22 transcript (bank SHA-256 `a5d4aebef0045376737ba894f3be285fe6dcadecd5b0f1273fc35b8e44630fe9`, scoring `srsId=0xd9d1d514de8db36969daa2be4383a3fdd3c0fcf647fc2ff0a7a38050c02d4159`); it supports the existing device/TA limit of **50,000 events** (700,000 trace bytes). The public ceremony file and converter are pinned in `manifests/sources.lock` and `tools/convert-ppot-srs.py`. This bank is an external input, **not** packaged in a development-key image; hardware-root remains blocked by real Secure OTP provisioning and qualified entropy. Existing on-chain chart limit is 10,000 notes.

## Ownership

### Normal World Linux

- USB host keyboard discovery and evdev decoding.
- Immediate keyboard report forwarding to `/dev/hidg0`.
- One canonical physical edge record, timestamped from `CLOCK_MONOTONIC`, then copied into a bounded SPSC queue.
- Immutable session trace storage, SHA-256 trace chain and BN254 `C_E` worker.
- `/dev/hidg1` exact 64-byte Vendor HID framing, command validation, bounded response streaming and GET_TRACE reads.
- OP-TEE Client API calls using canonical fields, never an arbitrary digest.

### Secure World TA

- Device key and key backend policy.
- Independent session state and exact immutable 292-byte header.
- Validation of device address, bitstream hash, input policy and SRS availability.
- Construction of the exact 430-byte V2 preimage and its SHA-256 digest.
- secp256k1 low-s recoverable signature and immutable 465-byte result.
- Stateful commands only: GET_DEVICE, SET_HEADER, START_SESSION, FINALIZE_SESSION, GET_RESULT, ABORT_SESSION. No generic sign API.

The RK3566 hardware root backend is a platform hook and must fail closed until secure OTP/HUK integration is reviewed. A development key backend, if enabled, is debug-only and must produce a prominent warning; it is not hardware security.

## Concurrency and latency

The keyboard RT thread remains CPU2/FIFO 60 and never calls OP-TEE, SHA, GMP/BN254 or Vendor HID request processing. It forwards each evdev transition first, then performs a bounded nonblocking SPSC enqueue of the same canonical 14-byte record when RECORDING. Queue full sets EVENT_OVERFLOW and ERROR; no event is silently dropped or signed. A lower-priority worker drains the queue into preallocated trace storage, SHA chunks and BN254 accumulation. Vendor HID and GET_TRACE use another non-RT thread and bounded 64-byte reports. STOP closes capture atomically, freezes `D`, drains the worker, then invokes TA finalization; any post-close failure enters ERROR.

## Persistence and reconnect

Incomplete incoming Vendor HID fragments are discarded on disconnect. RECORDING cannot resume after process restart or uncertain disconnect and must abort. Completed command effects remain. FINALIZED Linux trace and TA result are immutable until ABORT or power loss. This first appliance implementation has no crash-consistent persistent session journal; restart therefore fails closed to IDLE/ERROR rather than reconstructing a signed session.

## Security boundary

Even with OP-TEE signing, Linux owns USB input parsing and timestamps. The TA authenticates a Linux-supplied finalized trace summary under a constrained state machine; it does not independently prove physical keyboard origin. Secure boot, approved firmware measurement, real HUK provisioning and a trusted input path are separate requirements.
