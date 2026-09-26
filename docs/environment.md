# Shared application environment

For the full install → deploy → register → run workflow, start with the
[root README](../README.md). This page details the shared environment and Sui setup.

Copy the root template once and fill in your WalletConnect project ID and any
deployment-specific values:

```sh
cp .env.example .env
```

In **each terminal**, start at the repository root and export the shared file:

```sh
set -a
. ./.env
set +a
```

The file is shell-compatible; quote values containing shell metacharacters.
Restart services after edits. The root `.env` is ignored by Git. Only `VITE_*`
variables are browser configuration; keep signer keys in local key files.
Exported variables take priority over component-local dotenv files, including
[Vite's environment files](https://vite.dev/guide/env-and-mode.html#env-files).
The root file is not automatically discovered without the export step above.

## Start components

Install each Node component's dependencies first with `npm ci --prefix <directory>`.
After loading `.env`, run one command per terminal, from the repository root:

| Component | Command |
| --- | --- |
| Web app (port 3000) | `npm run dev --prefix Web-Osu-Mania` |
| Indexer (port 8787) | `node leaderboard/indexer/src/main.js` |
| EVM HTTP prover (port 8091) | `scoring/target/release/mania-gkr-prove-server --bind "$EVM_PROVER_BIND" --srs "$SRS_FILE"` |
| Sui HTTP prover (port 8092) | `scoring/target/release/mania-gkr-sui-prove-server --bind "$SUI_PROVER_BIND" --srs "$SUI_SRS_FILE"` |

Build the Rust binaries with
`cargo build --manifest-path scoring/Cargo.toml --workspace --release --locked`.
The paid EVM game calls the scoring HTTP server directly. With `SCORING_CONFIG`
set, this process validates paid sessions and original hardware captures, then
returns Mode B proofs. The browser owns WebHID capture and wallet submission. The Sui HTTP prover remains a separate interface; the browser
competition is wired to EVM.

## Paid scoring configuration

```sh
mkdir -p scoring/data
cp scoring/config.example.json scoring/data/config.json
```

`SCORING_CONFIG` selects this file (or use `--competition-config`). Configure its
`rpcUrl`, new Mode B deployment `manifest`, `allowedOrigins`, registered
`charts`, and approved `hardwareSrs` bank mapping. No server signing key is used. Measure
`provingBufferSeconds` before setting `provingBufferMeasured: true`. Paths inside
the JSON are relative to `--project-root` (default: working directory).

Bind and SRS are passed directly to the scoring binary. No `proverUrl` or prover
subprocess is needed. Competition mode supports loopback clients only. Optional
`PROVER_API_TOKEN` protects the raw proof API; the paid browser routes use local
peer/Host/Origin checks. See the [scoring server guide](../scoring/crates/prove-server-evm/README.md).

The SRS files must exist and match the deployed verifiers. Fresh checkouts do not
include these ignored artifacts. See the [EVM prerequisites](../leaderboard/ops/README.md#fresh-checkout-proof-prerequisites)
and [Sui instructions](../scoring/gkr-scoring-sui/README.md). An environment file
alone does not generate keys/SRS files, fund accounts, or register charts/devices.

## Operations

Deployment and chart-registration scripts inherit the exported chain, RPC, key,
and artifact paths. No deployment happens when sourcing `.env`.
For an intentional demo deployment, explicitly set `ALLOW_INSECURE_DEMO_SRS=1`;
the template leaves this opt-in commented out. See [operations](../leaderboard/ops/README.md).

The template's address and deployment block come from the committed
[Sepolia manifest](../leaderboard/ops/deployments/11155111.manifest.json). For a
different deployment, update both backend and `VITE_*` values and the scoring JSON.
`KEY_FILE` configures deployment operations only. The scoring server is read-only on chain.

For a new Mode B deployment, explicitly set
`DEPLOYMENT_FILE=leaderboard/ops/deployments/${CHAIN_ID}.mode-b.json` on the deployment
command. Use the corresponding `.mode-b.manifest.json` for chart registration.
Deployment and smoke scripts read a private journal; chart registration reads
the public manifest. Preserve historical journals and use a new indexer database.

## Sui proof stack

Use the separate root [`.env.sui.example`](../.env.sui.example) for the Sui proof
engine, HTTP server, and Move verification demo. In a fresh terminal, from the
repository root:

```sh
cp .env.sui.example .env.sui
# Edit .env.sui for testnet or localnet, then load it.
set -a
. ./.env.sui
set +a

cargo build --manifest-path scoring/Cargo.toml --release --locked \
  -p mania-gkr-sui -p mania-gkr-sui-prove-server
npm ci --prefix scoring/gkr-scoring-sui/scripts
```

Use an existing matching BLS12-381 SRS. For a fresh demo setup only, generate the
known-tau development SRS (roughly 1 GB at `smax=24`); do not overwrite an SRS
used by an existing deployment:

```sh
mkdir -p "$(dirname "$SUI_SRS_FILE")"
scoring/target/release/mania-gkr-sui srs --smax 24 --out "$SUI_SRS_FILE"
```

Start the standalone HTTP prover:

```sh
scoring/target/release/mania-gkr-sui-prove-server \
  --bind "$SUI_PROVER_BIND" --srs "$SUI_SRS_FILE"
```

The on-chain end-to-end script invokes the CLI prover directly and does not need
the HTTP server. It **publishes a new package, creates a registry, and sends
transactions** on every run. To run it intentionally, in another terminal with
the same environment loaded:

```sh
node scoring/gkr-scoring-sui/scripts/sui_e2e.mjs \
  --network "$SUI_NETWORK" --rpc "$SUI_RPC_URL" \
  --srs "$SUI_SRS_FILE" --case "$SUI_E2E_CASE" \
  --modes "$SUI_E2E_MODES" --gas-budget "$SUI_GAS_BUDGET"
```

Testnet signing uses the active Sui CLI Ed25519 account in the default keystore;
check its address with `sui client active-address` and fund it with testnet SUI.
The script's `--network` and `--rpc` select the transaction network independently
of the CLI's active environment. The gas budget is per transaction, not per run.
Package, registry, and organizer capability IDs are printed during the run.

For localnet, use the three localnet overrides in the template and start a
[local network with a faucet](https://docs.sui.io/guides/developer/getting-started/local-network)
in a separate terminal (`sui start --with-faucet`). The script creates and funds
its own local account. `--force-regenesis` can be added for a deliberately fresh,
non-persistent network.

The `SUI_*` values above are shell inputs to the documented flags;
`PROVER_API_TOKEN` is read directly by the HTTP server. The template does not
configure the browser competition or leaderboard indexer for Sui:
those components currently implement EVM only. The Move stack proves and verifies
scores; it is not the EVM daily USDC-pot application ported to Sui.
