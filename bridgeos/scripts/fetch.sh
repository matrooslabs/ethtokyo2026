#!/usr/bin/env bash
set -euo pipefail
project="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$project/sources"
if [ ! -d "$project/sources/buildroot/.git" ]; then
    git clone --depth 1 --branch 2026.02.2 https://github.com/buildroot/buildroot.git "$project/sources/buildroot"
fi
if [ ! -d "$project/sources/boot-firmware/.git" ]; then
    git clone https://github.com/Warfront1/radxa-zero-3-boot-firmware.git "$project/sources/boot-firmware"
    git -C "$project/sources/boot-firmware" checkout --detach 50a0d9ca8dc5bb42b616cd544a40301bb8fe63eb
fi
for spec in "buildroot:71d1dddae12e7cbf322d96864d7757f459801f47" "boot-firmware:50a0d9ca8dc5bb42b616cd544a40301bb8fe63eb"; do
    repo="${spec%%:*}"; expected="${spec#*:}"
    actual="$(git -C "$project/sources/$repo" rev-parse HEAD)"
    [ "$actual" = "$expected" ] || { echo "$repo expected $expected, got $actual" >&2; exit 1; }
done
