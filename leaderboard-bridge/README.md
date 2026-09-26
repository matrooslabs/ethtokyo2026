# Web/prover bridge

This unauthenticated bridge is a **single-user, loopback-only software demo**. It refuses public/LAN bind addresses and non-loopback configured web origins. Literal Host, peer-address and Origin checks prevent exposing the signer through DNS rebinding or cross-origin browser requests; POST requires JSON. Local processes and users on the same machine are trusted. Do not put it behind a reverse proxy, tunnel, port forward or shared remote host. Multi-user deployment requires authentication and per-player capture authorization, which this demo does not implement.

Install with `npm ci --prefix leaderboard-bridge`. Copy `config.example.json` to ignored `data/config.json`, configure registered charts and signer paths, then run from repo root:

`BRIDGE_CONFIG=leaderboard-bridge/data/config.json npm start --prefix leaderboard-bridge`

Keep signer files out of source control. The relayer key funds proof transaction gas. `captureMode: "hardware"` fails closed until the physical device adapter is reachable. For explicit software-only testing choose `"software-demo"` and `demoDeviceKeyFile` containing a separately generated device key; enroll that address in the registry. The demo device cannot reuse the relayer key. Software replay signing does not prove human or physical-device input.

Browser endpoints follow `Web-Osu-Mania/src/lib/leaderboard/bridge.ts`: GET `/charts/:exactByteSha256`, POST `/sessions/:sessionId/start`, POST `/sessions/:sessionId/proof`, GET `/jobs/:jobId`. Start checks confirmed EntryPaid transaction, chart/player/day/device/session binding and deadline. Readiness requires a registered chart, active device, prover/SRS files, relayer and physical health (hardware mode). Jobs checkpoint submitted transaction hashes and reconcile them on-chain after restart. Run one process per physical device; one proof job at a time.

The example 180-second proving buffer is provisional. Readiness fails until you measure it using the actual chart, prover and network, configure `provingBufferSeconds`, and explicitly set `provingBufferMeasured: true`. Maximum 4K canonical chart is 10,000 notes, trace 50,000 events, duration 30 minutes. Unmodified scoring only. Browser timings are canonical microseconds `(timeMs - chartDelayMs) * 1000`, rounded; delay must independently equal `max(1000 - firstNoteMs, 0)`. Invalid ordering/key transitions/modifiers are rejected.

## External physical-device adapter contract

This is an adapter protocol, not a claim that a serial driver exists. Run an implementation on the machine physically connected to the device. `hardwareUrl` points to it, optionally with `hardwareToken` bearer authorization (keep configuration private).

- GET `/health` returns `{ready:true, device:"0x..."}` only while the real signer/capture device is usable.
- POST `/sessions/:id/start` receives `{header,chart}`; header is the contract-issued Header with uint64 fields encoded as decimal strings. Adapter must arm the real device with this exact challenge/domain and arrange song-clock synchronization before acknowledging. Return any JSON object on success. Repeated start for the same session must be idempotent; refuse conflicting sessions while capture is active.
- POST `/sessions/:id/seal` receives `{}` and returns `{input,signature}`. `input` is canonical Rust PlayInput JSON (`header`, `chart`, `events`, `footer`). The events must come from physical capture, not browser replay. `signature` is canonical 65-byte raw-digest secp256k1 signature (v=27/28). Footer binds count, duration and trace root. Never rebind a recording to a newly issued session.

The bridge checks exact session header, canonical chart, root, event count and recovered device signature before invoking `prove-sealed`. That CLI preserves the seal. It checks the resulting proof digest again and submits the original signature; neither header nor trace is rewritten. Browser input is ignored in hardware mode. A ready response alone does not establish actual-device correctness; complete end-to-end capture/proof/on-chain acceptance must be demonstrated on the connected machine.

## Integration tests

`npm test --prefix leaderboard-bridge` runs protocol units; local integration is opt-in. With the coordinator's isolated funded Anvil deployment and registered demo chart/device, run `BRIDGE_E2E=1 npm test --prefix leaderboard-bridge`. Override `E2E_RPC`, `E2E_MANIFEST`, `E2E_KEY_FILE`, `E2E_DEVICE_KEY_FILE` as needed. Defaults use port19549, local31337 manifest, temporary Anvil key and generated software-device key. `E2E_CAPTURE_MODE=hardware` exercises the preserved-seal adapter path using a named **test double**, never physical hardware. Both modes invoke the real Rust prover and on-chain verifier. Tests refuse nonlocal chain IDs.

All configured relative paths resolve against the repository root: `BRIDGE_CONFIG`, manifest, signer files, `.osu` files, binary, SRS and `jobStoreFile`. Absolute paths are preserved, so the documented root command works with npm `--prefix`.

Jobs and their transaction hashes are checkpointed under ignored `data/` (override `jobStoreFile`). A submitted job survives restart: status requests reconcile the original transaction and chain record. Interrupted work with no saved transaction returns 404 so the browser can check `entries.scored`, re-arm the same paid session and resend its saved replay. Failed jobs with no transaction hash report `retryable: true`; an explicit `/proof` request with `retry: true` rechecks the still-open, unconsumed paid session before starting a new job. Jobs with any transaction hash are reconciliation-only and never automatically rebroadcast. The on-chain consumed-session check prevents duplicate accepted scores even across a crash at the transaction-broadcast boundary. Run only one bridge process per job store and physical device.
