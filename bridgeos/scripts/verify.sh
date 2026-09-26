#!/usr/bin/env bash
set -euo pipefail
project="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$project/output}"
profile="${2:-production}"
python3 "$project/scripts/verify.py" "$out" "$profile" "$project"
