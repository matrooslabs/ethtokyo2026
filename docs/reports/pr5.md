# PR 5 — Web daily competition

Status: implemented and verified with actual browser gameplay and a real Rust proof on the isolated local deployment. Production network default is Ethereum Sepolia. Physical hardware was explicitly excluded by the user; software signing is prominently labeled and requires acknowledgment before payment.

## Changes

- Per-beatmap UTC daily competition panel: contract pot/leader/personal best, date selection, winner claim and no-score refunds. Top-20 rankings use the indexer with sync lag/deployment checks; settlement and transaction confirmation never depend on the indexer.
- Connected wallet approves exactly one USDC if needed, then submits entry and waits for two confirmations. Gameplay requires an exact EntryPaid match across contract, chart, day, payer/player, device and amount. Phone connection uses RainbowKit WalletConnect; extension wallets use its direct injected connector.
- Fresh bridge readiness, source-byte chart identity and measured buffer checks before spending; cutoff rechecked after allowance approval. Cache chart identity for settlement during bridge outages.
- Paid gameplay uses vanilla modifiers, forbids free retries and aborts on pause. Practice remains available. Default demo asset is an original four-note chart and generated tone audio matching the registered canonical fixture; configurable archive URL replaces the baseline's missing Forest asset.
- Result screen sends the actual recorded replay to the bridge, shows proof/job errors/progress, and independently checks proof receipts and the on-chain paid-session record. Persisted attempts/replays/jobs support recovery, including bridge restart and explicit prebroadcast retry.
- Corrected parser hold bit flags, right-edge lane clamp, EOF sections, chronological order and long-hold end time to align the rendered chart with canonical parsing. Live replay recording now suppresses orphan/duplicate key releases emitted by startup and finish/fail cleanup, without modifying historical signed hardware inputs.
- Public env example, detailed operator/protocol runbook, generated demo asset script, eight focused tests and an opt-in real browser integration test. Playwright is an explicit pinned development dependency.

## Evidence

Validation on 2026-09-26:

- `npm ci --ignore-scripts`: passed using the preserved dependency lockfile.
- `npm run test:leaderboard`: **8 passed**. Covers UTC rollover/cutoff/missing measurements; exact entry receipt bindings; rejected spoofed/reverted/unrelated proof receipts and accepted zero; hold flags/x512/EOF; actual startup+finish-style key cleanup.
- `npm run typecheck`: passed.
- `npm run build`: passed (client and SSR production artifacts).
- `CHROME_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node tests/browser-local.mjs`: **passed** against local Anvil 31337 RPC19549, bridge8788 and web3015. The real UI connected an injected test wallet, approved/paid one USDC, waited for entry confirmations, loaded the actual playable archive/audio, completed gameplay, submitted the recorder's zero-score replay to the Rust prover, and displayed the independently verified on-chain accepted score. **No browser runtime errors. Indexer unconfigured throughout.**

Actual browser proof evidence:

```text
player: 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266
session: 0x9aaf4b70b088427f6c291d56f78cfb2a83d610aa8573397106ca2cdd3b6948a5
proof transaction: 0xf2f7e1dd4ad513bf1d3354fcdc4aea12484e078fd8b41e74bb78751f3bb01b26
accepted score: 0
```

Local artifacts: `/tmp/web-browser-integration.log`, `/tmp/daily-leaderboard-browser.png`, `/tmp/browser-paid-proof.json`. The browser run exposed an empty-event ABI encoding bug in the bridge (`concat([])` returned bytes instead of hex); the coordinator fixed it and the real flow then passed. This was not counted as a success before rerunning.

## Scope and remaining manual checks

The automated browser test uses one local injected test wallet. The coordinator's separate contract/deployment verification covers repeated entries, two-wallet ties, settlement and refund rules, and real Sepolia proofs. A physical phone signature is not claimed. Real wallet latency and proving-buffer measurements must match the chosen deployment; local timings do not establish Sepolia latency. The signer bridge is a trusted loopback-only demo service, not a public unauthenticated relayer.

The user-provided WalletConnect project ID is in ignored `.env.local`; no signer key was read or copied into web configuration. WalletConnect option rendered in the real connect dialog with the supplied project configuration. The QR image was **not verified**: the brief check clicked WalletConnect but did not detect a large QR SVG within 30 seconds. No physical phone was connected. Further relay/pairing checks remain manual. No branches, commits or pushes were made by this worker.

Ignored `.env.local` was restored to the user-selected Sepolia board `0x35319a0232dfe355d1ab26641d0f77482b3ea1dd`, publicnode RPC, local bridge/indexer URLs and the original demo archive. The coordinator restarted the web server without development overrides and started the matching Sepolia bridge/indexer; the registered demo chart reports `ready:true` on chain11155111.

Final read-only live configuration check: the restored client on localhost3015 rendered **Daily prize · Sepolia**, fetched the registered original demo from the live Sepolia bridge, and enabled **Enter daily competition · 1 USDC** after software-demo acknowledgment. No wallet was connected and no transaction was sent in this readiness check.
