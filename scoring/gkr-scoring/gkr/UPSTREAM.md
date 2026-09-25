# Provenance

- Upstream: https://github.com/swjng/gkr (history also references `github.com:jeong0982/gkr`)
- Base commit: `1693f3fe5d5c23c430abde72732928484044829c` ("Merge branch 'main' of
  github.com:jeong0982/gkr into main", 2024-05-20 21:42:04 +0900)
- This directory is that tree plus the commits exported to `patches/`
  (`git am patches/*.patch` on top of the base commit reproduces it).

## License — needs a decision by the user

**Upstream ships no LICENSE file**, so by default no reuse/redistribution rights are
granted. Before publishing or redistributing this fork, obtain permission from the
upstream authors or replace the code. Third-party pieces keep their own licenses:
`mimc-rs` (GPL-3.0, now only a test-only cross-check), circomlib (GPL-3.0, used by the
circom templates, installed via npm, not vendored), `zeropool-utils` r1cs/wtns readers.

## What changed (see `SECURITY.md` for the why)

1. Builds on stable Rust (halo2curves 0.2.1 → 0.10.0, ff 0.13, no `#![feature]`).
   Aggregator/circom/CLI code is behind the default feature `aggregator`;
   `default-features = false` gives the protocol only.
2. Fiat–Shamir: `gkr::transcript` (chained MiMC7 transcript binding circuit digest,
   public input/output and every message); `z0` from the transcript.
3. New sound `gkr::verifier::verify` + `gkr::builder` (layered circuits without circom).
4. Python verifier fixed, same transcript as rust (byte-identical proofs).
5. Constant input positions pinned (`GKRCircuit::fixed_inputs`).
6. Circom: generic unsound `VerifyGKR(meta)` replaced by per-circuit generated verifiers
   (`rust/src/circom_codegen.rs`) built from constrained library templates.
7. Tooling: `execute_circom` fails on errors, no stale artifacts; `merge_nodes`
   recursion fix; mock Groth16 setup marked dev-only.
8. `gkr-baseline` timing binary (`BASELINE.md`).

Proof format change: round polynomials always have exactly 3 coefficients and `q_i`
exactly `k_{i+1}+1` (highest degree first); fields `z`, `r`, `sumcheck_r`, `k`, `depth`,
`d`, `input_func` remain in `Proof` only as untrusted prover hints.
