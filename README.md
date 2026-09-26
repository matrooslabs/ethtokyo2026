# ETH Tokyo 2026 — osu! hardware leaderboard

A browser osu!mania game with signed hardware input and on-chain score verification. Each paid attempt contributes 1 USDC to its chart's daily pot. The first player to reach the highest accepted score wins the pot; settlement opens after midnight UTC. If no score is accepted, payers can claim refunds.

The paid game uses **EVM Mode B**. The browser communicates with the board and submits transactions through the player's wallet. The local Rust server verifies the original capture and generates a proof. It needs no signing key or device connection.

```text
Board ── Keyboard HID ──> Game in browser
  └──── Vendor WebHID <─> Browser ── signed capture ──> Local Rust prover
                             <──────── proof ────────┘
                             │
                         Player wallet
                             │
                     EVM registry / leaderboard
                             │
                          Indexer ──> Browser rankings
```

The Sui proof stack is separate: it verifies scores with Move contracts, but is not connected to the browser's paid USDC competition.

## Components and ports

| Component | Location | Default endpoint | Needed for paid EVM play? |
| --- | --- | --- | --- |
| Web game + wallet + WebHID | `Web-Osu-Mania/` | `http://localhost:3000` | Yes |
| Local EVM prover | `scoring/crates/prove-server-evm/` | `http://127.0.0.1:8091` | Yes |
| Read-only leaderboard indexer | `leaderboard/indexer/` | `http://127.0.0.1:8787` | Rankings/history; settlement also reads contracts directly |
| EVM contracts | `scoring/gkr-scoring/contracts/` | Sepolia, or local Anvil at `http://127.0.0.1:8545` | Yes |
| Deployment / registration scripts | `leaderboard/ops/` | One-time commands | Initial setup |
| Hardware board | Existing bridgeos firmware, maintained separately | USB Keyboard HID + Vendor HID | Yes |
| Sui prover + Move verifier | `scoring/gkr-scoring-sui/`, `scoring/crates/prove-server-sui/` | `http://127.0.0.1:8092` | No; optional independent stack |

Run the commands below **from the repository root**. If a configured Mode B deployment, matching SRS and registered board/chart already exist, skip their creation and go directly to configuration and service startup.

## 1. Install dependencies and build

Prerequisites: Node.js 24+ with npm, Rust/Cargo, [Foundry](https://getfoundry.sh/) (`forge`, `cast`, `anvil`), and Python 3 for the chart extraction example. Hardware play needs a desktop browser with WebHID support, a wallet, and the provisioned board. Phone-wallet signing uses WalletConnect while the board stays connected to the desktop browser.

```sh
npm ci --prefix Web-Osu-Mania
npm ci --prefix leaderboard/indexer
npm ci --prefix leaderboard/ops

cargo build --manifest-path scoring/Cargo.toml --release --locked \
  -p mania-gkr -p mania-gkr-prove-server
forge build --root scoring/gkr-scoring/contracts
```

Copy the configuration templates once, keeping any existing configuration:

```sh
cp -n .env.example .env
mkdir -p scoring/data
cp -n scoring/config.example.json scoring/data/config.json
```

Edit `.env`, then load it in **every terminal** used for EVM components:

```sh
set -a
. ./.env
set +a
```

The root `.env` is not automatically loaded by all components. Exporting it makes it available to the web app, indexer and operations scripts. `VITE_*` values are exposed to the browser; deployment keys belong in `KEY_FILE`, not in `VITE_*` variables. Restart services after changing configuration. See [Vite environment behavior](https://vite.dev/guide/env-and-mode.html).

For frontend-only work, you can now run `npm run dev --prefix Web-Osu-Mania -- --strictPort` and open `http://localhost:3000`. Paid entry stays unavailable until the remaining setup is complete; starting the frontend does not deploy contracts or create a hardware fallback.

## 2. Choose the EVM network

**Sepolia:** keep `CHAIN_ID=11155111` and configure the RPC URLs. Fund the deployment account and player wallet with Sepolia ETH. The player also needs Circle test USDC; the deployment script uses the canonical Sepolia token address.

**Local Anvil:** start a node in its own terminal:

```sh
anvil --host 127.0.0.1 --port 8545 --chain-id 31337 --block-time 1
```

Interval mining allows the app's two-confirmation waits to complete even when no further transactions are sent. Set these values in `.env` and reload it in the other terminals:

```dotenv
CHAIN_ID=31337
RPC_URL=http://127.0.0.1:8545
VITE_DEVELOPMENT_CHAIN_ID=31337
VITE_LOCAL_RPC_URL=http://127.0.0.1:8545
DB_PATH=leaderboard/indexer/data/31337-mode-b.sqlite
```

Use one of Anvil's disposable funded accounts for local deployment and the player wallet. Store the deployment private key in the file selected by `KEY_FILE` (default `./.priv-key`). The key is used only by operations commands. With `USDC_ADDRESS` unset, local deployment creates `DemoUSDC`.

The browser's Anvil selection is enabled in development mode (`npm run dev`). An ordinary production build selects Sepolia. A fresh Anvil restart loses its chain state: redeploy using a fresh journal and update the service configuration/database rather than reusing stale addresses.

## 3. Prepare the EVM SRS and contract fixtures

Use the SRS matching both the verifier and the board's approved pinned G1 bank. Existing deployments bind their verifier key; preserve the artifacts used for them.

For a **fresh insecure development demo**, generate a known-tau SRS and matching fixtures:

```sh
mkdir -p scoring/gkr-scoring/artifacts/forge
scoring/target/release/mania-gkr srs \
  --smax 22 --seed 1 --out "$SRS_FILE"
scoring/target/release/mania-gkr export-forge \
  --srs "$SRS_FILE" --out scoring/gkr-scoring/artifacts/forge
```

Keep `VK_FILE` pointing at the exported `vk.json`. The generated SRS is development material, not production proof security. These commands create ignored artifacts; they are not needed when the correct artifacts are already available.

Compute the mapping for the board's pinned bank. For the bundled 260-point bank:

```sh
scoring/target/release/mania-gkr-prove-server \
  --srs "$SRS_FILE" --hardware-bank-points 260
```

The JSON output provides `bankHash`, `bankLength`, `maxEvents` and `srsId`. Compare it with the provisioned board before approving it. The bank hash is SHA-256 of contiguous G1 coordinates, **not** the SRS file hash or verifier ID. A 260-point bank holds only **65 events** and must be marked `developmentOnly: true`.

## 4. Deploy the Mode B contracts

This sends transactions using `KEY_FILE`. Use a new explicit journal so historical deployment addresses remain available:

```sh
ALLOW_INSECURE_DEMO_SRS=1 \
DEPLOYMENT_FILE="leaderboard/ops/deployments/${CHAIN_ID}.mode-b.json" \
  npm run deploy --prefix leaderboard/ops
```

The script deploys and wires the verifier, registry and leaderboard, plus `DemoUSDC` on Anvil when required. It writes:

- `${CHAIN_ID}.mode-b.json`: private deployment/recovery journal.
- `${CHAIN_ID}.mode-b.manifest.json`: public addresses, ABIs, SRS ID and deployment block.

Read the manifest and update `.env`:

| Manifest field | Environment values |
| --- | --- |
| `contracts.DailyLeaderboard` | `LEADERBOARD_ADDRESS`, `VITE_LEADERBOARD_ADDRESS` |
| `contracts.ManiaGkrRegistry` | `VITE_REGISTRY_ADDRESS` |
| `deploymentBlock` | `DEPLOYMENT_BLOCK` |
| `token` | `USDC_ADDRESS` if using the local funding command below |

Reload `.env` after editing. The addresses shipped in `.env.example` describe the historical deployment; copying the template alone does not configure new Mode B paid play. Use a separate indexer `DB_PATH` and prover `jobStoreFile` for the new deployment.

For an existing Mode B deployment, use its manifest instead of deploying again. Detailed deployment and recovery behavior: [operations README](leaderboard/ops/README.md).

## 5. Register the chart and hardware signer

The web app loads `Web-Osu-Mania/public/beatmaps/daily-demo.osz` by default. Extract its exact `.osu` bytes for registration:

```sh
python3 - <<'PY'
from pathlib import Path
from zipfile import ZipFile
with ZipFile('Web-Osu-Mania/public/beatmaps/daily-demo.osz') as archive:
    Path('scoring/data/daily-demo.osu').write_bytes(archive.read('daily-demo.osu'))
PY

DEPLOYMENT_FILE="leaderboard/ops/deployments/${CHAIN_ID}.mode-b.manifest.json" \
CHART_OUTPUT=scoring/data/daily-demo.chart.json \
  node leaderboard/ops/register-chart.mjs scoring/data/daily-demo.osu
```

The output file contains `chartHash`, `webBeatmapHash` and the source path. For another chart, serve its `.osz` through `VITE_BEATMAP_URL` and register the exact `.osu` file it contains. The web source hash depends on exact bytes, including line endings.

Obtain the real board's Ethereum signer address and bitstream hash from its provisioning information. With the registry organizer's key, register them:

```sh
# Set DEVICE_ADDRESS and BITSTREAM_HASH to the provisioned board's values.
cast send "$VITE_REGISTRY_ADDRESS" 'setDevice(address,bytes32,bool)' \
  "$DEVICE_ADDRESS" "$BITSTREAM_HASH" true \
  --rpc-url "$RPC_URL" --interactive
```

The interactive prompt takes the organizer private key. The board must already be running the existing firmware with its signer and approved SRS bank provisioned. Firmware/daemon installation is maintained outside this repository; this stack runs no hardware-adapter HTTP service. The browser implements the [board protocol](hid.md).

On **Anvil only**, fund the player's token balance after setting `USDC_ADDRESS` from the manifest and `PLAYER_ADDRESS` to the wallet address:

```sh
cast send "$USDC_ADDRESS" 'mint(address,uint256)' "$PLAYER_ADDRESS" 10000000 \
  --rpc-url "$RPC_URL" --interactive
```

This mints 10 local demo USDC. Use test USDC funding on Sepolia instead.

## 6. Configure paid proving and browser access

Edit `scoring/data/config.json`:

| Field | Value |
| --- | --- |
| `manifest` | New `${CHAIN_ID}.mode-b.manifest.json` path |
| `rpcUrl` | Same network as `RPC_URL` |
| `allowedOrigins` | `["http://localhost:3000"]` for the commands here |
| `confirmations` | `2` |
| `charts` | Entries like `{"osuFile":"scoring/data/daily-demo.osu","chartHash":"0x…","device":"0x…"}` |
| `hardwareSrs` | Approved bank mapping from step 3, including `developmentOnly` |
| `jobStoreFile` | Separate writable JSON file for this deployment |
| `provingBufferSeconds` | Measured time allowance for finalization, retrieval, proving, wallet interaction and confirmations |
| `provingBufferMeasured` | Set to `true` only after measuring the complete flow |

The zero hashes and empty chart list in the template are placeholders. A wrong bank hash prevents startup; an unmeasured buffer prevents paid readiness. Paths inside this JSON resolve relative to `--project-root`. There are no relayer-key or hardware-URL settings.

Check the remaining `.env` values:

```dotenv
VITE_SCORING_URL=http://127.0.0.1:8091
VITE_LEADERBOARD_INDEXER_URL=http://127.0.0.1:8787
CORS_ORIGIN=http://localhost:3000
SCORING_CONFIG=scoring/data/config.json
EVM_PROVER_BIND=127.0.0.1:8091
```

Fill `VITE_WALLETCONNECT_PROJECT_ID` with your WalletConnect project ID for phone-wallet QR signing. Extension wallets work without it. Optional `VITE_HID_VENDOR_ID` / `VITE_HID_PRODUCT_ID` narrow the device chooser; collection descriptors and signer/SRS checks still determine compatibility.

## 7. Start the services

In each terminal, start at the repository root and load `.env` as shown in step 1. Keep Anvil running if using the local network.

**Terminal A — local prover**

```sh
scoring/target/release/mania-gkr-prove-server \
  --bind "$EVM_PROVER_BIND" --srs "$SRS_FILE" \
  --project-root "$PWD" --competition-config "$SCORING_CONFIG"
```

**Terminal B — indexer**

```sh
node leaderboard/indexer/src/main.js
```

**Terminal C — web app**

```sh
npm run dev --prefix Web-Osu-Mania -- --strictPort
```

Open **http://localhost:3000**. Use this exact origin: `http://127.0.0.1:3000` is a different origin unless explicitly allowed. `--strictPort` prevents a busy port from silently moving the web app away from the configured origin.

In another terminal, check service health and chart readiness:

```sh
curl --fail http://127.0.0.1:8091/healthz
curl --fail http://127.0.0.1:8787/status
# Set WEB_BEATMAP_HASH from scoring/data/daily-demo.chart.json (no 0x prefix).
curl --fail "http://127.0.0.1:8091/charts/$WEB_BEATMAP_HASH"
```

`/healthz` only confirms that the prover is running. The chart response must have `ready: true`; the indexer's `/status` reports sync/reconciliation health. Missing rankings before an entry is indexed are normal.

To run only the raw EVM proof API without paid configuration, use a separate terminal/process:

```sh
env -u SCORING_CONFIG scoring/target/release/mania-gkr-prove-server \
  --bind 127.0.0.1:8091 --srs "$SRS_FILE"
```

Use this instead of the paid prover on the same port. Raw routes are `/v1/info` and `/v1/prove`; if `PROVER_API_TOKEN` is set, they require its Bearer token. Paid routes use loopback/Host/Origin checks. API details: [EVM prover README](scoring/crates/prove-server-evm/README.md).

## 8. Play, submit and recover

1. Connect the player wallet on the configured network.
2. Open the payment panel and select **Connect / reconnect capture board**. Check capacity and reported state; a new attempt needs IDLE.
3. Approve and pay 1 USDC. The app validates the confirmed registry session, preloads gameplay, sends the exact header and starts playback after the board acknowledges START.
4. Play with the board's Keyboard HID. Paid attempts cannot pause, seek, autoplay or silently resume after interruption.
5. At the end, the browser collects and checks the original result/trace, saves them in IndexedDB, then clears the board. Choose **Recover / prove / submit** and approve submission gas in the wallet.
6. Wait for proof transaction confirmations and the accepted-score check. The indexer then updates rankings.

After a refresh, use **Saved hardware attempts**. Wallet rejection retains the proof; known pending transactions are checked before another submission. Reconnect to recover a FINALIZED board result. A disconnected recording may have been discarded by firmware; ERROR needs explicit discard. The discard button permanently clears the board's data.

After midnight UTC, the competition UI exposes eligible claim/refund actions. Preserve old manifests, prover job files, browser records and indexer databases for historical settlement. Physical enumeration, timing and real-board on-chain acceptance are separate from simulator tests: [hardware rollout guide](docs/browser-hardware.md).

## Optional: Sui proof stack

Use a separate terminal and environment; EVM contracts, indexer and paid browser routes do not depend on this service.

```sh
cp -n .env.sui.example .env.sui
# Edit .env.sui, then load it.
set -a
. ./.env.sui
set +a

cargo build --manifest-path scoring/Cargo.toml --release --locked \
  -p mania-gkr-sui -p mania-gkr-sui-prove-server
npm ci --prefix scoring/gkr-scoring-sui/scripts
```

Use the matching **BLS12-381** SRS; the EVM BN254 SRS cannot be reused. For a fresh development setup only (roughly 1 GB at `smax=24`):

```sh
mkdir -p scoring/gkr-scoring-sui/artifacts
scoring/target/release/mania-gkr-sui srs --smax 24 --out "$SUI_SRS_FILE"
```

Start and check the optional server:

```sh
scoring/target/release/mania-gkr-sui-prove-server \
  --bind "$SUI_PROVER_BIND" --srs "$SUI_SRS_FILE"
```

From another terminal: `curl --fail http://127.0.0.1:8092/healthz`.

For on-chain verification, install the Sui CLI and follow the [Sui network setup](docs/environment.md#sui-proof-stack). With that environment loaded:

```sh
node scoring/gkr-scoring-sui/scripts/sui_e2e.mjs \
  --network "$SUI_NETWORK" --rpc "$SUI_RPC_URL" \
  --srs "$SUI_SRS_FILE" --case "$SUI_E2E_CASE" \
  --modes "$SUI_E2E_MODES" --gas-budget "$SUI_GAS_BUDGET"
```

This publishes a new Move package and registry and sends transactions on every run. Testnet uses the active funded Sui CLI Ed25519 account. The script invokes the CLI prover directly, so it does not require the Sui HTTP server. [Sui architecture and verification guide](scoring/gkr-scoring-sui/README.md).

## Verification and troubleshooting

```sh
npm run typecheck --prefix Web-Osu-Mania
npm run test:hardware --prefix Web-Osu-Mania
npm run test:leaderboard --prefix Web-Osu-Mania
npm test --prefix leaderboard/indexer
npm test --prefix leaderboard/ops
cargo test --manifest-path scoring/Cargo.toml --locked \
  -p mania-gkr-prove-server -p mania-scoring-core
forge test --root scoring/gkr-scoring/contracts --match-test testPaid
```

Contract tests require the generated SRS/forge fixtures. Optional browser persistence tests: `PLAYWRIGHT_CHANNEL=chrome npm run test:hardware-storage --prefix Web-Osu-Mania` with Chrome installed. The [hardware guide](docs/browser-hardware.md#local-verification-commands) also provides an isolated local-chain E2E test with a simulated signer; that test does not establish physical board compatibility.

| Symptom | Check |
| --- | --- |
| Prover exits while loading | SRS path, manifest path, approved bank hash and verifier SRS ID |
| Chart endpoint is not ready | Its `reason`; registered chart/device, Mode B wiring and measured buffer |
| Browser says deployment mismatch | Chain, registry and leaderboard addresses agree across `.env`, manifest and prover JSON |
| Origin rejected | Open `http://localhost:3000` and match `allowedOrigins` exactly |
| Payment waits for a second confirmation on Anvil | Keep interval mining enabled with `--block-time 1` |
| Indexer rejects its database | Use a new `DB_PATH` when chain/address/deployment block changes |
| Browser cannot select hardware | WebHID-capable desktop browser, secure context, vendor collection and provisioned firmware |
| Device reports overflow | Reported capacity; the bundled bank allows 65 edges, not 50,000 |
| Entry closes near midnight | Enough time must remain for the chart plus the measured submission buffer |

Other references: [environment details](docs/environment.md), [indexer API/setup](leaderboard/indexer/README.md), [shared scoring specification](scoring/SCORING_SPEC.md), and [FPGA reference material](scoring/gkr-scoring/docs/fpga/README.md). `osu-old/`, SP1 scoring, and the upstream GKR research fork are not required to run the current app.
