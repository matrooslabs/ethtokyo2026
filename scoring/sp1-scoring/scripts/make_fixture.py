#!/usr/bin/env python3
"""Synthetic, UNSIGNED hardware fixtures; also a strict 4K .osu canonicalizer.

Python encodings intentionally independently implement SPEC.md for cross-language vectors.
This is development tooling, never a trusted device or replay-to-hardware converter.
"""
import argparse
import hashlib
import json
from decimal import Decimal
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).digest()


def integer(value, size):
    return value.to_bytes(size, "big")


def chart_hash(chart):
    data = b"OSUMANIA_CHART_V1" + integer(1, 2) + bytes([4]) + integer(len(chart["notes"]), 4)
    for note in chart["notes"]:
        data += bytes([note["lane"]]) + integer(note["start_us"], 8) + integer(note["end_us"], 8)
    return digest(data)


def trace_root(session_id, events):
    root = digest(b"OSUMANIA_TRACE_V1" + bytes(session_id))
    for index, offset in enumerate(range(0, len(events), 32)):
        chunk = events[offset:offset + 32]
        data = root + integer(index, 4) + integer(len(chunk), 2)
        for event in chunk:
            data += integer(event["sequence"], 4) + integer(event["timestamp_us"], 8)
            data += bytes([event["lane"], event["action"]])
        root = digest(data)
    return root


def micros(text):
    value = Decimal(text) * 1000
    if not value.is_finite() or value != value.to_integral_value() or value < 0:
        raise ValueError("time must be nonnegative and exactly representable in microseconds")
    return int(value)


def parse_osu(path):
    section, settings, notes = "", {}, []
    for raw in Path(path).read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("//"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1]
        elif section in ("General", "Difficulty") and ":" in line:
            key, value = line.split(":", 1)
            settings[key.strip()] = value.strip()
        elif section == "HitObjects":
            fields = line.split(",")
            if len(fields) < 5:
                raise ValueError("malformed hit object")
            x, kind = int(fields[0]), int(fields[3])
            if not 0 <= x <= 512:
                raise ValueError("x outside osu!mania playfield")
            # New-combo/colour bits are metadata; sliders, spinners, mixed types are rejected.
            base = kind & ~0x74
            if base not in (1, 128):
                raise ValueError("only native mania taps and holds are supported")
            start = micros(fields[2])
            end = micros(fields[5].split(":")[0]) if base == 128 else start
            if base == 128 and end <= start:
                raise ValueError("hold must have positive length")
            notes.append(dict(lane=min(x * 4 // 512, 3), start_us=start, end_us=end))
    if settings.get("Mode") != "3" or Decimal(settings.get("CircleSize", "0")) != 4:
        raise ValueError("only native Mode:3, CircleSize:4 charts are supported")
    if Decimal(settings.get("OverallDifficulty", "-1")) != 5:
        raise ValueError("V1 pins OD5; this converter refuses to silently change OD")
    return sorted(notes, key=lambda note: (note["start_us"], note["lane"]))


def validate_notes(notes):
    if not 1 <= len(notes) <= 10000:
        raise ValueError("note count outside 1..10000")
    last = [-1] * 4
    for note in notes:
        lane, start, end = note["lane"], note["start_us"], note["end_us"]
        if not 0 <= start <= end <= 1800000000 - 136500 or start <= last[lane]:
            raise ValueError("invalid times or overlapping same-lane notes")
        last[lane] = end


def make_fixture(notes, demo=False):
    validate_notes(notes)
    chart = dict(key_count=4, notes=notes)
    header = dict(chain_id=31337, verifier=[17] * 20, match_id=[1] * 32,
                  session_id=[2] * 32, challenge=[3] * 32, player=[34] * 20,
                  device=[51] * 20, chart_hash=list(chart_hash(chart)),
                  ruleset_id=list(digest(b"OSUMANIA_ONCHAIN_RULESET_V1")),
                  bitstream_hash=[4] * 32,
                  input_policy_hash=list(digest(b"OSUMANIA_INPUT_POLICY_V1")))
    edges = []
    for note in notes:
        start, end, lane = note["start_us"], note["end_us"], note["lane"]
        # Taps release 1us later, making dense legal charts valid synthetic traces.
        down, up = start, end if end > start else start + 1
        if demo and lane == 1:
            down += 10000
            up += 30000
        edges.extend([(down, lane, 0), (up, lane, 1)])
    # UP before DOWN permits adjacent taps one microsecond apart.
    edges.sort(key=lambda edge: (edge[0], edge[1], -edge[2]))
    events = [dict(sequence=i, timestamp_us=t, lane=lane, action=action)
              for i, (t, lane, action) in enumerate(edges)]
    duration = max(n["end_us"] for n in notes) + 136500
    footer = dict(event_count=len(events), duration_us=duration,
                  trace_root=list(trace_root(header["session_id"], events)))
    return dict(header=header, footer=footer, chart=chart, events=events)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--notes", type=int, help="synthetic benchmark note count")
    group.add_argument("--osu", type=Path, help="native 4K OD5 .osu file")
    parser.add_argument("--ln-heavy", action="store_true")
    parser.add_argument("--chart-only", action="store_true")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if args.osu:
        notes = parse_osu(args.osu)
    elif args.notes is not None:
        notes = []
        for i in range(args.notes):
            start = 1000000 + i * 150000
            hold = args.ln_heavy or i % 4 == 0
            notes.append(dict(lane=i % 4, start_us=start, end_us=start + (300000 if hold else 0)))
    else:
        notes = [dict(lane=0, start_us=1000000, end_us=1000000),
                 dict(lane=1, start_us=1500000, end_us=2000000),
                 dict(lane=2, start_us=1500000, end_us=1500000),
                 dict(lane=3, start_us=2500000, end_us=2500000)]
    fixture = make_fixture(notes, demo=not args.osu and args.notes is None)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(fixture["chart"] if args.chart_only else fixture, indent=2) + "\n")


if __name__ == "__main__":
    main()
