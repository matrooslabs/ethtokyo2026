# Daily leaderboard indexer

Read-only Node.js service for `DailyLeaderboard.sol`. Requires Node **22.13+** (built-in `node:sqlite`; Node 24+ recommended), npm, and an Ethereum HTTP RPC with historical logs and contract reads from the deployment block. No signing key is used.

```sh
cd leaderboard/indexer
npm ci
cp .env.example .env
# Fill RPC_URL, LEADERBOARD_ADDRESS and DEPLOYMENT_BLOCK from the real deployment.
node --env-file=.env src/main.js
```

Ethereum Sepolia (`CHAIN_ID=11155111`) is selected in the example. The program requires all identity fields explicitly and verifies the RPC chain ID and contract code at the configured deployment block. It does not assume a deployed address or block. `.env` is loaded only when Node receives `--env-file`; `npm start` uses variables already exported into the environment.

`HOST=127.0.0.1`, `PORT=8787`, `CONFIRMATIONS=2`, `BATCH_SIZE=100`, `POLL_MS=5000`, `DB_PATH=data/leaderboard.sqlite` and `CORS_ORIGIN=*` are defaults. Set `HOST=0.0.0.0` when exposing the service through your deployment's proxy. CORS allows GET/OPTIONS without credentials. Set `METADATA_PATH` to an optional JSON map keyed by canonical chart hash, for example `{ "0x<64 hex digits>": { "title": "Song", "artist": "Artist", "difficulty": "Hard" } }`. Metadata is loaded at startup; missing metadata is `null`.

Full HTTP routes and response shapes: [API contract](../../docs/reports/pr4-api.md). Contract `beatmapId` is exposed as `chartHash`; session IDs are bytes32 hex; chain amounts/scores/day/block values are decimal strings. Fees and pots use token base units. Unknown chart/day detail routes return 404 until indexed. Claims and refunds must remain available through direct contract calls even when this service is down.

## Backfill, restart and replay

```sh
# One finite catch-up and historical reconciliation, then exit.
node --env-file=.env src/main.js --once

# Stop the running indexer first. Clear this deployment's indexed history and
# replay every block from DEPLOYMENT_BLOCK, then reconcile and exit.
node --env-file=.env src/main.js --rebuild --once
```

Run **one process per DB_PATH**. Preserve the SQLite database and its WAL/SHM files together, or stop the service before copying its database. A database is bound to chain ID, contract address, deployment block and schema version; changing these requires a separate database. A failed rebuild can resume with `--once`; it never starts after the checkpoint of a failed batch.

The database stores every block header (including empty blocks) and normalized contract events. Each contiguous batch and its checkpoint commit in one SQLite transaction with WAL and full synchronous durability. Unique block/log identities deduplicate events; conflicting duplicates fail. All projections are rebuilt from canonical events, so restart/rebuild share exactly the same ranking implementation. Equal best scores retain their earliest acceptance by block, transaction index, and log index; zero is valid.

Every polling cycle finds the common canonical ancestor of the stored tip, rolls back all later headers/events, and replays the new branch. Rollback can reach before deployment, without a fixed reorg-depth limit. Blocks and logs are checked against the same hashes, including a final canonical-tip check before batch commit. RPC errors or mixed forks leave the last fully committed checkpoint; a later poll retries. A reorg during reconciliation sets an error and is rolled back on the next poll.

After catch-up, historical reads at the indexed block verify each known round's paid/refunded totals, leader, highest score, claimed flag, remaining pot, player bests, and payer payment balances. `refundablePayments` is historical paid balance even after a winning claim: it is **not** current refund eligibility. Reconciliation checks the tip hash again after reads and reports `ok`, `mismatch`, or `error`. Unknown rounds cannot be enumerated from the contract; correct deployment-block configuration and complete RPC logs remain prerequisites.

`GET /status` exposes indexed/head/target block, confirmation lag, polling state, last success/error, and detailed reconciliation results. An RPC outage after startup leaves the HTTP API serving the last committed snapshot and an error status. Startup configuration/RPC validation errors exit nonzero. A finite `--once` run exits nonzero on sync or reconciliation failure. API clients should inspect status; serving HTTP 200 does not assert current chain data. Use `atBlockHash` on later pagination requests to detect a changed indexed snapshot (409 means restart pagination).

This intentionally small implementation loads the canonical event history in memory and rebuilds projections per committed batch. Reconciliation reads every known round/player/payer each cycle. It suits a hackathon deployment; a large historical deployment will need materialized projections, header batching and incremental reconciliation before high-volume production use. There is no RPC failover, metadata crawler, public write/admin API, or scheduler required for claims.

## Verification

```sh
npm test
# Requires `anvil` on PATH and the contract worker's compiled Foundry artifacts.
# Uses its own local Anvil on port 19547; override ANVIL_PORT if necessary.
RUN_ANVIL_TESTS=1 npm test
```

The regular suite covers canonical ties, zero/lower/repeated scores, chart/day isolation, accounting, disk restart, duplicate processing, deterministic rebuild, deep rollback, atomic failure, RPC/mixed-fork failures, HTTP validation/pagination, ABI decoding, and historical reconciliation. The compiled-ABI comparison explicitly reports a skip when Foundry artifacts are absent. The opt-in Anvil integration deploys the real `DailyLeaderboard` with `TestUSDC` and `MockPaidRegistry`, drives entries/scores/claim/refund through transactions, validates real logs and reads, then snapshot-reverts and verifies rollback/reconciliation. It uses Anvil's public disposable unlocked accounts; no repository signing key is read. This proves indexer integration, **not** proof verification, hardware, or live Sepolia operation.

Implementation documentation was checked with Context7 against [viem getLogs](https://viem.sh/docs/actions/public/getLogs), [viem decodeEventLog](https://viem.sh/docs/contract/decodeEventLog), [viem readContract](https://viem.sh/docs/contract/readContract), [Node SQLite](https://nodejs.org/api/sqlite.html), and [Anvil](https://getfoundry.sh/anvil/overview).
