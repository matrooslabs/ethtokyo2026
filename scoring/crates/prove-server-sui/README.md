# Sui hardware-sealed proof bridge

This service accepts only BridgeOS vendor-HID captures for an existing on-chain Sui
`registry::Session` opened in hardware mode **3**. It never accepts browser replay,
synthetic signatures, or a bare `PlayInput` for paid scoring. Proofs use the Sui
BLS12-381 GKR calldata verifier, but bind its statement digest to the **original**
BridgeOS V2/BN254 465-byte signed result, not a rewritten V1 header. The signed
BN254 trace commitment is retained in the registry submission; the signed SHA-256
trace root binds the exact 14-byte-per-event HID GET_TRACE bytes to the calldata proof.

The trust boundary is the registry's active hardware public key and provisioned
bitstream: HID GET_INFO by itself is self-reported, while the final original
GET_RESULT must verify under that key. Never register the BridgeOS `dev-insecure`
backend's key as a paid device.

## Run

From `scoring/`: `cargo run -p mania-gkr-sui-prove-server -- --srs PATH --jobs PATH`
with required environment `SUI_RPC_URL`, `SUI_REGISTRY_ID`, `SUI_PACKAGE_ID`.
For public testnet/mainnet set `SUI_NETWORK=testnet` (or `mainnet`), run
`(cd scoring/gkr-scoring-sui/scripts && npm ci)`, and use the HTTPS Sui **gRPC**
endpoint such as `https://fullnode.testnet.sui.io:443`. The read-only adapter
`src/sui_grpc.mjs` uses that existing pinned `@mysten/sui` SDK (Node 22+ for
supported deployments); the binary invokes it once per session read. JSON-RPC
is used **only** for loopback localnet/test mocks, never public fullnodes.
If deployed outside the source tree, set `SUI_GRPC_HELPER` to the copied
`sui_grpc.mjs` path and `SUI_SDK_MANIFEST` to the absolute path of the pinned
scripts `package.json` alongside installed `node_modules`. Default bind is
`127.0.0.1:8092`.
For non-loopback binding, `PROVER_API_TOKEN` (at least 32 bytes) is required;
all paths except `/healthz` then require `Authorization: Bearer <token>`.
Use TLS between browsers and this service. A dev SRS from `mania-gkr-sui srs`
has a known toxic secret and **must not** be used for production prizes.

## Paid capture protocol

All `*Hex` strings are `0x`-prefixed, exact original bytes from BridgeOS HID
(no JSON reconstruction or event replay). `chart` uses the scoring-core Chart
shape `{key_count:4,notes:[{lane,start_us,end_us},...]}`.

1. Open and fund the on-chain Sui competition session (`mode=3`) before capture.
2. Call HID GET_INFO (128 bytes) and GET_STATUS (16 bytes). POST
   `/v1/sessions/start` with `{ "sessionId":"0x<32-byte-Sui-ID>",
   "infoHex":"0x<128 bytes>", "statusHex":"0x<16 bytes>" }`.
   The service checks the on-chain Session/Registry, active registered device,
   bitstream, policy hash, expiration, zero/idle status, hardware SRS readiness;
   reply contains `{sessionId,headerHex,mode}`. Send `headerHex` unchanged to HID
   SET_HEADER (292 bytes), then HID START; only actual device events count.
3. On HID STOP, read HID GET_RESULT (465 bytes) and GET_TRACE (`14*n` bytes).
   POST `/v1/sessions/submit` with
   `{ "sessionId":"0x...", "resultHex":"0x...", "traceHex":"0x...", "chart":{...} }`.
   The 202 response contains `{sessionId,state:"proving",statusUrl}`. Invalid or
   missing signature/trace never produces a `ready` payload.
   The current Sui calldata `TraceUpload` object is capped at ~250 KiB; this
   service fails closed above **7,000 events**, even though BridgeOS itself can
   record 50,000. Mode 3 cannot silently switch to Sui's BLS commitment mode.
4. GET `/v1/jobs/{sessionId}`: `{sessionId,state,payload,error}`. State is
   `proving`, `ready`, `failed`, or `interrupted` (server restarted while proving).
   POST `/v1/jobs/{sessionId}/retry` reprocesses the persisted capture if failed
   or interrupted; a completed result is idempotently returned. `/healthz` only
   tests process liveness. `/v1/info` reports SRS and configured registry/package.

Jobs live as JSON in `--jobs` (default `artifacts/sui-proof-jobs`); protect this
directory and its raw capture bytes. One proof runs at a time (`503` if busy).
The server is a **secure-relay payload producer**, not a Sui transaction signer.

## Ready payload → Sui PTB

The `ready` job's `payload` has `kind:"sui-programmable-transaction"`,
`registryId`, `sessionId`, `packageId`, `clockId:"0x6"`, `traceBatches`,
`proofGroups`, `sessionDigest`, `result`, and an ordered `steps` plan:

- Call `package::registry::new_trace_upload(session)` to obtain a TraceUpload.
- For each `traceBatches[i]` call `append_trace(&mut trace, vector<vector<u8>>)`;
  each hex member is an original ≤32-event HID chunk, grouped to stay below Sui's
  16 KiB PTB argument limit.
  For traces that would exceed Sui's transaction size, split these calls across
  PTBs: create the TraceUpload and transfer the owned object to the relayer,
  then mutate it using its returned object ID in subsequent append PTBs; the
  final `submit_hardware` consumes that same TraceUpload. Never recalculate or
  drop the original chunks. The SHA root and device signature are checked on-chain.
- Encode each `proofGroups[i]` as one pure `vector<vector<u8>>` (<15 KiB), combine
  those values with PTB `MakeMoveVec` into `vector<vector<vector<u8>>>`, then call
  `submit_hardware(registry, &mut session, trace, duration:u64,
  device_bn254_commitment:vector<u8>[64], lane_bits:vector<u64>[4],
  counts:vector<u64>[5], proof, original_sig:vector<u8>[65], &Clock)` using values
  from `steps[2].arguments` in exact order. The Sui wallet/relay signs the PTB,
  **never the game trace**. Confirm on-chain `ScoreAccepted` and the competition
  vault's reward/claim state before displaying payment; a `ready` proof alone is
  not settlement. Failures return `{"error":"..."}` or a failed job with `error`.

The older `mania-gkr-sui prove-session` CLI uses a known demo signing key for
localnet fixtures only. It is **not** a production scoring path.

