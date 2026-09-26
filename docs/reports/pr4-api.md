# PR 4 leaderboard API contract

Base URL is deployment configuration (local default `http://127.0.0.1:8787`). All endpoints are GET, unauthenticated, and read-only. Amounts, scores, day IDs, chain IDs and block numbers are decimal **strings**; addresses, chart hashes and bytes32 session IDs are lowercase hex. `chartHash` maps to the contract's `beatmapId`. USDC amounts are base units. No live address or network is assumed.

List responses: `{ items: [...], total: number, limit: number, offset: number, nextOffset: number|null, indexedBlock: string|null, indexedBlockHash: string|null }`. Supply `limit` (default 50, max 200), `offset` (default 0). Pagination is over the current indexed snapshot; optionally pass `atBlockHash` from the prior response: changed snapshots return 409, so restart pagination. Invalid input returns 400; missing resources return 404; errors are `{ error: string }`.

| Route | Result |
| --- | --- |
| `/status` | Sync status: `chainId`, `address`, `deploymentBlock`, `indexedBlock`, `indexedBlockHash`, `headBlock`, `targetBlock`, `lag`, `confirmations`, `syncing`, `lastSyncedAt`, `lastError`, `reconciliation` |
| `/charts` | Paginated charts: `chartHash`, `metadata` (object or null), `entries`, `acceptedScores`, `totalPaid`, `totalPayouts`, `totalRefunds`, `remainingPot`, `rounds` |
| `/charts/:chartHash` | Same chart summary plus snapshot fields |
| `/charts/:chartHash/rounds` | Paginated rounds, newest day first |
| `/charts/:chartHash/days/:dayId` | Round: `chartHash`, `dayId`, `pot` (total deposited), `remainingPot`, `entries`, `acceptedScores`, `leader` (ranking row or null), `claimed`, `totalPayouts`, `totalRefunds`, plus snapshot fields |
| `/charts/:chartHash/days/:dayId/rankings` | One row per scored attempt, including repeated players: `rank`, `player`, `score`, `sessionId`, `acceptedAt: { blockNumber, transactionIndex, logIndex, transactionHash }` |
| `/attempts?chartHash=&dayId=&wallet=` | Paginated attempts in entry order: `sessionId`, `payer`, `player`, `chartHash`, `dayId`, `amount`, `entryAt`, `score` (null until accepted), `acceptedAt` (null until accepted) |
| `/wallets/:address/attempts` | Same as attempts, matching payer **or** player |
| `/wallets/:address/history` | Paginated entry, score, leader, payout and refund events in canonical chain order, `type`, event-specific fields and `position` |
| `/wallets/:address/bests` | Paginated best daily scores with `chartHash`, `dayId` and ranking row |
| `/settlements?chartHash=&dayId=&wallet=` | Paginated payouts/refunds: `type` (`payout` or `refund`), `chartHash`, `dayId`, `recipient`, `amount`, `position` |

Rankings include every scored attempt and sort score descending, then acceptance by block number, transaction index and log index ascending. Each attempt gets its own rank, even for the same wallet or equal scores. Zero is a real accepted score; unpaid or unscored sessions do not rank. The wallet bests endpoint returns only the highest-ranked attempt per chart/day. Refunds belong to the payer, which may differ from the player.

The indexer is eventually consistent. `/status` remains available during RPC failure; `lastError` and reconciliation expose failures. Chain claims/refunds and eligibility must use the contract directly. The API does not create sessions, accept scores, or initiate payments. Chart metadata comes from an operator-supplied JSON map keyed by canonical chart hash; unconfigured metadata is null.

Reconciliation status describes an explicit contract-read check at the indexed block and includes mismatches or errors. It is not an assertion that the latest chain head is indexed. CORS is configurable via `CORS_ORIGIN` (default `*`, no credentials).
