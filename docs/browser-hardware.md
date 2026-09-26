# Browser hardware paid play

Paid Mode B is a new deployment. Existing manifests and localStorage records are
historical and remain untouched. Run deployment tooling with a new journal
(default `<chain>.mode-b.json`); never overwrite an old deployment. Configure
`VITE_REGISTRY_ADDRESS` and `VITE_LEADERBOARD_ADDRESS` together, point the indexer
at the new board/deployment block, and register charts and device bitstreams.
The registry readiness check requires `PAID_SESSION_MODE() == 2` and verifies
verifier/leaderboard/SRS wiring before payment.

Use a desktop WebHID browser in a secure context (localhost is supported).
Connect the vendor collection using the explicit connect button before entering.
The app checks the descriptor, signer, registered bitstream, V2 policy, capacity,
and approved bank mapping. No VID/PID assignment is assumed. Keyboard input
continues through the separate Keyboard HID interface.

After confirmed payment, the browser reads the actual registry session and
compares its packed header with the local prover response. Audio/rendering load
before START, and playback starts after the response. Paid play has no added
intro delay, offset, autoplay, touch/gamepad scoring, seek, or resumable pause.
The proof trace always comes from the board; browser replay data is never uploaded.

At completion the browser waits for the chart tail, STOPs, retrieves the original
result and full trace, validates structure/root/signature, and stores bytes in
IndexedDB under chain/registry/session before ABORT. KZG verification remains
pending until the local prover verifies the approved SRS commitment. The wallet
simulates and submits `submitCommitted`, pays gas, then checks confirmations,
the accepted-score event and consumed session. Wallet rejection retains the proof.
Known transaction hashes are reconciled before requesting another transaction.

Refresh: open Saved hardware attempts. Reconnect the board if it still holds
FINALIZED data. Lost SET_HEADER/START/STOP responses are never blindly retried.
Inspect reported status; HEADER_LOADED/RECORDING interruptions do not resume play.
Board disconnect during recording may destroy that recording. ERROR requires
explicit discard. Discard asks before permanently ABORTing board data.

Before enabling entry, measure real START-to-playback latency, STOP finalization,
trace retrieval, Rust proving, wallet approval, and confirmation times; reserve
these in `provingBufferSeconds` and only then set `provingBufferMeasured: true`.
Do not shift signed timestamps to compensate for measured latency. If synchronization
is inadequate, keep entry disabled and resolve it with the hardware/game operators.

Simulator tests establish framing and sealed proof behavior only. Physical
acceptance still requires actual enumeration/report sizes, keyboard coexistence,
playback synchronization, complete trace retrieval, and on-chain acceptance with
the real board. The example config deliberately cannot be ready without the
approved bank/deployment and measured buffer.

## Local verification commands

```sh
npm run test:hardware --prefix Web-Osu-Mania
PLAYWRIGHT_CHANNEL=chrome npm run test:hardware-storage --prefix Web-Osu-Mania
npm run typecheck --prefix Web-Osu-Mania
cargo test -p mania-gkr-prove-server -p mania-scoring-core --manifest-path scoring/Cargo.toml
forge test --root scoring/gkr-scoring/contracts --match-test testPaid
# Isolated local node only; build Rust release binaries and matching forge fixtures first.
anvil --port 19549 --chain-id 31337
SCORING_E2E=1 node --test leaderboard/ops/test/e2e.test.mjs
```

The E2E test deploys a fresh local registry/leaderboard, registers a chart and test
signer, generates an original signed Mode B fixture, obtains a real HTTP proof,
restarts the prover, and simulates/submits from the player account. It also rejects
conflicting captures, wrong players, unapproved origins and duplicate submissions.
Test signing keys exist only in the isolated test process. Physical board and
extension/phone wallet acceptance are separate checks.
