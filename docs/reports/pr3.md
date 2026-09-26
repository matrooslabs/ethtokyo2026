# PR3 deployment and operational configuration

Implemented `leaderboard-ops/deploy.mjs`, shared client/artifact helpers, chart registration CLI, local-only DemoUSDC, dependency lock, deployment runbook. Deploys relation/verifier/registry/leaderboard in order, journals signed transactions before broadcast for restart safety, exports public ABI/address manifest, checks chain, code, SRS ID, organizer, token decimals, entry fee and wiring. All transactions pre-estimated and capped at 2^24 gas. Key contents never logged; local key read only at execution. Sepolia uses Circle's test USDC and explicit known-tau insecure-demo SRS acknowledgment.

Bridge integration files are included with operational configuration and remain separately reviewable under `leaderboard-bridge/`: canonical .osu parsing, byte-identical source hashes, validated replay timing, real proof CLI adapter, confirmed paid-session binding, physical sealed-capture adapter protocol, explicit software-demo signing, bounded proof concurrency, on-chain submission and receipt check. Readiness fails without a measured configured proving buffer and active chart/device/prover/relayer. Physical device mode never substitutes browser input and verifies original session signature/root/header before preserved-seal proof.

Verification completed by deployment worker:

- `npm test --prefix leaderboard-bridge`: 3 passing protocol tests (source-byte/BOM identity, canonical timing, mods/key-state rejection, signed hardware seal challenge/trace binding).
- `node --check leaderboard-ops/deploy.mjs`, `register-chart.mjs`, `leaderboard-bridge/server.mjs`: pass.
- Dependency installation for both packages: 0 reported vulnerabilities.
- No live broadcast by this worker; coordinator owns live/local deployment, smoke and transaction evidence.

Physical hardware integration and verification are out of scope by explicit user request; retained adapter support has only test-double evidence. Proving buffer must be measured against actual workload. Known-tau SRS remains unsuitable for sound production proofs. Local and Sepolia deployment/smoke evidence is to be appended by coordinator, not inferred from these unit tests.
- Real `prove-sealed` invoked through Node proof helper on `scoring/fixtures/demo.json`: 8 events, 395 proof words, duration 2,636,500 µs; digest matches existing exported demo fixture. This exercises Rust/Node ABI decoding, not physical capture.

Coordinator's isolated Anvil was then used for bridge HTTP E2E (`BRIDGE_E2E=1 npm test --prefix leaderboard-bridge`): **5/5 passed**, including exact .osu mapping, real payment, bound start, wrong-player rejection, wrong-timing rejection, real Rust proof, relayed transaction and authoritative on-chain score 987500. Session `0x281964ce8226d946411aed4f6afc7b0bb57fb49a2cbf61ff23ec479fa6d658ac`; tx `0x7eee60743e0cfdde0398aa343196df1f0faed3ab7db34c0238d678fec523b563`. This test explicitly used software-demo signing. It does not verify a physical device. Canonical chart hash fixture agreement is the fourth protocol test.

Readiness also verifies board↔registry wiring, payment token, verifier SRS identity and configured .osu notes against canonical registered chart hash.

Preserved-seal adapter integration also passed with an explicitly named **hardware-adapter TEST DOUBLE** (`BRIDGE_E2E=1 E2E_CAPTURE_MODE=hardware npm test --prefix leaderboard-bridge`, 5/5): exact chain header and signed fixture trace served over adapter HTTP, bridge validates seal, Rust `prove-sealed` proves unchanged input, and on-chain score 987500 records in tx `0x1c0a2e7a78e50b17fcc48191f95428fd230d10fcde891ab0e475d203cf488b0e`. This verifies adapter protocol, signature and proof plumbing; physical hardware is unverified and now out of scope.

Review fixes and verification:

- Every ops/bridge configured relative file path resolves against repository root, independently of npm `--prefix` cwd. Absolute paths remain unchanged. Ops path unit passes.
- E2E now launches `npm start --prefix <bridge>` from `/tmp` with a repository-relative `BRIDGE_CONFIG`, manifest and `.osu`, proving documented prefix startup works.
- Jobs checkpoint starts, IDs and submitted transaction hashes; restart reconciles the same transaction. Interrupted prebroadcast jobs return 404 for frontend recovery. Failed no-hash jobs permit explicit `retry:true` only after open/unconsumed paid-session checks; jobs with any transaction hash are never resubmitted automatically.
- Hardware-adapter test double now injects a 503 seal failure, verifies `retryable:true`, verifies ordinary repost retains old job, explicitly retries, proves and records score987500, restarts the server, and checks the same confirmed tx survives. 5/5 tests pass; tx `0x10c1c379d5298231c8b5f9735a31c6bebbcdce15ff054fea3c5b054c8b75f423` on local Anvil.
- Fresh-checkout known-tau SRS/fixture generation commands documented; local31337 manifests excluded from version control.

## Coordinator deployment and settlement evidence

Sepolia leaderboard: `0x35319a0232dfe355d1ab26641d0f77482b3ea1dd`, deployment block11784156. Public deployment and smoke manifests are committed under `leaderboard-ops/deployments/`; private signer keys and signed-transaction journals are ignored.

Full local Anvil smoke passed: five paid entries, three real GKR proofs, repeated player best improvement987500→1000000, second player tie retaining first leader, duplicate proof rejection, premature claim rejection, UTC rollover, winner payment4USDC, no-score refund1USDC, duplicate claim/refund rejection and late otherwise-valid proof rejection.

Sepolia smoke passed payment/proof/tie checks using the explicitly labeled software signer. Proof transactions used 1,732,619, 1,696,068 and 1,707,255 gas. Highest-score transaction: `0xba9d6c7522243f3cd42e6ec114c2fc21be823c768898db04d252060a65bb2ce0`; tie: `0x052373270dddc4c5190c3f24abb2a8e2edaa80d097b2a67fa0f3570a0be9e4ac`. Tiny fixture proving times232.5/282.8/225.5ms do not establish a general workload buffer.

Live settlement is **not verified**: the day20722 round becomes claimable at `2026-09-27T00:00:00Z`. Resume using the documented `SMOKE_SETTLE_ONLY=1` command after that deadline; no time manipulation on Sepolia.

Sepolia indexer synchronized through block11784200 with two confirmations, zero target lag, and reconciliation status`ok`: six authoritative state reads, no mismatches (2026-09-26T05:39:14Z).

Final scope adjustment: physical-device verification was removed by the user. The delivered unauthenticated bridge is explicitly a local software demo. It now refuses LAN/public bind addresses and remote configured origins, validates literal loopback Host authorities (DNS rebinding defense), checks loopback peer addresses and requires JSON for POST. Same-machine users/processes remain trusted; reverse proxy/tunnel/shared hosting is unsupported. Two added access-control tests pass; full default suite 6 passed / 1 opt-in E2E skipped. Running browser service was preserved.
Final access-control E2E rerun: `BRIDGE_E2E=1 npm test --prefix leaderboard-bridge` **7/7 passed**, including real software proof and restart recovery under loopback enforcement; local tx `0xbe24776d8007a8e0918bac0210c1fe63b0b3086adc6a2d5016062a1c61e4e856`, score987500.

Browser integration exposed zero-input replay encoding: viem concatenation of an empty list returns a byte array, while the submission ABI requires a hex string. The bridge now explicitly returns `0x` for an empty trace; a regression test checks ABI encoding. Seven protocol/access tests pass (HTTP E2E separately opt-in). Actual no-input browser submission is being rerun.
