# Daily beatmap leaderboard execution plan

Status: contracts, GKR integration, indexer and Sepolia paid-proof smoke verified; local browser gameplay-to-proof flow verified; all six draft PRs published. Live midnight settlement and phone-wallet QR/pairing verification remain pending. Coordinator maintains this file; workers report evidence in `docs/reports/`.

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

Acceptance: two-wallet flow with repeated attempts, tie, UTC rollover, no-score refund and delayed/unavailable indexer; complete selected-network software-demo prover flow. Physical hardware integration and verification were explicitly removed from scope by the user.

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
| 1 | Complete | Contract and boundary tests pass | [#2](https://github.com/matrooslabs/ethtokyo2026/pull/2) |
| 2 | Complete | Real GKR proof integration; 36 Foundry test executions pass | [#3](https://github.com/matrooslabs/ethtokyo2026/pull/3) |
| 3 | Complete | Anvil full settlement; Sepolia paid proof/tie pass; live midnight settlement pending | [#6](https://github.com/matrooslabs/ethtokyo2026/pull/6) |
| 4 | Complete | 14 tests pass; Sepolia reconciliation: 6 reads, no mismatches | [#4](https://github.com/matrooslabs/ethtokyo2026/pull/4) |
| 5 | Complete | 8 unit tests; typecheck/build; actual local browser paid gameplay→GKR proof→accepted score pass; Sepolia readiness pass | [#7](https://github.com/matrooslabs/ethtokyo2026/pull/7) |

Target network: Ethereum Sepolia, explicitly selected by the user. Deployment signer: local `./.priv-key`, explicitly authorized by the user; never log or commit its contents. GitHub access verified.

Additional support PR [#5](https://github.com/matrooslabs/ethtokyo2026/pull/5) removes SP1, preserves the shared scoring core/fixtures and adds sealed-input GKR proving. GKR tests: 29 pass; shared core: 15 pass.

Deployer and test USDC funded; real GKR proving and Sepolia submission verified. User supplied the WalletConnect project ID; WalletConnect option renders; QR image/pairing and actual phone-wallet signing remain unverified. Physical hardware is out of scope at the user’s request. Live claim/refund verification must wait until 2026-09-27T00:00:00Z; local time-controlled verification already passes.

Demo trust limits: software signing does not attest physical gameplay, and the development known-tau SRS is not production-sound. No production security claim is made.

Review/merge order: #2 → #3 → #4 → #5 (SP1 removal/prover support) → #6 → #7. These are draft PRs and have not been merged. The remaining checks are explicitly incomplete; implementation publication is not a claim that those external checks passed.
