# Security review and fixes (fork of swjng/gkr @ 1693f3f)

Scope: `rust/` (prover, converter, aggregator CLI), `python/` (reference prover/verifier),
`gkr-verifier-circuits/circom/` (the in-circuit verifier used for recursive aggregation).
Upstream had **no Rust verifier**; the python and circom verifiers were the only acceptance
logic. Before the fixes, both accepted forged proofs for false statements (reproduced, see
"Evidence"). Fixes are split into reviewable commits in `patches/`.

Severity: Critical = forged proof for a false statement is accepted; High = soundness
depends on an unchecked assumption / partial forgery; Medium = integrity or availability
problem in tooling; Low/Info = hardening, documentation.

| ID | Component | Severity | Issue and concrete exploit | Fix | Covered by |
|---|---|---|---|---|---|
| GKR-01 | rust prover, python prover+verifier | Critical | **Unchained Fiat–Shamir.** Each sumcheck challenge was `MiMC(current round polynomial)` only, and `r*` was `MiMC(last round polynomial)`; nothing bound the circuit, the public input/output, the running claim, or earlier messages. A challenge is computable from its own message alone, so the prover can pick messages and the claimed output independently of the challenges (in `forge_for_legacy` every "proof" message is chosen after all hashes are known); proofs also transplant between circuits/inputs. | `gkr::transcript` (`Transcript` trait, `MimcTranscript`): domain separator, circuit digest (depth, all k_i, every add/mult gate, fixed inputs), input values, output values, then every round polynomial and every `q_i` are absorbed before the next challenge is squeezed. Same schedule in rust, python and circom (shared known-answer vectors). | rust `proof_bound_to_input_output_and_circuit`, `consistent_round_forgery_rejected`, `known_answer_vectors`; python `LegacyExploit`, `TranscriptVectors` |
| GKR-02 | rust prover, converter, python | Critical | **Output point not random.** Rust fixed `z0 = 0`, so the protocol only checked `D~(0) = D[0]`, i.e. output gate 0. `convert.rs` also asserted only `d_values[0] == 0` although every output gate is an R1CS constraint `A*B-C`. A witness violating any constraint other than the first of a sub-circuit was proven "valid". Python picked `z0` itself (`# This initial value is unsafe`) and shipped it in the proof. | `z0` is squeezed from the transcript after the output is absorbed; the initial claim is `D~(z0)` of the verifier's claimed output; the converter requires all outputs to be zero. | rust `wrong_output_rejected_including_non_first_gates`; python `test_wrong_output_any_gate` |
| GKR-03 | circom `VerifyGKR` | Critical | **Initial claim hard-coded to 0 and `D` never read.** Combined with GKR-04 the verifier did not depend on the claimed output at all. | Generated verifier computes `D~(z0)` in-circuit from the claimed output (constant; all-zero for R1CS-derived circuits). | `tests/circom.rs` (false output rejected) |
| GKR-04 | circom `VerifyGKR`, `SumcheckVerify` | Critical | **Challenges and points were free prover inputs.** `sumcheckr`, `r` and `z` were `signal input`s with no hashing and no check `z[i+1] = l(b*, c*, r*)`. With GKR-03/05/07 an **all-zero proof verifies for every circuit** (`repro/upstream-zero-proof/run.sh`). | All challenges are recomputed in-circuit with circomlib `MultiMiMC7` (`transcript.circom`, `SumcheckRound`), `z` is derived, never input. | `tests/circom.rs`; repro script |
| GKR-05 | circom, python verifier | Critical | **Sumcheck end value not bound to the circuit.** Circom never checked `add~(z,b*,c*)(q(0)+q(1)) + mult~(z,b*,c*) q(0)q(1)` against the last round; python compared it with prover-supplied `proof.f[i]` instead of `g_v(r_v)`. Forgery: constant round polynomials `g_j = claim/2` pass every round, then any `q` works (`forge_for_legacy`). | Final per-layer check against the verifier's own wiring and the recomputed last evaluation (rust `verifier.rs`, python `verify`, circom generated template via constrained `EqTable`s). | rust `tampered_messages_rejected`; python `LegacyExploit`, `test_tampering`; circom test |
| GKR-06 | python verifier, circom `meta` | High | **Circuit description taken from the prover.** Python read `add`, `mult`, `k`, `d`, `D`, `z`, `input_func` from the proof; the circom `meta` (depth, k's, term counts) was computed from the proofs being verified (`get_meta(proofs)`). A prover could submit zero wiring or a different shape. | Verifiers take the circuit from the verifier side (`verify(circuit, input, output, proof)`); circom verifier is generated from the circuit with wiring as compile-time constants; proof hints are ignored. | rust/python `prover_hints_are_ignored`, `proof_bound_to_input_output_and_circuit` |
| GKR-07 | circom `evalMultivariate`, `evalGateFunction` | Critical | **Unconstrained input-layer evaluation.** Both templates computed their result with `<--` (and exponents were prover signals), so `inputValue.result` could be set to anything. Python evaluated a prover-supplied `input_func`. | Replaced by constrained `MLEEval` / `EqTable` over dense values (`poly/multivariate.circom`); `optimizedGate.circom` removed; python/rust evaluate the caller's input. | circom test (wrong input rejected); rust/python wrong-input tests |
| GKR-08 | circom, python, rust | High | **No degree bound.** Circom used `nTerms = meta[4]` = the maximum length over the submitted proofs; python accepted any length. A prover-chosen degree makes `g(0)+g(1)=claim` trivially satisfiable at any challenge (interpolation), destroying soundness. | Exactly 3 coefficients per round (degree ≤ 2) and exactly `k_{i+1}+1` for `q_i`, in all three verifiers; prover normalizes. | rust `degree_and_shape_bounds_enforced`; python `test_degree_and_round_count` |
| GKR-09 | python `verify_sumcheck` | Medium | `if v == 1 and g(0)+g(1) == claim: return True` accepted without challenge or end check; round counts were not enforced (`bn = len(proof)`). | Exact round count, no shortcut. | python `test_degree_and_round_count` |
| GKR-10 | converter + aggregation | High | **Constants are prover inputs.** `convert.rs` puts R1CS coefficients (and padding zeros) in the GKR input layer; in aggregation that layer is a private witness, so a prover could change coefficients and prove a *different* constraint system. | `GKRCircuit::fixed_inputs` (set by the converter, part of the digest) pinned by the rust verifier and by `inputValues[pos] === c` in the generated circom verifier. | rust `fixed_inputs_are_pinned_and_part_of_the_digest`; circom test (modified constant rejected) |
| GKR-11 | aggregation design | High — **not fixed** | **Inner public inputs are unbound.** Earlier rounds' public signals are only written to `*_output.json` off-circuit, and the whole input layer is a private witness of the outer circuit. The final Groth16 proof therefore attests "there exist witnesses satisfying the earlier circuits", not that the recorded outputs are theirs. | Needs protocol design: expose the input-layer positions of the inner public variables as public signals of the outer circuit. Documented only. | — |
| GKR-12 | `file_utils::execute_circom` | Medium | Exit codes of `circom` and witness generation were ignored; a failed compilation, or a witness generation that **fails because a GKR proof was rejected**, silently continued with stale `*.r1cs` / `witness.wtns` from an earlier run. | Stale outputs removed before running; any failure aborts. | manual (aggregator tests) |
| GKR-13 | `write_aggregated_input` | Low | User input names and proof input names could overwrite each other (e.g. a user signal `q0`). | Collision aborts. | — |
| GKR-14 | README / `mock-groth` | Critical if used beyond dev | The documented zkey uses one `"mock"` contribution and a fixed public beacon, so the toxic waste is known and the final Groth16 proof is forgeable. | Documented as DEV ONLY in README and the CLI prints a warning; snarkjs exit codes are now checked. Use a real phase-2 ceremony. | — |
| GKR-15 | rust (availability) | Medium | Panics on malformed/edge input: `merge_nodes` recursed forever on an empty linear combination (stack overflow on the first aggregated circuit); prover underflowed (`v - 1`) on layers with one gate; exponents were read with `U256::as_usize` (panic > u64); MiMC conversion `from_repr(..).unwrap()`. | `merge_nodes` handles empty input; prover/verifier return `GkrError` for unsupported circuits and malformed proofs; exponent helper is bounded and only used on circuit-side data; MiMC runs natively on the field. Converter/CLI file-I/O `unwrap`s remain (trusted local tooling). | rust `malformed_proofs_do_not_panic`, `unsupported_circuits_error_instead_of_panicking`; aggregator test |
| GKR-16 | python | Info | Python used `ethsnarks.mimc.mimc_hash`, which is **not** circomlib's MiMC7 (different result), so python-generated proofs could never have matched the circom verifier. | Shared circomlib-compatible transcript; python and rust produce byte-identical proofs (pinned vectors). | rust `python_example_matches_rust`; python `test_proof_equals_rust_proof` |
| GKR-17 | licensing | Info | Upstream has no LICENSE. `mimc-rs` (GPL-3.0) was a normal dependency; circomlib is GPL-3.0. | `mimc-rs` is now a test-only cross-check; MiMC7 reimplemented. See `UPSTREAM.md`. | `mimc_matches_upstream_reference_implementation` |

## Residual limitations

- GKR-11 (unbound inner public inputs) is a design gap of the aggregation scheme, not fixed.
- The in-circuit transcript is expensive: every absorbed field element costs one MiMC7
  (~364 constraints). A sound verifier of the 12 GKR proofs of the `t.circom` example is a
  ~420 MB r1cs; the upstream converter/prover (monomial representation, O(n²) node
  deduplication) cannot convert and prove that second recursion round in reasonable time
  (see `BASELINE.md`). The unsound upstream verifier was cheap precisely because it
  verified nothing.
- The converter is still a trusted local tool (file I/O unwraps, depth/width limits).
- MiMC7 as a Fiat–Shamir hash is kept for circom compatibility; its security as a random
  oracle is the same assumption upstream made.

## Evidence (actual runs, Apple M3 Max, rust 1.94.1, circom 2.2.3, node 25)

- `cd rust && cargo test --release`: lib 4 passed (2 ignored: need circom), `tests/verifier.rs` 11 passed, `tests/circom.rs` skipped without `GKR_CIRCOM`.
- `cd rust && GKR_CIRCOM=/path/to/circom cargo test --release --test circom`: 1 passed —
  for two circuits the generated verifier accepts the honest proof and rejects: every
  tampered round/q, a g(0)+g(1)-preserving forgery, a different input witness, a modified
  pinned constant (with an honest proof for it), and a false claimed output.
- `cd rust && PATH=<circom,node> cargo test --release --lib test_single_proof -- --ignored`: 1 passed.
- `cd python && pip install ethsnarks && python3 -m unittest test_security -v`: 10 passed,
  including `LegacyExploit`: the verbatim upstream verifier (`legacy_upstream.py`) **accepts**
  a proof of the false output (1234, 5678); the fixed verifier rejects it.
- `repro/upstream-zero-proof/run.sh`: the verbatim upstream circom verifier accepts an
  all-zero proof (witness generation succeeds).
