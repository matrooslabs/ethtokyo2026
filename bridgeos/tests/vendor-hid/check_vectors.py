#!/usr/bin/env python3
"""Independent stdlib-only SHA/BN254 oracle. Not firmware or a production crypto library.

Usage: python3 docs/fpga/tools/check_vectors.py docs/fpga/vectors
Python >= 3.8. Uses canonical affine coordinates, never Rust/halo2curves internals.
"""
import hashlib
import json
import sys
from pathlib import Path

Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583
R = 21888242871839275222246405745257275088548364400416034343698204186575808495617
MAX_TIME = 1_800_000_000

def sha(data):
    return hashlib.sha256(data).digest()

def be(value, width):
    return value.to_bytes(width, "big")

def unhex(value):
    assert value.startswith("0x")
    return bytes.fromhex(value[2:])

def point(x, y):
    assert 0 <= x < Q and 0 <= y < Q, "noncanonical coordinate"
    if (x, y) == (0, 0):
        return None
    assert (y*y - x*x*x - 3) % Q == 0, "off-curve point"
    return x, y

def decode_point(pair):
    assert all(len(unhex(v)) == 32 for v in pair)
    return point(*(int(v, 16) for v in pair))

def point_bytes(p):
    return b"\0" * 64 if p is None else be(p[0], 32) + be(p[1], 32)

def add(a, b):
    if a is None:
        return b
    if b is None:
        return a
    x, y = a
    u, v = b
    if x == u:
        if (y + v) % Q == 0:
            return None
        slope = 3*x*x * pow(2*y, -1, Q) % Q
    else:
        slope = (v-y) * pow((u-x) % Q, -1, Q) % Q
    nx = (slope*slope-x-u) % Q
    return nx, (slope*(x-nx)-y) % Q

def mul(k, p):
    assert k >= 0
    result = None
    while k:
        if k & 1:
            result = add(result, p)
        p = add(p, p)
        k >>= 1
    return result

def validate(events, duration):
    assert len(events) <= 50_000 and 0 <= duration <= MAX_TIME
    held = [False] * 4
    previous = 0
    for j, e in enumerate(events):
        t, lane, act = e["timestamp_us"], e["lane"], e["action"]
        assert e["sequence"] == j and previous <= t <= duration
        assert 0 <= lane < 4 and act in (0, 1)
        assert held[lane] == (act == 1), "duplicate DOWN or unmatched UP"
        held[lane] = act == 0
        previous = t

def event_bytes(events):
    return b"".join(be(e["sequence"], 4) + be(e["timestamp_us"], 8)
                    + bytes([e["lane"], e["action"]]) for e in events)

def header_bytes(h):
    return be(h["chain_id"], 8) + b"".join(bytes(h[k]) for k in (
        "verifier", "match_id", "session_id", "challenge", "player", "device",
        "chart_hash", "ruleset_id", "bitstream_hash", "input_policy_hash"))

def check(folder):
    manifest = json.loads((folder / "srs-manifest.json").read_text())
    rom = (folder / manifest["file"]).read_bytes()
    assert len(rom) == 64 * manifest["pointCount"]
    assert sha(rom) == unhex(manifest["sha256"])
    bases = [point(int.from_bytes(rom[i:i+32], "big"),
                   int.from_bytes(rom[i+32:i+64], "big")) for i in range(0,len(rom),64)]
    assert bases[0] == (1, 2)
    assert mul(R, bases[0]) is None
    doc = json.loads((folder / "device-vectors.json").read_text())
    assert doc["srsId"] == manifest["srsId"]  # consistency only, no G2/pairing validation
    for case in doc["cases"]:
        events, h, duration = case["events"], case["headerV2"], case["durationUs"]
        validate(events, duration)
        assert len(case["commitmentPrefixes"]) == len(events)
        assert event_bytes(events) == unhex(case["eventBytes"])
        seed = b"OSUMANIA_TRACE_V1" + bytes(h["session_id"])
        assert seed == unhex(case["seedPreimage"])
        root = sha(seed)
        assert root == unhex(case["h0"])
        chunks = [events[i:i+32] for i in range(0,len(events),32)]
        assert len(chunks) == len(case["chunks"])
        for i, (ch, expected) in enumerate(zip(chunks, case["chunks"])):
            pre = root + be(i, 4) + be(len(ch), 2) + event_bytes(ch)
            root = sha(pre)
            assert (expected["index"], expected["count"]) == (i, len(ch))
            assert pre == unhex(expected["preimage"]) and root == unhex(expected["root"])
        assert root == unhex(case["traceRoot"])
        ce = None
        for j, e in enumerate(events):
            for c, k in enumerate((e["timestamp_us"], e["lane"], e["action"])):
                ce = add(ce, mul(k, bases[4*j+c]))
            assert ce == decode_point(case["commitmentPrefixes"][j]), (case["name"], j)
        assert ce == decode_point(case["traceCommitment"])
        assert bytes(h["ruleset_id"]) == sha(b"OSUMANIA_ONCHAIN_RULESET_V1")
        assert bytes(h["input_policy_hash"]) == sha(b"OSUMANIA_INPUT_POLICY_V2_KZG")
        hb = header_bytes(h)
        assert len(hb) == 292 and hb == unhex(case["headerPackedV2"])
        tail = be(len(events),4) + be(duration,8) + root
        pre = b"OSUMANIA_HARDWARE_SESSION_V2" + be(2,2) + hb + tail + point_bytes(ce)
        assert len(pre) == 430 and pre == unhex(case["sessionPreimageV2"])
        assert sha(pre) == unhex(case["sessionDigestV2"])
        ha = dict(h, input_policy_hash=list(sha(b"OSUMANIA_INPUT_POLICY_V1")))
        pre_a = b"OSUMANIA_HARDWARE_SESSION_V1" + be(1,2) + header_bytes(ha) + tail
        assert len(pre_a) == 366 and pre_a == unhex(case["sessionPreimageV1"])
        assert sha(pre_a) == unhex(case["sessionDigestV1"])
        print("PASS", case["name"], "events=", len(events))
    for v in doc["groupArithmetic"]:
        assert add(decode_point(v["a"]), decode_point(v["b"])) == decode_point(v["result"])
    print("PASS 10 device vectors; all chunk hashes, event-prefix commitments, V1/V2 digests; 3 group cases")

if __name__ == "__main__":
    check(Path(sys.argv[1] if len(sys.argv) > 1 else "docs/fpga/vectors"))
