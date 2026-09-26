# Daily competition client

The practice button preserves the existing game. Each paid attempt uses the confirmed `DailyLeaderboard.EntryPaid` session, a registered canonical chart hash, the connected wallet as payer/player, and the scoring server's registered device. It costs 1 USDC on Ethereum Sepolia (chain 11155111). Tokens are read from `DailyLeaderboard.token()`, never from an independently guessed browser token address.

## Configure and run

Use Node 22.18+ (Node 26.4 was used for validation).

```sh
npm ci
cp .env.example .env.local
# Fill the public configuration from the deployment manifest and scoring server.
npm run dev
```

- `VITE_LEADERBOARD_ADDRESS`: deployed DailyLeaderboard address.
- `VITE_SEPOLIA_RPC_URL`: browser-accessible Sepolia RPC. Never embed privileged credentials.
- `VITE_SCORING_URL`: running scoring server (default example `http://127.0.0.1:8091`). Configure CORS for the web origin, including its port.
- `VITE_LEADERBOARD_INDEXER_URL`: indexer HTTP API (`http://127.0.0.1:8787` locally).
- `VITE_BEATMAP_URL`: registered archive URL. Defaults to the original four-note demo included in this repository; rebuild it with `python3 scripts/create-daily-demo.py`. The previous Forest archive URL had no asset in this workspace.
- `VITE_WALLETCONNECT_PROJECT_ID`: operator-owned WalletConnect project with permitted origins. Without this, browser extension connections remain available; phone QR is explicitly unavailable.

All VITE variables are public. Never put a signer key in this directory or a browser environment variable. Restart Vite after changing environment. The scoring server is a trusted same-machine demo service: bind it and the web client to loopback and allow only the exact local web origin. Do not expose this unauthenticated signer/relayer through a public HTTPS proxy. Public hosted signing needs a separate authenticated service design.

## Player flow

1. Connect a browser wallet, or choose WalletConnect in the wallet dialog and scan its QR using a phone wallet. Sepolia is the only configured chain.
2. Select a supported chart. Readiness requires the scoring server's registered chart, active device, real prover and relayer. Software-signer demos require explicit acknowledgment and remain labeled on the result screen.
3. Choose **Enter daily competition · 1 USDC**. Approve exactly one USDC if allowance is insufficient, then send the entry transaction. Both wait for two confirmations. The receipt must include the exact contract/chart/day/player/payer/device/amount before any paid gameplay starts.
4. The web loads the same archive chart, checks its exact-byte SHA-256 against the paid entry's scoring server mapping, loads assets, and starts capture. Paid gameplay uses vanilla modifiers, no autoplay or free retry. Pausing, leaving the tab, or abandoning gameplay ends the attempt; its payment remains in the pot.
5. The result screen shows **Submit / recheck proof** above local results. The scoring server produces and submits the proof; the web polls queued/capturing/proving/submitting/confirmed/failed states. Success requires two confirmations, an exact `ScoreRecorded` receipt, and the paid entry's consumed score flag read directly from Sepolia. Local score displays are not proof success and can differ from the circuit's score formula.
6. Choose a UTC date to settle a past round. Anyone can send the prize to its recorded winner. With no accepted score, the connected payer can refund all their day's entries. These reads and writes do not use the indexer.

If the indexer is delayed or offline, top-20 rankings are unavailable or marked by their indexed block/lag; direct-chain pot, best, winner, claims, refunds and transaction checks remain available. Previously loaded chart mappings are cached so a prover outage does not hide settlement either. New paid entry always requires fresh scoring server readiness.

Paid entry receipts and pending replay/job IDs are saved locally. Expand **Your saved paid attempts** to retry or recheck a proof after navigating away. An entry with no saved replay cannot replay for free. Browser storage is convenience only; contract state remains authoritative. Keep the result screen open during proving when storage is disabled/full. The scoring server must preserve or recover jobs across restart for browser recovery to work after a server restart.

## UTC cutoff

The client reserves `max(chartSetup.durationSeconds, beatmap.total_length) + 5` seconds for gameplay/loading, plus the operator's measured `provingBufferSeconds` for proof generation and confirmation. It checks again after allowance approval, using the later of local clock and latest block timestamp. The contract remains authoritative and rejects day mismatch/late scores. The UI buffer reduces failed entries but cannot guarantee deadlines under network delays or a stalled prover.

## Bridge contract

`GET /charts/:webBeatmapHash` returns:

```json
{
  "webBeatmapHash": "64 lowercase hex characters, without 0x",
  "chartHash": "0x followed by 64 hex characters",
  "device": "0x device address",
  "chainId": 11155111,
  "leaderboard": "0x deployed address",
  "durationSeconds": 120,
  "provingBufferSeconds": 180,
  "ready": true,
  "captureMode": "hardware"
}
```

The numeric times above illustrate the schema, not measured values. `ready:false` can include `reason`. `captureMode` is exactly `hardware` or `software-demo`.

- `POST /sessions/:sessionId/start`: `{sessionId,entryTxHash,player,chartHash,dayId,webBeatmapHash,captureMode}` → `{sessionId,captureMode}`. Must bind to the confirmed paid entry and registry session. Must be idempotent; React development lifecycle can repeat initialization.
- `POST /sessions/:sessionId/proof`: `{replay,timing:{chartDelayMs},webBeatmapHash}` → `{jobId}`. Must be idempotent for the paid session, and reject mismatched chart/session/modifiers.
- `GET /jobs/:jobId`: `{status,message?,transactionHash?}` with the statuses above. `confirmed` requires a transaction hash. Errors use HTTP error status plus `{error:string}`.

`replay` is the existing `ReplayDataV2`: `{version:2,beatmap,mods,inputs,timestamp?}`. Each input is `[column,timeMs,isDown]`, where columns are 0–3 and `isDown` is boolean. The scoring server must preserve same-timestamp event order.

The existing practice `beatmap.hash` hashes UTF-8 re-encoded text and stays unchanged for replay compatibility. The new `Beatmap.sourceHash` / `BeatmapData.sourceHash` hashes the exact `.osu` archive bytes, including a BOM if present. This is the scoring server lookup identity. The scoring canonical `chartHash` is a separate registered parsed-chart identity; neither browser hash may be substituted for it.

The replay recorder uses `timeElapsed + audioOffset`; parsed notes use `originalNoteMs + delay - audioOffset`. Thus canonical input time is `replayInputTimeMs - chartDelayMs`. The scoring server independently computes `chartDelayMs = max(1000 - firstNoteMs, 0)` at playback rate 1 and rejects non-vanilla modifiers. Browser replay is not a hardware signature. In hardware mode the scoring server must use the physical device's sealed trace and verify its session/header/trace signature. Physical capture needs a synchronized playback-start/clock adapter: the initial HTTP start occurs after asset loading but before Pixi/audio initialization, so its wall-clock arrival alone is not an exact song-start cue.

## Verification

```sh
npm run test:leaderboard
npm run typecheck
npm run build
```

The automated tests cover UTC boundaries, conservative entry cutoff and missing measurement failure, exact entry receipt binding, forged emitter/wrong day/player/payer/device/amount, reverted transactions, accepted zero scores, and rejection of unrelated proof receipts. A funded-wallet browser demo, phone QR pairing and real proving performance measurement remain separate integration checks; physical hardware is currently outside the requested scope; compilation and simulated receipts do not prove them.

For isolated local integration testing, Vite development mode accepts `VITE_DEVELOPMENT_CHAIN_ID=31337` plus `VITE_LOCAL_RPC_URL` and a matching local deployment/scoring server/indexer. The UI explicitly labels Foundry instead of Sepolia. Production builds ignore the development-chain override and always use Sepolia. A locally injected test wallet is a test fixture, not evidence of phone-wallet pairing.

The opt-in browser test is `CHROME_EXECUTABLE=/path/to/chrome node tests/browser-local.mjs`. It requires the local 31337 deployment manifest, the running scoring server on 8091 configured for `tests/fixtures/daily-demo.osu`, and the dev client on 3015. It refuses non-loopback RPC and non-31337 chain IDs, mints local test USDC, injects an unlocked local test wallet, completes actual gameplay, and submits that game's recorded replay to the real prover. It does not generate a synthetic replay or bypass the entry UI. It writes screenshots and replay evidence under `/tmp`. The test intentionally leaves the indexer unconfigured.

Proof recovery checks on-chain session consumption first. A missing scoring server job can resume the same paid session and saved replay once; an already accepted session finishes without another submission. A terminal job can only offer an explicit retry when the scoring server marks it `retryable:true` (no broadcast transaction); retries with an existing transaction hash are prohibited by the scoring server. The scoring server persists submitted transaction checkpoints and reconciles them after restart.

### WalletConnect QR compatibility

`cuer` currently requests a borderless matrix (`border: 0`), but its broad `qr: ~0` dependency permits encoder releases that reject that option and crash the dialog. The scoped npm override pins `cuer` → `qr` to 0.5.5. Keep it until the renderer supports newer encoders; the QR regression test exercises the actual renderer entry point.

With a project ID configured and the local server running, run `CHROME_EXECUTABLE=/path/to/chrome node tests/browser-qr.mjs` to check the rendered QR without pairing or signing. A real screenshot was independently decoded as a WalletConnect v2 URI. Physical phone pairing remains a separate check. Do not commit pairing URIs or QR screenshots.
