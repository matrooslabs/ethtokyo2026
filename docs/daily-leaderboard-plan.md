# Daily beatmap leaderboard execution plan

Status: execution started. Coordinator maintains this file; workers report evidence in `docs/reports/`.

## Approved rules

- Each attempt costs 1 USDC; pots are isolated by canonical chart hash and UTC day.
- Day ID is `block.timestamp / 86400`; entry and verified score acceptance must precede the next UTC midnight.
- A wallet may make multiple attempts; retain its best verified daily score on-chain.
- Highest score wins the entire daily pot. First accepted score wins ties. Zero is a valid score.
- Claims become available at midnight with no scheduler/finalization transaction.
- If no verified score was accepted, each payer may reclaim that day's payments. Otherwise unfinished attempts also fund the winner.
- Payment must precede session creation, atomically. Bind payer, player, chart, day and paid session. Unpaid sessions cannot win.
- Fixed payment token, fee and registry; organizer cannot withdraw pots or select winners.
- Indexer provides rankings/history/metadata; contract remains authoritative and claims work without the indexer.

## PR 1 — Daily leaderboard state and settlement

Implement DailyLeaderboard with per-chart/day rounds, wallet best records, paid entries, accounting, authorized verified-score recording, claims, no-score refunds, events and getters. Use a mock registry for isolated tests.

Acceptance: UTC boundaries, zero scores, ties, repeated attempts, replay/unauthorized recording, duplicate claim/refund prevention, cross-chart/day isolation, transfer failures and accounting conservation.

## PR 2 — Connect paid entries to verified gameplay

Add a leaderboard-authorized registry session opening path and atomic paid-session callback after proof verification. Preserve unpaid/test sessions, enforce strict day cutoff, and reject stale expectedDayId entries. Maintain chart/device administration semantics.

Acceptance: real proof integration from payment through claim; failed payment, session creation, proof or callback leaves no partial state; no yesterday score accepted at/after midnight.

Depends on PR 1.

## PR 3 — Deployment and operational configuration

Resolve deployment ordering/wiring; configurable target network and USDC; deployment scripts and machine-readable address/ABI manifest; chart/device/organizer runbook; smoke test.

Acceptance: local and selected test-network deployment with verified wiring and complete smoke flow; actual proof mode fits network transaction limits. Network credentials, signer and hardware availability must be established, never invented.

Depends on PR 2.

## PR 4 — Indexer and leaderboard API

Index entries, scores, leaders, payouts/refunds. Provide paginated rankings, wallet and attempt history, beatmap totals and metadata. Order ties by block/transaction/log. Support restart, deduplication, backfill, reorg rollback and sync status.

Acceptance: deterministic rebuild, idempotent processing, reverted data removed, leaders/pots reconcile with contract reads.

Depends on PR 2 event ABI; may overlap PR 3.

## PR 5 — Web payment, leaderboard and claim flow

Integrate wallet and phone-wallet QR payment; start paid play only after confirmed entry; show UTC deadlines, personal best, rankings and pots. Cut off new entries using song duration plus measured proving buffer. Show proof progress/errors; direct-chain claims/refunds and payment tracking independent of indexer.

Acceptance: two-wallet flow with repeated attempts, tie, UTC rollover, no-score refund and delayed/unavailable indexer; complete selected-network demo with actual hardware/prover before final completion.

Depends on PRs 3 and 4.

## Execution and verification

- Preserve existing user work. Workers own disjoint paths and must not commit unrelated files.
- Keep PR-sized changes separately reviewable; create draft PRs when GitHub access permits, do not merge automatically.
- Use Context7 for library/API/CLI usage documentation as required by AGENTS.md.
- Each worker reports exact checks, results, changed files and unresolved gates in `docs/reports/`.
- Coordinator verifies integration and all acceptance gates, records real PR links and external blockers below.

## Evidence / PR tracking

| PR | Implementation | Verification | Link |
| --- | --- | --- | --- |
| 1 | Pending | Pending | Pending |
| 2 | Pending | Pending | Pending |
| 3 | Pending | Pending | Pending |
| 4 | Pending | Pending | Pending |
| 5 | Pending | Pending | Pending |

Target network: Ethereum Sepolia, explicitly selected by the user. Deployment signer: local `./.priv-key`, explicitly authorized by the user; never log or commit its contents. GitHub access verified.

External gates to establish: funded deployer/organizer, USDC, registered hardware device and accessible proof-generation path, wallet QR project configuration.
