> Current claims use Sui wallet signatures only. World ID references in the historical
> evidence section describe the retired integration.

# versu! Forest challenge

## Source of truth

The Sui `competition::Challenge<CircleUSDC>` and `registry::Registry` are authoritative. One Forest of Clock Challenge registers **Easy and Hard as different GKR charts**, with a separate stake balance and nontransferable play credits for each difficulty. At creation, the organizer supplies an immutable UTC `started_at_ms` in the future. Only the exact interval `[started_at_ms, started_at_ms + 21,600,000)` accepts USDC purchases, paid starts and score recordings; the fixed claim window follows. The chain Clock enforces those boundaries; the browser shows countdowns but cannot choose or extend them. `registry::Session` accepts a score only after the registered Bridge signature and Sui-native GKR proof pass. `competition::record_score` requires a consumed paid session bound to the wallet, chart, device and Challenge. Each wallet retains its best score per difficulty.

## Credits and prize pool

During the scheduled six-hour window, **1,000,000 base units of Circle's six-decimal testnet USDC** buys three nontransferable credits for the **selected difficulty only**. Easy credits cannot start Hard, or vice versa; a start spends one of that chart's credits atomically with its paid session. Closing the tab, failing to score or interrupting a run never restores a credit. Easy purchases fund only the Easy pot; Hard purchases fund only the Hard pot. Claims require the player’s Sui wallet signature.

## Claiming and settlement

1. Both difficulties stop accepting paid starts and scores at the same six-hour on-chain deadline. Only Bridge-signed, GKR-verified paid scores rank; a local visual score never ranks.
2. During the fixed claim window, a scored wallet selects **one** difficulty. The wallet signs `register_claim` to select its scored difficulty. Each wallet may claim one difficulty per challenge; repeat claims for that difficulty are idempotent. A later switch is rejected. Wallets that do not claim may still appear in public score history but receive no prize.
3. After the claim window, either wallet can call `settle`. Each difficulty pays its five highest eligible scored wallets **40% / 20% / 20% / 10% / 10% of its own pot**. Recorded score breaks ties by earlier on-chain record order; claim arrival order does not set rank. Payout goes directly to the bound wallets, not an operator-selected recipient.
4. Missing positions are not redistributed to winners. `refund` returns each chart's remaining balance only to purchasers of that chart, pro rata by its purchase count with final-claim rounding handled on-chain. Historical challenges remain accessible for claim/refund without a controller. The claim window prevents an early payment from being displaced by a later higher score.

## Wallet and hardware flow

The standings and Easy/Hard toggle load no archive. A connected Sui wallet can buy three credits for the selected difficulty for **1 test USDC** during the on-chain scoring window; purchase does not require a Bridge, chart download, or proof-server preflight. Payment and credit issuance happen in one `buy_plays` transaction. For paid play, connect the registered Bridge and choose setup: only that action fetches the 18 MB `forest.osz` and checks its source/chart hashes. Device capacity and sufficient time to complete a signed score are required **to start**, not to buy. Starting spends one credit even if interrupted. Free practice loads only the 5 KB `daily-demo.osz` and never ranks. Only hardware-verified scores enter standings; after scoring ends, each wallet can claim one difficulty for a ranked payout. A 65-event debug board cannot finish Forest; the reported 38-event `--signature-only` sample from the keyed image did not check BN254 commitment.

With `VITE_WALLETCONNECT_PROJECT_ID`, the official Mysten WalletConnect Wallet Standard adapter adds a phone pairing QR. A compatible phone wallet must approve the **same atomic `buy_plays` PTB**; the QR alone is not payment. A plain Slush `sui:pay` transfer is intentionally not used because it does not grant plays. [ETHGlobal Tokyo 2026's Sui prize](https://ethglobal.com/events/tokyo2026/prizes/sui) recognizes programmable payment flows and vaults; it does **not** require Payment Kit. [Mysten's unmodified Payment Kit](https://github.com/MystenLabs/sui-payment-kit) either transfers the payment coin to a receiver or custodies it in its registry. Neither operation deposits that coin into the currently deployed prize vault, so Payment Kit is **not integrated** into this round. A fork, separate uncredited transfer, or false sponsor-use claim was rejected.

## Local dev simulation

From `Web-Osu-Mania/`, run `VITE_VERSU_MODE=dev npm run dev -- --port 3000` on an available port. The **player homepage uses the real Sui Wallet/USDC/Bridge flow in both modes**. The isolated in-browser simulation is an unlinked internal test harness at `/#_simulation` in Vite development only. There an operator chooses the mock start time up front, advances to it and to claim/settlement cutoffs, selects one of six mock wallets, and uses the mock-score shortcut to exercise the ledger. Internal controls do not appear on the player homepage. Simulated values live under `versu:local-simulation:v1` and cannot be interpreted as Sui transactions, Bridge proof, World verification or real payouts.

Without the dev flag, both preview and build use the real Sui/Bridge path. `npm run build` compiles only the real production player flow because the internal harness is gated by `import.meta.env.MODE === "development"`; inspected production artifacts contained no simulator labels, mock wallet or mock-score text. The build strips a copied local `.dev.vars` from its server output.

## Start the local stack

From the repository root, run:

```sh
./start-sui.sh
```

The launcher installs missing Node dependencies, incrementally builds the current Rust
hardware prover, starts it on `127.0.0.1:8092`, and starts the web app on `127.0.0.1:3000`.
It verifies the web scoring proxy, matching package/Registry IDs, and SRS fingerprint
before reporting readiness. Ctrl-C stops both services and their child processes.
No Cloudflare login, World ID service, EVM indexer, or deployment transaction is required.

It reads the committed wallet-only testnet receipt by default and updates public IDs in
`Web-Osu-Mania/.env.local`. It preserves other settings and configures matching private
scoring credentials in `Web-Osu-Mania/.dev.vars` and ignored `artifacts/local-stack` files.
Logs and proof jobs also live under `scoring/gkr-scoring-sui/artifacts/local-stack/`.
The startup check establishes service connectivity, not a successful hardware gameplay proof.

```sh
# If the default ports are occupied:
WEB_PORT=3001 PROVER_PORT=8093 ./start-sui.sh
# Start, check connectivity, and shut down:
./start-sui.sh --check
# Use another already-activated deployment and its matching SRS:
SUI_DEPLOYMENT_FILE=/path/to/deployment.json SUI_SRS_FILE=/path/to/srs.bin ./start-sui.sh
```

Prerequisites: Node 22+, npm, Rust/Cargo, curl, and the matching Sui SRS file (the current
ignored `scoring/gkr-scoring-sui/artifacts/dev-srs-24.bin`). Connect the provisioned Bridge
to the computer over USB, open the app in a WebHID-capable browser, and connect a Sui
testnet wallet funded with gas and test USDC. Hardware must match the registered device.
A phone wallet additionally needs `VITE_WALLETCONNECT_PROJECT_ID` in `.env.local`.
The launcher does not flash hardware, mint tokens, generate an SRS, or reset challenge deadlines.

## Operator configuration

The testnet deployer is `scoring/gkr-scoring-sui/scripts/deploy_forest_challenge.mjs`.
Run `--prepare --srs <SRS-file> --out <deployment-directory>` to publish the Move package,
create a Registry, and register Easy and Hard. This writes `deployment.json` and does not
start a challenge. Then run `--activate --out <same-directory> --start-at <UTC-timestamp>
--device-pubkey <compressed-secp256k1-public-key> --bitstream-hash <32-byte-image-hash>`.
The start, six-hour gameplay window, and claim deadline are immutable. For the explicitly
unsafe testnet demo, add `--insecure-demo`; the bundled development SRS permits forged proofs.

Copy the manifest's `browserConfiguration` to `Web-Osu-Mania/.env.local`. The browser
and scoring service must use the same package, Registry, challenge, and chart hashes.
The server needs `SUI_SCORING_ORIGIN` and `SUI_SCORING_API_TOKEN` for the scoring proxy.

Claims require only the player's Sui wallet. During the claim window, `register_claim`
uses the transaction sender and their best on-chain score for the selected difficulty.
Each wallet can select one difficulty, retries for the same difficulty are idempotent,
and no wallet can register another wallet's claim. There is no World ID, nullifier,
IdentityCap, or identity-attestor service. Multiple wallets are not restricted by human identity.
After claims close, anyone can settle the top five of each independent difficulty pool;
unused shares refund that pool's purchasers.

The Bridge still gates gameplay and signs the scoring trace. World ID removal does not
replace hardware proofs or relax the recorded-score requirement.

## Current wallet-only testnet deployment

Package: `0x08232a7e6c08dce4bf52508f53eba6fd16dd24063fdfcc305eb955270217ce5e`.
Challenge: `0xadc2d90a9561fbcc857100ab25417906121e99c2eb01ced08c91cba55a49b1d9`.
Scoring: **2026-09-26T22:57:04.609Z–2026-09-27T04:57:04.609Z**; claims close **2026-09-28T04:57:04.609Z**.
The confirmed public receipt is [wallet-claims-testnet-20260927.json](../scoring/gkr-scoring-sui/docs/wallet-claims-testnet-20260927.json).
This is an explicitly insecure development-SRS demo. Wallet-only claims do not enforce one-person uniqueness.

## Historical checks before wallet-only claims (superseded deployment)

The revised `sui move test` passed **106/106**, including cross-difficulty credit/refund rejection, isolated six-buyer payouts and six-hour boundaries. After the direct-purchase UI change, web typecheck, Vite production build and Node 22 `npm test` passed **20/20**. Browser views showed separate Easy/Hard pots and Hard-specific pricing without fetching `forest.osz`; 390px had no horizontal overflow. The user requested removing the visible insecure-testnet warning; the manifest and this operator document still disclose the risk. The local scorer points to the current package/Registry and no longer shows a mismatch. A wallet-signed Circle USDC **purchase and paid start have since been confirmed on the immediate round**, but no signed score, full Bridge capture, World claim or payout has been observed.

The obsolete shared-pot testnet package `0x457a5171b67aa48a39808d077e83ee7faf5b51da2ab8172327d8c33fc1d7ef13` cannot be upgraded. Attempting its activation registered the reported public device in its Registry (`FkGgTQ5RdgLLCHFhD9Qrp6cayyeiEHb33Ww35eWvVJcq`), but creation failed simulation because the old published ABI lacks the claim-window argument. **No Challenge was created on that package; do not use it for purchases.** The deployer now rejects the obsolete ABI before any new device registration. Its manifest remains `device-registered` for an auditable failed cutover.

The **difficulty-isolated testnet package** is `0x4228773d3e5e12591cd66ec0496b5046902c5ff36b5c62bad6456ee2e165e0b6`, Registry `0x1de4fa11cbd08a59d0fd15905d8d4b0577731a566b7b5874b3454d98c1050423`; Easy/Hard registration receipts are `3oWZunNZ4iy9EZ1FdgQpaYu7cb752Ph3cBduzdbM62ga` / `8ts23vxQesEXJSyVpZRhijEFQiQsnvKkCgqgGrt7kMS3`. A previously created Challenge `0x6010d33b5d94d078602e4b57e4f9daadd59931cee6ca044a6f7edd518241240c` remains scheduled for **2026-09-27 12:00 UTC** and cannot be cancelled; do not direct buyers there. To honor the requested immediate start, `create_forest_round.mjs` created **current Challenge** `0x7f69985284a3e8f06460dc8a3ce4f2bd268726c74d4141dde546194207fbd360` (tx `TucMvKq95BeCNDtCutzevRArUBCvx6JXKNnjNQavhBM`) reusing the same registered device and charts. Its immutable start is **2026-09-26 22:32:23 UTC / 2026-09-27 07:32:23 JST**; scoring closes **2026-09-27 04:32:23 UTC / 13:32:23 JST**, claims close 24 hours later. The new IdentityCap `0x1766e0eab10db92ccc9d4c3364cfa5912795ca5eb512b0b8d0f52867f0be8202` is still held by the organizer. The current `deployment.json` is `/tmp/forest-immediate-round/deployment.json`.

This is an **explicitly insecure testnet demo**, not secure hardware attestation: Registry SRS `0xcd199354a4ea127f32c21fc6f56863a42af6df3133bef40702f8d9d0a1326a84` has a known toxic secret. The matching keyed-board public identity labels its private signer `EXTRACTABLE_FROM_SD_IMAGE`, `hardware_root=false`, and `bitstream_attestation=false`; the supplied hash is a build marker. The user's 38-event `--signature-only` result checked the recovered signature and trace root but **skipped BN254 commitment recomputation**. Scores/prizes could be forged. The local prover is configured for this Registry and answers the site's scoring info request, but no full paid Forest capture/proof was observed.

At verification, the current Challenge object showed **1,000,000 base units of Circle test USDC in each pool** and one purchaser. Confirmed `PlaysPurchased` events `2XRjsMAgK9CqFH7ZLMgcTiHr3gZhq6ChzCEQGgDYQkNt` (Easy) and `E8VaEWgukzKnaiiE3wr7HA9EjvwX56jm4xiedmpFy6aw` (Hard) each issued **three chart-specific credits** to wallet `0x9738724791208f24cd6cf68435a4c940fcdb544a7755209e22b948a0caf4b414`. `PaidAttemptStarted` events `CR1HWBF15ppRLEgwJ1QX82K2K9GHmAPm5DBcEtn9Mqox` (Easy) and `647C1iXmp2U2EjxJWccdb4gsZMZdoaZw3W625FGnnDzB` (Hard) each consumed one chart-specific credit and left two. No `PaidScoreRecorded` event for this round was observed. `Web-Osu-Mania/.env.local` and Worker public mapping point to the immediate Challenge; the older scheduled round remains listed for historical claims. The RP signing secret, dedicated Worker IdentityCap signer, verified Portal action, valid Reown project and physical full-chart Bridge capture are still missing; claims remain unconfigured despite the on-chain purchases. Transfer the cap to a dedicated funded service wallet and configure secrets outside the repository before claims open.
