# EVM scoring HTTP server

One Rust process handles scoring proofs and the paid-game workflow. It loads the
SRS once and calls the proof engine in-process; there is no separate Node bridge,
prover subprocess, or internal HTTP hop.

## Run

From the repository root:

```sh
cargo build --release --locked --manifest-path scoring/Cargo.toml -p mania-gkr-prove-server
mkdir -p scoring/data
cp scoring/config.example.json scoring/data/config.json
# Configure the manifest, RPC, signer files, charts, capture mode and measured buffer.
scoring/target/release/mania-gkr-prove-server --bind 127.0.0.1:8091 \
  --srs scoring/gkr-scoring/artifacts/dev-srs-22.bin \
  --competition-config scoring/data/config.json
```

`SCORING_CONFIG` is an alternative to `--competition-config`. Omit both to run
only the raw proving API. Paths inside the JSON are relative to `--project-root`
(default: current working directory). The config file and `--srs` paths themselves
are relative to the working directory. The SRS must match the deployment manifest.

Point the web app's `VITE_SCORING_URL` at `http://127.0.0.1:8091` and allow its exact
origin (normally `http://localhost:3000`) in `allowedOrigins`.

## Configuration

See [`scoring/config.example.json`](../../config.example.json). Configure:

- `manifest`, `rpcUrl`, and `confirmations` for the deployment.
- `relayerKeyFile`, containing the funded transaction-signing key.
- `charts`: entries with `osuFile`, canonical `chartHash`, and registered `device`.
- `captureMode`: `hardware`, or explicit `software-demo` with a distinct `demoDeviceKeyFile`.
- `hardwareUrl` and optional `hardwareToken` for a real device adapter.
- `provingBufferSeconds` and `provingBufferMeasured: true` after measuring the actual workflow.
- Optional `jobStoreFile`; default is `scoring/data/jobs-<chain>-<leaderboard>.json`.

Paid routes are a single-user loopback demo. Startup refuses non-loopback binds
when competition config is enabled. Host, peer, Origin, and JSON checks protect
these routes. Keep the signer service on the same machine as the web client;
public multi-user hosting needs a separate authorization design.

`PROVER_API_TOKEN` optionally protects the raw `/v1/*` endpoints and must contain
at least 32 bytes when set. It is required for non-loopback raw-only servers.
Paid browser routes use the loopback/origin checks, not a token embedded in the web
app. `/healthz` remains unauthenticated. Default SRS without flags is
`artifacts/dev-srs-22.bin`, relative to the working directory.

## APIs

| Route | Behavior |
| --- | --- |
| `GET /healthz` | Process health |
| `GET /v1/info` | Proof system, loaded SRS ID and supported modes |
| `POST /v1/prove` | `{ "mode": "calldata" or "committed", "input": PlayInput }` → proof JSON |
| `GET /charts/:exactByteSha256` | Registered chart/device and fresh paid-play readiness |
| `POST /sessions/:id/start` | Validate confirmed payment, player/chart/day/device and arm capture |
| `POST /sessions/:id/proof` | Submit replay or request hardware seal; return a job ID |
| `GET /jobs/:id` | Proof/submission progress and confirmed transaction hash |

Raw proof responses retain `mode`, `srsId`, native `result`, `laneBits`, `counts`,
`proof`, commitments, `sessionDigest`, and timing fields. Raw requests are limited
to 16 MiB; paid requests to 8 MiB. One shared semaphore prevents overlapping raw
and paid proofs. Native input validation and proof verification run before return.

The paid workflow checks the session/payment receipt and registered device, builds
or authenticates the gameplay input, proves it, then relays `submitCalldata`.
Software replay timestamps are converted to canonical microseconds with the
independently checked chart delay; scoring modifiers and invalid key transitions
are rejected. Hardware mode ignores browser replay and preserves the original
signed header, event count, duration and trace hash.

Jobs checkpoint submitted transaction hashes and reconcile them after restart.
Interrupted work without a submitted transaction can be regenerated for the same
paid session. Failed, unsubmitted jobs require explicit `retry: true`; jobs with
transaction hashes are reconciliation-only and are never automatically resent.
Run one scoring process per job store and physical device.

## Hardware adapter

- `GET /health` → `{ "ready": true, "device": "0x..." }`.
- `POST /sessions/:id/start` receives `{header, chart}`. Header uint64 fields are
  decimal strings; the adapter arms that exact session and synchronizes the song clock.
- `POST /sessions/:id/seal` receives `{}` and returns `{input, signature}`. `input`
  is the canonical Rust `PlayInput`; `signature` is a 65-byte secp256k1 signature
  over the raw session digest. Input must come from physical capture.

This is an adapter protocol, not a bundled hardware driver. Software signing does
not establish physical gameplay attestation.

## Migrating from the removed Node bridge

Move the private JSON to `scoring/data/config.json`. Remove `host`, `port`,
`proverUrl`, `proverApiToken`, `proverBinary`, and `srsFile`; pass bind/SRS as server
flags. Rename `BRIDGE_CONFIG` to `SCORING_CONFIG`, and
`VITE_PROVER_BRIDGE_URL` to `VITE_SCORING_URL` (port 8091).

To preserve jobs, set `jobStoreFile` to the previous checkpoint path or copy that
file to the new location. The Rust loader accepts the old array-based checkpoint
format and writes native JSON maps on the next save. Keep old signer/data files
until migration is complete. Stop the old process before starting this one.

## Validation

```sh
cargo test --locked --manifest-path scoring/Cargo.toml -p mania-gkr-prove-server
npm ci --prefix leaderboard/ops
npm test --prefix leaderboard/ops
# Uses a temporary authenticated raw server; no chain transactions.
PROVER_HTTP_INTEGRATION=1 npm test --prefix leaderboard/ops
```

Paid end-to-end tests use `SCORING_E2E=1` with an isolated, already deployed Anvil
and registered chart/device. Override `E2E_RPC`, `E2E_MANIFEST`, `E2E_KEY_FILE`,
`E2E_DEVICE_KEY_FILE`, and `E2E_SRS_FILE`. The test starts the Rust server itself,
exercises payment → proof → on-chain acceptance and restart recovery. Set
`E2E_CAPTURE_MODE=hardware` to exercise the seal path with a named adapter test
double; this does not claim validation on physical hardware.
