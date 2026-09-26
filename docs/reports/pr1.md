# PR1 — Daily leaderboard state and settlement

Implemented `DailyLeaderboard.sol`, `DailyLeaderboard.t.sol`; consumer ABI is documented in `pr1-abi.md`.

Fixed six-decimal 1 USDC entries; immutable token/registry; daily/chart isolated pots; payer/player binding; personal best with zero-score presence; first accepted score wins ties; strict UTC midnight close; permissionless winner-directed claims; payer-directed no-score refunds; non-reentrant token operations with optional-return handling and exact incoming balance checks. Atomic registry session boundary implemented against mock pending PR2.

Verification: `cd scoring/gkr-scoring/contracts && forge test --match-contract DailyLeaderboardTest -vv`: 9 passed, 0 failed, including 256 fuzz cases. Tests cover repeated attempts, zero/tie scoring, authorization and replay, UTC boundary/stale day, payer vs player, claim/refund replay and exclusion, cross-chart/day isolation, failed/short payment and session creation rollback, duplicate session rollback, payout transfer failure retry, entry/claim reentrancy and accounting conservation.

Real proof integration belongs to PR2. Token must be the fixed, non-rebasing USDC configured at deployment; fee-on-transfer tokens are explicitly rejected for entries.
