# Local EVM prover

The raw API (`/healthz`, `/v1/info`, `/v1/prove`) is unchanged. Paid play uses
browser WebHID and player-wallet `submitCommitted`; the server needs **no key,
USB device, hardware adapter, or transaction relayer**. Sui is unchanged.

Copy `scoring/config.example.json` and configure a **new Mode B** deployment,
registered charts/devices, exact loopback origins, and a separate job store.
Old relay stores and Mode A sessions cannot be migrated into hardware attempts.
Keep their manifests and browser records for settlement and lookup.

Compute the approved bank mapping from the exact prover SRS:

```sh
scoring/target/release/mania-gkr-prove-server --srs "$SRS_FILE" --hardware-bank-points 260
```

This hashes contiguous affine G1 coordinates as `x_BE32 || y_BE32`, including
zero coordinates for identity. It is neither the SRS file hash nor verifier
`srsId`. Compare the output with the pinned board bank and configure all fields
in `hardwareSrs`. The 260-point / 65-event bank is insecure development material;
set `developmentOnly: true`. Never substitute a random bank hash to bypass readiness.

```sh
scoring/target/release/mania-gkr-prove-server --srs "$SRS_FILE" \
  --bind 127.0.0.1:8091 --project-root "$PWD" \
  --competition-config scoring/data/config.json
```

Paid routes retain asynchronous jobs:

- `GET /charts/:webHash`: readiness, registered chart, Mode B registry, approved bank.
- `POST /sessions/:id/start`: confirmed paid attempt (`sessionId`, `entryTxHash`,
  `player`, `chartHash`, `dayId`, `webBeatmapHash`, `captureMode: "hardware"`,
  `chainId`, `registry`) → exact 292-byte packed `header` as hex. No device commands.
- `POST /sessions/:id/proof`: `{result, trace, webBeatmapHash}` with the original
  465-byte result and complete 14-byte/event trace as `0x` hex. Identical captures
  reuse jobs; conflicting captures are rejected. Failed/interrupted proofs can
  retry the identical capture.
- `GET /jobs/:id`: `queued`, `proving`, `ready`, or `failed`. `ready.result` contains
  deployment identity, SRS ID, V2 digest, and typed `submission` fields for the wallet.

The server authenticates the original header/signature, validates all events,
recomputes SHA root and KZG commitment, and natively verifies the generated proof
against that original statement. It shares the raw API concurrency limit. Results
are persisted atomically; interrupted jobs become retryable failures on restart.

See [browser hardware rollout](../../../docs/browser-hardware.md) for rollout and acceptance.
