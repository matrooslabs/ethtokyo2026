# PR 4 — persistent leaderboard indexer and HTTP API

Status: implementation complete; local acceptance passed. No commits, pushes or branch changes performed. No contract or Web-Osu-Mania files edited.

## Delivered

- Standalone `leaderboard-indexer/` package: native JavaScript, viem and Node's built-in SQLite; locked npm dependencies and explicit environment configuration.
- Exact ABI adapter for all five `DailyLeaderboard.sol` events, verified against the compiled Solidity ABI. Maps `beatmapId` to API `chartHash`; preserves bytes32 session IDs, payer/player distinction, device, amounts, and block/transaction/log provenance.
- Paid attempts, accepted scores, per-wallet daily bests, deterministic rankings, leader history, prizes/refunds, chart totals, metadata and wallet history. Ties preserve the first acceptance of that best score, including transaction/log order; zero scores are valid.
- Read-only HTTP API with validated filters, bounded pagination, optional snapshot-hash consistency guard, CORS, sync status, and explicit reconciliation errors. API contract was published early and coordinator notified for web integration: [pr4-api.md](pr4-api.md).
- SQLite canonical block/event journal, atomic checkpoints, idempotent duplicates, conflict detection, resume/backfill, full deployment replay, unbounded common-ancestor reorg rollback, empty-block checkpoints and mixed-fork rejection.
- Historical contract reconciliation at the indexed block: total paid/refunded, leader, highest score, prize-claimed state, remaining pot, player best records and payer payment balances. Tip hash rechecked after reads; mismatches and unavailable historical reads are visible and fail finite sync runs.
- Configurable chain/address/deployment block/RPC; startup verifies actual RPC chain ID and code at deployment block. No invented deployed address/block, live network claims, or signing credentials. Sepolia chain ID is the selected example only.
- [Runbook](../../leaderboard-indexer/README.md) documents startup, restart/rebuild, configuration, metadata, API behavior, reconciliation semantics and operating limits.

## Verification evidence

Executed from `leaderboard-indexer/` on 2026-09-26:

```text
RUN_ANVIL_TESTS=1 npm test
tests 14
pass 14
fail 0
skipped 0
```

Coverage includes:

1. All actual Solidity event layouts; zero-score/leader decoding; bytes32 session identity; malformed event rejection.
2. Event signatures/indexed fields and getter output types match compiled `out/DailyLeaderboard.sol/DailyLeaderboard.json`.
3. Historical reconciliation success, detailed mismatches and unavailable-read errors.
4. RPC address/range isolation and configuration validation.
5. Zero/repeated/lower scores and same-block transaction/log tie ordering.
6. Chart/day isolation, payer/player distinction and payout/refund accounting.
7. On-disk restart, duplicate batches, empty blocks and deterministic deployment rebuild.
8. Reorg rollback across restart, removed scores/entries/prizes, and forks before deployment.
9. Atomic rollback on invalid events, conflicting duplicates and database identity mismatch.
10. Confirmation depth, RPC failure and inconsistent-fork logs without checkpoint corruption.
11. HTTP server routes, wallet history, pagination, changed-snapshot 409, validation and CORS.
12. Isolated local Anvil integration deploying the **real DailyLeaderboard** plus **TestUSDC and MockPaidRegistry**: actual transactions/events, first-accepted score tie, claim/refund, contract-read reconciliation, duplicate sync, disk restart, replay, and snapshot revert removing payouts/refunds and replacing the winner.

The Anvil process uses a dedicated local port and disposable unlocked accounts, and is terminated by the test. It does not access repository private-key files. Initial sandbox HTTP listen failed with EPERM; rerunning authorized tests outside the sandbox passed. The initial compiled-ABI path and test representation of omitted `indexed: false` were corrected before the final all-pass run.

`node --check leaderboard-indexer/src/main.js` passed. Dependency installation reported zero audit vulnerabilities. Context7 documentation consulted for viem event/log/read APIs, Node SQLite, and Anvil RPC/CLI behavior.

## Remaining operational gates and limits

- **Live Sepolia checks unavailable/not performed in this worker:** no verified deployed address, deployment block and RPC configuration were provided for this service. Supply the real deployment values and run `node --env-file=.env src/main.js --once`; require `reconciliation.status=ok` and inspect indexed lag before web demo acceptance.
- Local Anvil uses a mock registry score callback. It proves indexer/contract ABI and accounting integration, **not** actual proof generation/verification, hardware signing, or a two-wallet live-network demo. Those remain PR 2/3/5 integration gates.
- Run one indexer per database. Store/projections are intentionally simple: canonical events are kept in memory and rebuilt per batch; every indexed round/player/payer is reconciled each cycle. This fits a hackathon dataset, not high-volume production without further indexing/batching work.
- Metadata is operator-provided JSON, not an external chart crawler. Historical RPC state/log availability is required. Correct deployment-block configuration is essential because the contract cannot enumerate unknown rounds for reconciliation.

Changed paths: `leaderboard-indexer/**`, `docs/reports/pr4-api.md`, `docs/reports/pr4.md`.
