#!/usr/bin/env python3
"""Summarize observed board captures; no synthetic values or implied wire timing."""
import argparse
import csv
from datetime import datetime
from pathlib import Path
import re


QUANTILES = (("p50", 1, 2, 1), ("p90", 9, 10, 10),
             ("p95", 95, 100, 20), ("p99", 99, 100, 100),
             ("p99.9", 999, 1000, 1000), ("p99.99", 9999, 10000, 10000))


def nearest_rank(total, numerator, denominator):
    return (total * numerator + denominator - 1) // denominator


def percentile_from_bins(bins, numerator, denominator):
    rank = nearest_rank(sum(bins.values()), numerator, denominator)
    seen = 0
    for value, count in sorted(bins.items()):
        seen += count
        if seen >= rank:
            return value
    raise ValueError("empty histogram")


def show_bins(label, bins, unit, overflow=None, censored_at=None):
    total = sum(bins.values())
    if not total:
        print(f"{label}: UNMEASURED (no samples)")
        return
    def display_bin(value):
        return f">{censored_at}{unit}" if censored_at is not None and value > censored_at else f"{value}{unit}"
    values = []
    for name, numerator, denominator, minimum in QUANTILES:
        values.append(f"{name}={display_bin(percentile_from_bins(bins, numerator, denominator))}" if total >= minimum
                      else f"{name}=insufficient samples (<{minimum})")
    maximum = display_bin(max(bins))
    print(f"{label}: n={total}, {', '.join(values)}, max_observed_bin={maximum}")
    if overflow:
        print(f"  {overflow}")


def daemon_stats(path):
    result = {}
    if not path.is_file():
        return result
    for line in path.read_text().splitlines():
        name, sep, number = line.partition(" ")
        if sep and number.isdecimal():
            result[name] = int(number)
    return result


def run(capture, wire):
    if not (capture / "metadata.txt").is_file():
        raise ValueError(f"not a board capture: {capture} (run capture.sh on the board)")
    metadata_text = (capture / "metadata.txt").read_text()
    print(metadata_text.strip())
    metadata = dict(line.split("=", 1) for line in metadata_text.splitlines() if "=" in line)
    if "started_utc" in metadata and "finished_utc" in metadata:
        started = datetime.strptime(metadata["started_utc"], "%Y-%m-%dT%H:%M:%SZ")
        finished = datetime.strptime(metadata["finished_utc"], "%Y-%m-%dT%H:%M:%SZ")
        if finished < started:
            raise ValueError("capture clock went backwards")
        print(f"observed_capture_duration_s={(finished - started).total_seconds():.0f}")
    before = daemon_stats(capture / "daemon-stats.before.txt")
    after = daemon_stats(capture / "daemon-stats.after.txt")
    if not before or not after:
        print("daemon interval: UNMEASURED (before/after stats snapshots missing)")
        before = after = {}
    buckets = {}
    prefix = "keyboard_app_us_bucket_"
    for key, count in after.items():
        if key.startswith(prefix):
            index = int(key[len(prefix):])
            difference = count - before.get(key, 0)
            if difference < 0:
                raise ValueError("daemon restarted during capture; counters not comparable")
            if difference:
                buckets[index] = difference
    show_bins("evdev timestamp -> successful keyboard gadget write (userspace only)",
              buckets, "us", ">1000us bin is censored, not an exact maximum" if 1001 in buckets else None,
              censored_at=1000)
    for key in ("keyboard_reports", "keyboard_dropped", "vendor_reports", "vendor_dropped", "malformed_frames"):
        if key in after:
            difference = after[key] - before.get(key, 0)
            if difference < 0:
                raise ValueError("daemon counters reset during capture")
            print(f"{key} delta: {difference}")
    cyc = capture / "cyclictest.txt"
    if cyc.is_file():
        histogram = {}
        for line in cyc.read_text().splitlines():
            match = re.fullmatch(r"\s*(\d+)\s+([\d\s]+)", line)
            if match:
                values = [int(v) for v in match.group(2).split()]
                histogram[int(match.group(1))] = histogram.get(int(match.group(1)), 0) + sum(values)
        histogram = {k: v for k, v in histogram.items() if v}
        overflow_lines = [line for line in cyc.read_text().splitlines() if "Histogram Overflows:" in line]
        show_bins("cyclictest scheduler wakeup histogram (NOT USB latency)", histogram,
                  "us", "; ".join(overflow_lines) if overflow_lines else None)
    else:
        print("cyclictest: UNMEASURED (tool unavailable or failed)")
    if wire is None:
        print("physical input -> USB output: UNMEASURED (no same-clock external capture)")
        return
    durations = []
    min_input_ns = None
    max_output_ns = None
    with wire.open(newline="") as f:
        rows = csv.DictReader(f)
        if rows.fieldnames != ["input_ns", "output_ns"]:
            raise ValueError("wire CSV needs input_ns,output_ns columns from one measurement clock")
        for row in rows:
            input_ns = int(row["input_ns"])
            output_ns = int(row["output_ns"])
            delta = output_ns - input_ns
            if delta < 0:
                raise ValueError("output precedes input; clocks or event pairing invalid")
            durations.append(delta)
            min_input_ns = input_ns if min_input_ns is None else min(min_input_ns, input_ns)
            max_output_ns = output_ns if max_output_ns is None else max(max_output_ns, output_ns)
    if not durations:
        print("physical input -> USB output: UNMEASURED (no samples)")
        return
    durations.sort()
    values = []
    for name, numerator, denominator, minimum in QUANTILES:
        if len(durations) < minimum:
            values.append(f"{name}=insufficient samples (<{minimum})")
        else:
            sample = durations[nearest_rank(len(durations), numerator, denominator) - 1]
            values.append(f"{name}={sample / 1000:.3f}us")
    print(f"physical input -> USB output: n={len(durations)}, {', '.join(values)}, "
          f"absolute_max={durations[-1] / 1000:.3f}us, "
          f"observed_wire_duration_s={(max_output_ns - min_input_ns) / 1e9:.6f} "
          "(external same-clock capture)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path, help="directory produced by capture.sh on the board")
    parser.add_argument("--wire", type=Path, help="same-clock physical wire capture CSV")
    args = parser.parse_args()
    try:
        run(args.capture, args.wire)
    except (ValueError, OSError) as exc:
        parser.exit(1, f"analyze: {exc}\n")
