# Sealed prover bridge and SP1 removal

## CLI support

- `mania-gkr prove-sealed --srs FILE --input PLAY.json [--mode a] [--header ABI_HEADER]`: validates the sealed header/footer through canonical `evaluate`, verifies an optional exact expected on-chain header, checks chart registration hash, proves without mutating input, verifies the produced proof against the reference score/judgements, and emits the same `abi.encode(uint256[])` as existing `prove-session`. Only Mode A is supported; Mode B is rejected rather than silently replacing a signed policy hash.
- ABI words: laneBits × 4, counts × 5, trace commitment X/Y (both zero for Mode A), session digest, event count, duration, original trace root, then proof words.
- `mania-gkr register-chart --srs FILE --input PLAY.json`: emits flat JSON `{bytes,chartHash,commitment,proof,m,bits,components,maxEnd}` using the existing canonical chart registration proof. Only the chart is consumed; no completed gameplay is required.
- `prove-session` remains the development/FFI rebinding helper with unchanged valid-input output. ABI header parsing now rejects noncanonical chain/address padding.
- Device signature verification, registry session matching and admission remain bridge responsibilities. The CLI never claims to authenticate physical hardware by itself.

## SP1 migration

User-authorized removal moved `scoring/sp1-scoring/core` to `scoring/core`, moved fixtures to `scoring/fixtures`, and preserved canonical V1 semantic documentation in `scoring/SCORING_SPEC.md`. All remaining tracked SP1-specific code/config/docs were removed. Before removal both untracked and ignored file listings under the old directory were empty; deletion was limited to explicit tracked files, and directories were removed only if empty.

Updated GKR Cargo path, runtime/FFI/export fixture paths, Rust tests, root/GKR readmes, scoring specification links, FPGA current dependency claims, and legacy GKR Sepolia tool defaults. Current GKR scripts now default to `gkr-scoring/.env` and `gkr-scoring/artifacts/...`, with flags for overrides; removed SP1 signer helpers are no longer required by operational instructions. Historical benchmark comparisons and source-manifest/log snapshots retain original SP1 names as historical evidence.

## Verification

- `cargo test --release --locked --manifest-path scoring/gkr-scoring/Cargo.toml`: 20 unit + 9 integration tests pass (29 total), including three new sealed-prover/chart tests.
- `cargo test --manifest-path scoring/core/Cargo.toml --offline`: 15 core integration tests pass.
- `cargo build --release --locked --manifest-path scoring/gkr-scoring/Cargo.toml`: passes; release CLI rebuilt.
- Actual CLI `register-chart` output parses and contains 2 commitment words/nonempty registration proof; `prove-sealed` emits 13,184 valid ABI bytes for demo and original trace root at word 14; Mode B exits nonzero with no proof stdout.
- New negative tests mutate trace root, event count, session ID, chart hash, policy, expected player/header and event timestamp; all rejected. Positive test checks exact digest/root/ABI offsets and unchanged input. Registration proof verifies natively.
- `cd scoring/gkr-scoring/contracts && forge test -q`: full Solidity regression passes after fixture migration (exit 0), including unchanged development `prove-session` Mode A/B compatibility.
- `rg -n 'sp1-scoring'` finds only historical benchmark/documentation/source comments and archived manifest/log references; no current Cargo, runtime script, CLI or FFI path depends on that directory.
