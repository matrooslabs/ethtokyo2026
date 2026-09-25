#!/usr/bin/env bash
set -euo pipefail
prototype_root=$(cd "$(dirname "$0")/.." && pwd)
action=${1:-}
if [[ $# -gt 0 ]]; then shift; fi
case "$action" in
  deploy) contract=DeploySepolia ;;
  register) contract=RegisterDeviceSepolia ;;
  open) contract=OpenSessionSepolia ;;
  export) contract=ExportSessionSepolia ;;
  submit) contract=SubmitScoreSepolia ;;
  *) echo "usage: bash scripts/sepolia.sh deploy|register|open|export|submit [--broadcast]" >&2; exit 2 ;;
esac
broadcast=false
if [[ $# -gt 0 ]]; then
  if [[ $# != 1 || $1 != --broadcast || $action == export ]]; then
    echo "only --broadcast is accepted; export is read-only" >&2; exit 2
  fi
  broadcast=true
fi
: "${SEPOLIA_RPC_URL:?Set SEPOLIA_RPC_URL}"
if [[ $(cast chain-id --rpc-url "$SEPOLIA_RPC_URL") != 11155111 ]]; then
  echo "Refusing non-Sepolia chain (expected 11155111)" >&2; exit 1
fi
forge_command=(forge script "script/Sepolia.s.sol:$contract" --rpc-url sepolia)
if [[ $action != export ]]; then
  : "${SENDER_ADDRESS:?Set the public SENDER_ADDRESS}"
  forge_command+=(--sender "$SENDER_ADDRESS")
  if $broadcast; then
    : "${FOUNDRY_ACCOUNT:?Set the encrypted Foundry keystore account name}"
    forge_command+=(--account "$FOUNDRY_ACCOUNT" --broadcast)
  fi
fi
mkdir -p "$prototype_root/artifacts"
cd "$prototype_root/contracts"
"${forge_command[@]}"
