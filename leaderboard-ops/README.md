# Daily leaderboard operations

These commands run from the repository root. Install dependencies with `npm ci --prefix leaderboard-ops` and `npm ci --prefix leaderboard-bridge`. Build contracts with `forge build --root scoring/gkr-scoring/contracts`. Build the prover with `cargo build --release --manifest-path scoring/gkr-scoring/engine/Cargo.toml`.

## Deployment

`ALLOW_INSECURE_DEMO_SRS=1 KEY_FILE=./.priv-key npm run deploy --prefix leaderboard-ops`

Defaults: Ethereum Sepolia (11155111), publicnode RPC, Circle test USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`. Override `RPC_URL`, `DEPLOYMENT_FILE`, `VK_FILE`. Chain 31337 supports Anvil and deploys local-only DemoUSDC when USDC_ADDRESS is absent. No mainnet deployment path is supported.

The existing generated SRS has known tau and is **cryptographically insecure: demo only**. The explicit flag acknowledges this; it does not repair the SRS. A ceremony SRS and corresponding fixtures/VK must replace it for meaningful proof soundness.

Deployment order is relation → verifier → registry → token (local only) → leaderboard → one-time registry wiring. The organizer is the deployer. Scripts verify chain, code, all wiring, SRS ID, six token decimals and fixed one-USDC fee. They reject transactions exceeding 2^24 gas. Restart the identical command to resume. A private journal stores signed transactions before broadcast; rebroadcasting recovers the same transaction, not another deployment. Keep the ignored journal private. The exported `.manifest.json` contains public addresses, ABIs, deployment block, transactions and security label.

Do not delete an interrupted journal and restart on a funded public account: first inspect its transaction hashes. Do not change compiled bytecode midway through a journal. Use a new journal for an intentional new deployment.

## Chart and device enrollment

Register exact web `.osu` files with `node leaderboard-ops/register-chart.mjs map.osu` (same signer/RPC configuration). This checks 4K format, converts notes into canonical microseconds, uses the real KZG chart registration prover, registers on-chain, and writes `<source-sha256>.chart.json`. Add its `osuFile`, `chartHash` and the registered device address to bridge `charts` configuration. The exact-byte source hash identifies the web file; the canonical chart hash identifies the on-chain competition.

Only the registry organizer may call `setDevice(address,bytes32,bool)`. Use the actual device signer and bitstream SHA-256, not the player's or deployment wallet. Revoking/changing a device also invalidates its pending sessions. The organizer cannot choose a winner or withdraw pots. The leaderboard address can only be configured once.

Run `npm run smoke --prefix leaderboard-ops` for the smoke harness (see script environment settings). Local settlement tests advance Anvil time; Sepolia never time-travels and requires real UTC midnight for claim/refund.

For the existing Sepolia smoke round, resume after `2026-09-27T00:00:00Z` with `SMOKE_SETTLE_ONLY=1 npm run smoke --prefix leaderboard-ops`. Keep the original ignored smoke journal and demo signer files: this checks and settles the recorded sessions rather than buying new entries. The committed smoke manifest records completed paid-proof checks and explicitly marks live settlement pending.

## Fresh checkout proof prerequisites

All configured relative file paths (environment variables and JSON configuration) resolve against the repository root, including when npm changes its working directory through `--prefix`. Absolute paths stay absolute. `register-chart.mjs` input and `CHART_OUTPUT` follow the same rule; its default output is `<source-sha256>.chart.json` in the repository root.

Before the first deployment, generate local **known-tau, insecure demo-only** SRS and matching verifier/chart fixtures after building the Rust binary:

```sh
mkdir -p scoring/gkr-scoring/artifacts/forge
scoring/gkr-scoring/target/release/mania-gkr srs --smax 22 --seed 1 --out scoring/gkr-scoring/artifacts/dev-srs-22.bin
scoring/gkr-scoring/target/release/mania-gkr export-forge --srs scoring/gkr-scoring/artifacts/dev-srs-22.bin --out scoring/gkr-scoring/artifacts/forge
```

Use this exact SRS and its exported `vk.json` together. Existing deployments bind the SRS identity immutably; do not replace their SRS/VK with unrelated files. These files are generated and ignored, so fresh checkouts need this step. Generating this development SRS does not provide production proof soundness.
