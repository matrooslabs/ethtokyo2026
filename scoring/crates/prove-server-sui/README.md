# Sui hardware-sealed proof bridge

The paid Sui path accepts only BridgeOS Vendor-HID captures for an on-chain
`registry::Session` opened in **Mode B (mode 2)**. The physical signer computes a
48-byte compressed BLS12-381 G1 commitment from its event trace and signs the
Mode B digest (`OSUMANIA_HARDWARE_SESSION_V2_BLS12381`, version 2, exact 292-byte
header, event count, duration, SHA-256 trace root and commitment) using secp256k1.
The server verifies the registered signer and original 449-byte GET_RESULT,
recomputes the BLS commitment from GET_TRACE with the same SRS, proves the GKR
score and emits a `submit_committed` transaction plan. The trace is never posted
on-chain. Legacy mode-3 BN254 captures and old Sessions are rejected.

The locally generated `smax=22` SRS has a **known toxic secret**; scores can be
forged even if the hardware signature is genuine. Testnet demo only; never fund
a valuable pot or claim secure hardware attestation for the extractable-key image.

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
Generate the matching local SRS and 200,000-point device bank with
`mania-gkr-sui local-mode-b-srs --out PATH --bank BANK`. This fixed `smax=22`
generator uses no external ptau. Provision `BANK` on the board using the same
public bank SHA-256 and SRS ID emitted by the CLI. The server requires the SRS
ID to match the new Registry and GET_INFO bank hash/capacity to match the SRS.
Use a **new** package/Registry/Challenge and job directory; old mode-3
deployments and stored jobs are not migrated.

## Paid capture protocol

All `*Hex` strings are `0x`-prefixed, exact original bytes from BridgeOS HID
(no JSON reconstruction or event replay). `chart` uses the scoring-core Chart
shape `{key_count:4,notes:[{lane,start_us,end_us},...]}`.

1. Buy credits and open a paid competition session (`mode=2`) before capture.
2. Call HID GET_INFO (128 bytes) and GET_STATUS (16 bytes). POST
   `/v1/sessions/start` with `{ "sessionId":"0x<32-byte-Sui-ID>",
   "infoHex":"0x<128 bytes>", "statusHex":"0x<16 bytes>" }`.
   The service checks the on-chain Session/Registry, active registered device,
   bitstream, BLS input policy hash, expiration, zero/idle status, exact device
   bank hash and 50,000-event capacity; the reply contains `{sessionId,headerHex,mode}`.
   Send `headerHex` unchanged to HID SET_HEADER (292 bytes), then START.
3. On HID STOP, read HID GET_RESULT (449 bytes) and GET_TRACE (`14*n` bytes).
   POST `/v1/sessions/submit` with
   `{ "sessionId":"0x...", "resultHex":"0x...", "traceHex":"0x...", "chart":{...} }`.
   The 202 response contains `{sessionId,state:"proving",statusUrl}`. Invalid or
   missing signature/trace never produces a `ready` payload.
   The server checks the signed root and device commitment against the original
   events. No `TraceUpload` or 7,000-event calldata limit applies; the device
   bank and Registry cap at 50,000 events.
4. GET `/v1/jobs/{sessionId}`: `{sessionId,state,payload,error}`. State is
   `proving`, `ready`, `failed`, or `interrupted` (server restarted while proving).
   POST `/v1/jobs/{sessionId}/retry` reprocesses the persisted capture if failed
   or interrupted; a completed result is idempotently returned. `/healthz` only
   tests process liveness. `/v1/info` reports SRS and configured registry/package.

Jobs live as JSON in `--jobs` (default `artifacts/sui-proof-jobs`); protect this
directory and its raw capture bytes. One proof runs at a time (`503` if busy).
The server is a **secure-relay payload producer**, not a Sui transaction signer.

## Ready payload → Sui PTB

The `ready` job's `payload` contains `kind:"sui-programmable-transaction"`,
`mode:"committed"`, `registryId`, `sessionId`, `packageId`, decimal-string
`n`/`duration`, original signed `root` (32 bytes), `traceCommitment` (48 bytes),
`signature` (65 bytes), `laneBits` (4 u64), `counts` (5 u64), `proofGroups`,
`sessionDigest`, and `result`. No `traceBatches` or `steps` are returned.

Encode each `proofGroups[i]` as one pure `vector<vector<u8>>` (<15 KiB) and
combine them with PTB `MakeMoveVec` into `vector<vector<vector<u8>>>`.
Call `registry::submit_committed(registry, &mut session, n, root,
traceCommitment, duration, laneBits, counts, proofGroups, signature, &Clock)`
then `competition::record_score(challenge, session, &Clock)` in **one Sui PTB**.
The wallet signs the transaction, not the trace. Confirm `PaidScoreRecorded`
on-chain before displaying an accepted rank; a `ready` proof alone does not
mean a scored run. Invalid captures return `{"error":"..."}` or a failed job.

The older `mania-gkr-sui prove-session` CLI uses a known demo signing key for
localnet fixtures only. It is **not** a production scoring path.

