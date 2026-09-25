#!/usr/bin/env sh
# Reproduces GKR-03/04/05/07: the UPSTREAM circom verifier (commit 1693f3f, copied verbatim
# into ./upstream-circom) accepts an all-zero "proof" for a depth-3 circuit: every
# challenge, point and input polynomial is a free prover input and the initial claim is 0.
# Needs circom >= 2.0.4 and node. The upstream templates include no circomlib files.
set -e
cd "$(dirname "$0")"
circom forge.circom --wasm -o . >/dev/null
node forge_js/generate_witness.js forge_js/forge.wasm zero-proof.json forged.wtns
echo "UPSTREAM verifier accepted the all-zero proof (witness generated, all === constraints hold)"
rm -rf forge_js forged.wtns
