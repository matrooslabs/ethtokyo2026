#!/usr/bin/env python3
"""Bind a SYNTHETIC test witness to a confirmed session. Never re-seal real hardware traces."""
import argparse
import json
from pathlib import Path
from make_fixture import chart_hash, digest, trace_root, validate_notes


def bytes_field(value, length):
    if not isinstance(value, str) or not value.startswith("0x"):
        raise ValueError("expected 0x-prefixed session field")
    raw = bytes.fromhex(value[2:])
    if len(raw) != length:
        raise ValueError(f"expected {length}-byte session field")
    return list(raw)


def bind_synthetic(play, session):
    if session["chain_id"] != 11155111 or session["consumed"]:
        raise ValueError("expected an unconsumed confirmed Sepolia session")
    header = {"chain_id": session["chain_id"]}
    for key in ["verifier", "match_id", "session_id", "challenge", "player", "device",
                "chart_hash", "ruleset_id", "bitstream_hash", "input_policy_hash"]:
        header[key] = bytes_field(session[key], 20 if key in ("verifier", "player", "device") else 32)
    if play["chart"]["key_count"] != 4:
        raise ValueError("only 4K charts are supported")
    validate_notes(play["chart"]["notes"])
    if header["chart_hash"] != list(chart_hash(play["chart"])):
        raise ValueError("session chart hash differs from witness")
    if header["ruleset_id"] != list(digest(b"OSUMANIA_ONCHAIN_RULESET_V1")):
        raise ValueError("unsupported session ruleset")
    if header["input_policy_hash"] != list(digest(b"OSUMANIA_INPUT_POLICY_V1")):
        raise ValueError("unsupported input policy")
    play["header"] = header
    play["footer"]["event_count"] = len(play["events"])
    play["footer"]["trace_root"] = list(trace_root(header["session_id"], play["events"]))
    return play


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--synthetic", required=True, action="store_true", help="explicitly acknowledge this is a test witness")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--session", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = bind_synthetic(json.loads(args.input.read_text()), json.loads(args.session.read_text()))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
