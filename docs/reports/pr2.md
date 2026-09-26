# PR2 — Paid sessions integrated with verified gameplay

Implemented `ManiaGkrRegistry.sol` paid-session integration and `PaidRegistry.t.sol` real Rust-prover integration tests.

Registry organizer wires `setLeaderboard(address)` exactly once after deploying the leaderboard. Wiring checks the leaderboard points back to the registry. Only that leaderboard may open paid sessions; paid sessions use Mode A and exactly the next UTC midnight as expiry. Existing organizer unpaid Mode A/B sessions retain their behavior. A separate paid-session marker controls callback eligibility. Registry rejects paid submissions at midnight before expensive verification. After proof verification, recording and leaderboard callback occur atomically; callback failures revert session consumption, score, judgements and emitted events.

Deployment order: GkrRelation → GkrScoreVerifier → ManiaGkrRegistry → DailyLeaderboard(token, registry) → organizer calls registry.setLeaderboard(board). Register charts and hardware devices as before. No later organizer changes to the board connection are permitted.

Verification: `cd scoring/gkr-scoring/contracts && forge test --match-contract PaidRegistryTest --match-test testPaid -vv`: 6 passed, 0 failed. Tests generate actual session-bound GKR proofs using the Rust prover through FFI, sign hardware digests with a test device key, and submit to the actual verifier. Covered payment → proof → daily record → claim, malformed proof rollback, paid midnight rejection, revoked devices, payment/opening rollback, unauthorized paid opening, invalid expiry, one-time/authorized/back-reference wiring, unchanged unpaid verification with no prize eligibility, and callback-failure rollback after successful proof verification.

Paid demo submission measured 1,512,830 execution gas in the test; this excludes transaction intrinsic/calldata gas and is not the Sepolia transaction measurement. Real physical hardware and Sepolia deployment remain PR3/PR5 validation gates. The test key is explicitly simulated test hardware, not evidence of physical device operation.

Full regression: `cd scoring/gkr-scoring/contracts && forge test -q` completed successfully (exit 0) after integration. Includes existing verifier cases, tampering, mode A/B real proof submissions, expiry/revocation, relation checks, gas benchmarks, leaderboard unit/fuzz suite, and all paid integration tests.
