#!/usr/bin/env bash
set -euo pipefail
prototype_root=$(cd "$(dirname "$0")/.." && pwd)
rustup_binary=$(command -v rustup)
# sp1-build selects the guest compiler via RUSTUP_TOOLCHAIN. Homebrew's standalone
# rustc ignores it, so put real rustup proxies first without editing shell profiles.
proxy_directory=$(mktemp -d)
trap 'rm -rf "$proxy_directory"' EXIT
ln -s "$rustup_binary" "$proxy_directory/cargo"
ln -s "$rustup_binary" "$proxy_directory/rustc"
export PATH="$proxy_directory:$PATH"
cargo build --release --locked --manifest-path "$prototype_root/host/Cargo.toml"

