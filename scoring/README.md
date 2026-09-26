# Scoring workspace

The five active Rust crates share `Cargo.toml`, `Cargo.lock`, and `target/` here.
Dependency versions and build profiles are defined in the workspace manifest.

| Directory | Cargo package | Responsibility |
| --- | --- | --- |
| `crates/scoring-core` | `mania-scoring-core` | Canonical input types, scoring rules, trace hashing, and session digests |
| `crates/gkr-evm` | `mania-gkr` | BN254 proof engine, EVM encoding, CLI, and FPGA examples |
| `crates/gkr-sui` | `mania-gkr-sui` | BLS12-381 proof engine, Sui encoding, and CLI |
| `crates/prove-server-evm` | `mania-gkr-prove-server` | EVM proof, paid-session, and relayer service ([API](crates/prove-server-evm/README.md)) |
| `crates/prove-server-sui` | `mania-gkr-sui-prove-server` | Sui HTTP proving service ([API](crates/prove-server-sui/README.md)) |

Both engines depend on the scoring core; each server depends on its chain's
engine and the core. Package names, Rust imports, and binary names are unchanged.
The engines retain their separate cryptographic implementations and encodings.

`fixtures/` contains shared test inputs. [SCORING_SPEC.md](SCORING_SPEC.md) defines
the scoring rules. Chain-specific contracts, scripts, documentation, and generated
artifacts remain under [gkr-scoring/](gkr-scoring/README.md) (EVM) and
[gkr-scoring-sui/](gkr-scoring-sui/README.md) (Sui).

## Build and test

From this directory:

```sh
cargo build --workspace --release --locked
cargo test --workspace --locked

# Select one package when working on a single component.
cargo test --locked -p mania-scoring-core
cargo test --locked -p mania-gkr
cargo test --locked -p mania-gkr-sui
cargo build --release --locked -p mania-gkr-prove-server
cargo build --release --locked -p mania-gkr-sui-prove-server
cargo build --release --locked -p mania-gkr --examples
```

From the repository root, add `--manifest-path scoring/Cargo.toml`.
Tests use the existing optimized test profile; release builds retain thin LTO.
Release binaries are in `scoring/target/release/`, and examples are in
`scoring/target/release/examples/`.

Run chain-specific demo commands from their existing directories so that relative
SRS and artifact paths keep their meaning. For example, after creating the EVM
SRS as described in the [EVM instructions](gkr-scoring/README.md):

```sh
cd gkr-scoring
cargo run --release --locked -p mania-gkr-prove-server
```

## Independent research fork

`gkr-scoring/gkr/rust` is an upstream research fork, excluded from this workspace.
It has optional Circom/aggregation tooling and Git dependencies that the active
scoring engines do not use. Build it separately with
`cargo build --manifest-path gkr-scoring/gkr/rust/Cargo.toml`.

Dated benchmark logs, source manifests, and handoff archives retain their original
paths as historical evidence.
