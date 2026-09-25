#!/usr/bin/env python3
"""Measure native time and optionally actual zkVM cycles; never label either as EVM gas."""
import argparse
import json
from pathlib import Path
import subprocess
from make_fixture import make_fixture

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sp1", action="store_true", help="requires a built host/target/release/mania-sp1-host")
    args = parser.parse_args()
    subprocess.run(["cargo", "build", "--release", "--locked", "-p", "mania-scoring-cli"], cwd=ROOT, check=True)
    folder = ROOT / "artifacts" / "benchmark"
    folder.mkdir(parents=True, exist_ok=True)
    rows = []
    for count, heavy in [(500, False), (1500, False), (3000, False), (3000, True)]:
        name = f"{count}-{'ln' if heavy else 'mixed'}"
        notes = []
        for i in range(count):
            start = 1000000 + i * 150000
            notes.append(dict(lane=i % 4, start_us=start, end_us=start + (300000 if heavy or i % 4 == 0 else 0)))
        fixture = folder / f"{name}.json"
        fixture.write_text(json.dumps(make_fixture(notes)))
        native = json.loads(subprocess.check_output([str(ROOT / "target/release/mania-scoring-cli"), str(fixture)]))
        assert native["result"]["score"] == 1000000
        row = {"case": name, "notes": count, "events": native["events"], "nativeMicros": native["nativeMicros"]}
        if args.sp1:
            output = folder / name
            subprocess.run([str(ROOT / "host/target/release/mania-sp1-host"), "execute", str(fixture), str(output)], check=True, stdout=subprocess.DEVNULL)
            execution = json.loads((output / "execution.json").read_text())
            assert execution["publicValues"] == native["publicValues"]
            row.update(cycles=execution["cycles"], executionMillis=execution["executionMillis"])
        rows.append(row)
        print(json.dumps(row), flush=True)
    (folder / "summary.json").write_text(json.dumps(rows, indent=2) + "\n")


if __name__ == "__main__":
    main()

