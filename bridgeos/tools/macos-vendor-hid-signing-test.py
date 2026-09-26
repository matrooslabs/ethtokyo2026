#!/usr/bin/env python3
"""Exercise and verify the complete BridgeOS Vendor HID signing flow on macOS."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import pathlib
import secrets
import struct
import sys
import time
from typing import Any
SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
BASE_PATH = next(
    (path for path in (
        SCRIPT_DIR / "macos-vendor-hid-get-info.py",
        SCRIPT_DIR / "info.py",
    ) if path.is_file()),
    SCRIPT_DIR / "macos-vendor-hid-get-info.py",
)
SPEC = importlib.util.spec_from_file_location("bridgeos_hid_info", BASE_PATH)
base = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = base
SPEC.loader.exec_module(base)

SET_HEADER = 0x10
START = 0x11
STOP = 0x12
ABORT = 0x13
GET_STATUS = 0x02
GET_RESULT = 0x20
SECP256K1_FIELD = int("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F", 16)
SECP256K1_G = (
    int("79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798", 16),
    int("483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8", 16),
)
GET_TRACE = 0x21
HEADER_SIZE = 292
RESULT_SIZE = 465
STATUS_SIZE = 16
EVENT_SIZE = 14
DOMAIN_SESSION = b"OSUMANIA_HARDWARE_SESSION_V2"
DOMAIN_TRACE = b"OSUMANIA_TRACE_V1"
SECP256K1_ORDER = int("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141", 16)


def make_report(message_type: int, transfer_id: int, offset: int,
                total: int, fragment: bytes) -> bytes:
    if len(fragment) > base.PAYLOAD_SIZE:
        raise ValueError("fragment is too large")
    report = bytearray(base.REPORT_SIZE)
    report[0:4] = bytes((base.MAGIC, base.VERSION, message_type, 0))
    struct.pack_into(">III", report, 4, transfer_id, offset, total)
    report[base.HEADER_SIZE:base.HEADER_SIZE + len(fragment)] = fragment
    return bytes(report)


def receive(device: Any, message_type: int, transfer_id: int,
            timeout_ms: int) -> tuple[int, bytes]:
    deadline = time.monotonic() + timeout_ms / 1000.0
    payload = bytearray()
    total_length: int | None = None
    flags: int | None = None
    while total_length is None or len(payload) < total_length:
        if time.monotonic() >= deadline:
            raise TimeoutError(
                f"incomplete type=0x{message_type:02x} response "
                f"{len(payload)}/{total_length}"
            )
        remaining_ms = max(1, int((deadline - time.monotonic()) * 1000))
        report = base.read_once(device, remaining_ms)
        if report[0] != base.MAGIC or report[1] != base.VERSION:
            continue
        if report[2] != message_type:
            continue
        report_flags = report[3]
        response_id, offset, response_total = struct.unpack_from(">III", report, 4)
        if response_id != transfer_id:
            continue
        if not report_flags & base.FLAG_RESPONSE:
            raise RuntimeError(f"response flag missing: 0x{report_flags:02x}")
        if flags is None:
            flags = report_flags
            total_length = response_total
            if total_length > 700000:
                raise RuntimeError(f"unreasonable response length: {total_length}")
        elif flags != report_flags or total_length != response_total:
            raise RuntimeError("response metadata changed between fragments")
        if offset != len(payload):
            raise RuntimeError(f"fragment offset {offset} != expected {len(payload)}")
        fragment_length = min(base.PAYLOAD_SIZE, total_length - offset)
        payload.extend(report[base.HEADER_SIZE:base.HEADER_SIZE + fragment_length])
        if any(report[base.HEADER_SIZE + fragment_length:]):
            raise RuntimeError("nonzero response padding")
    assert flags is not None
    return flags, bytes(payload)


def transact(device: Any, message_type: int, request: bytes = b"",
             timeout_ms: int = 5000) -> bytes:
    transfer_id = secrets.randbits(32) or 1
    if request:
        for offset in range(0, len(request), base.PAYLOAD_SIZE):
            fragment = request[offset:offset + base.PAYLOAD_SIZE]
            base.write_report(
                device,
                make_report(message_type, transfer_id, offset, len(request), fragment),
            )
    else:
        base.write_report(device, make_report(message_type, transfer_id, 0, 0, b""))
    flags, payload = receive(device, message_type, transfer_id, timeout_ms)
    if flags & base.FLAG_ERROR:
        raise RuntimeError(base.parse_error(payload))
    return payload


def build_header(info: Any) -> tuple[bytes, bytes]:
    session_id = secrets.token_bytes(32)
    fields = (
        struct.pack(">Q", 1) +                         # chain_id
        bytes(20) +                                    # verifier
        secrets.token_bytes(32) +                      # match_id
        session_id +
        secrets.token_bytes(32) +                      # challenge
        bytes(20) +                                    # player
        bytes.fromhex(info.device_address.removeprefix("0x")) +
        hashlib.sha256(b"BridgeOS macOS signing test chart").digest() +
        hashlib.sha256(b"OSUMANIA_ONCHAIN_RULESET_V1").digest() +
        bytes.fromhex(info.bitstream_hash) +
        bytes.fromhex(info.input_policy_hash)
    )
    if len(fields) != HEADER_SIZE:
        raise AssertionError(f"header length {len(fields)}")
    return fields, session_id


def parse_status(payload: bytes) -> dict[str, int]:
    if len(payload) != STATUS_SIZE:
        raise RuntimeError(f"GET_STATUS length {len(payload)} != {STATUS_SIZE}")
    return {
        "state": payload[0],
        "error": struct.unpack_from(">H", payload, 2)[0],
        "event_count": struct.unpack_from(">I", payload, 4)[0],
        "elapsed_us": struct.unpack_from(">Q", payload, 8)[0],
    }


def parse_trace(trace: bytes, duration_us: int) -> list[tuple[int, int, int, int]]:
    if len(trace) % EVENT_SIZE:
        raise RuntimeError(f"trace length {len(trace)} is not divisible by {EVENT_SIZE}")
    events = []
    held = [False] * 4
    previous = 0
    for offset in range(0, len(trace), EVENT_SIZE):
        sequence = struct.unpack_from(">I", trace, offset)[0]
        timestamp = struct.unpack_from(">Q", trace, offset + 4)[0]
        lane = trace[offset + 12]
        action = trace[offset + 13]
        if sequence != len(events):
            raise RuntimeError(f"trace sequence {sequence} != {len(events)}")
        if timestamp < previous or timestamp > duration_us:
            raise RuntimeError(f"invalid event timestamp {timestamp}")
        if lane > 3 or action > 1:
            raise RuntimeError(f"invalid lane/action {lane}/{action}")
        down = action == 0
        if held[lane] == down:
            raise RuntimeError(f"duplicate DOWN or unmatched UP at event {sequence}")
        held[lane] = down
        previous = timestamp
        events.append((sequence, timestamp, lane, action))
    return events


def trace_root(session_id: bytes, trace: bytes) -> bytes:
    chain = hashlib.sha256(DOMAIN_TRACE + session_id).digest()
    events = len(trace) // EVENT_SIZE
    for chunk_index, first in enumerate(range(0, events, 32)):
        count = min(32, events - first)
        chunk = trace[first * EVENT_SIZE:(first + count) * EVENT_SIZE]
        chain = hashlib.sha256(
            chain + struct.pack(">IH", chunk_index, count) + chunk
        ).digest()
    return chain


def point_add(left: tuple[int, int] | None,
              right: tuple[int, int] | None) -> tuple[int, int] | None:
    if left is None:
        return right
    if right is None:
        return left
    x1, y1 = left
    x2, y2 = right
    if x1 == x2 and (y1 + y2) % SECP256K1_FIELD == 0:
        return None
    if left == right:
        slope = (3 * x1 * x1) * pow(2 * y1, -1, SECP256K1_FIELD)
    else:
        slope = (y2 - y1) * pow(x2 - x1, -1, SECP256K1_FIELD)
    slope %= SECP256K1_FIELD
    x3 = (slope * slope - x1 - x2) % SECP256K1_FIELD
    y3 = (slope * (x1 - x3) - y1) % SECP256K1_FIELD
    return x3, y3


def scalar_mul(value: int, point: tuple[int, int] | None) -> tuple[int, int] | None:
    result = None
    addend = point
    value %= SECP256K1_ORDER
    while value:
        if value & 1:
            result = point_add(result, addend)
        addend = point_add(addend, addend)
        value >>= 1
    return result


def recover_public_key(digest: bytes, r: int, s: int,
                       recovery_id: int) -> tuple[int, int]:
    x = r
    alpha = (pow(x, 3, SECP256K1_FIELD) + 7) % SECP256K1_FIELD
    y = pow(alpha, (SECP256K1_FIELD + 1) // 4, SECP256K1_FIELD)
    if (y & 1) != recovery_id:
        y = SECP256K1_FIELD - y
    point_r = (x, y)
    if scalar_mul(SECP256K1_ORDER, point_r) is not None:
        raise RuntimeError("signature recovery point is not in the secp256k1 subgroup")
    z = int.from_bytes(digest, "big") % SECP256K1_ORDER
    inverse_r = pow(r, -1, SECP256K1_ORDER)
    candidate = point_add(
        scalar_mul(s, point_r),
        scalar_mul((-z) % SECP256K1_ORDER, SECP256K1_G),
    )
    public_key = scalar_mul(inverse_r, candidate)
    if public_key is None:
        raise RuntimeError("recovered secp256k1 public key is infinity")
    inverse_s = pow(s, -1, SECP256K1_ORDER)
    check = point_add(
        scalar_mul(z * inverse_s, SECP256K1_G),
        scalar_mul(r * inverse_s, public_key),
    )
    if check is None or check[0] % SECP256K1_ORDER != r:
        raise RuntimeError("recovered secp256k1 signature failed verification")
    return public_key


def import_keccak() -> Any:
    try:
        from Crypto.Hash import keccak
    except ImportError:
        try:
            from Cryptodome.Hash import keccak
        except ImportError as error:
            raise RuntimeError(
                "Keccak dependency is missing. Install with: "
                "python3 -m pip install --user pycryptodome"
            ) from error
    return keccak


def verify_result(info: Any, header: bytes, session_id: bytes,
                  result: bytes, trace: bytes, min_events: int) -> dict[str, int | str]:
    if len(result) != RESULT_SIZE:
        raise RuntimeError(f"GET_RESULT length {len(result)} != {RESULT_SIZE}")
    if result[:HEADER_SIZE] != header:
        raise RuntimeError("signed result header differs from SET_HEADER")
    count = struct.unpack_from(">I", result, 292)[0]
    duration_us = struct.unpack_from(">Q", result, 296)[0]
    root = result[304:336]
    commitment = result[336:400]
    signature = result[400:465]
    if count != len(trace) // EVENT_SIZE:
        raise RuntimeError(f"signed count {count} != trace count {len(trace) // EVENT_SIZE}")
    if count < min_events:
        raise RuntimeError(f"captured {count} events, fewer than required {min_events}")
    events = parse_trace(trace, duration_us)
    if root != trace_root(session_id, trace):
        raise RuntimeError("signed trace root does not match GET_TRACE")
    r = int.from_bytes(signature[:32], "big")
    s = int.from_bytes(signature[32:64], "big")
    recovery_id = signature[64] - 27
    if not (1 <= r < SECP256K1_ORDER and 1 <= s <= SECP256K1_ORDER // 2):
        raise RuntimeError("signature is not canonical low-s secp256k1")
    if recovery_id not in (0, 1):
        raise RuntimeError(f"invalid recovery ID {signature[64]}")
    final_fields = result[292:400]
    preimage = DOMAIN_SESSION + b"\x00\x02" + header + final_fields
    if len(preimage) != 430:
        raise AssertionError(f"signing preimage length {len(preimage)}")
    digest = hashlib.sha256(preimage).digest()
    public_point = recover_public_key(digest, r, s, recovery_id)
    public_key = public_point[0].to_bytes(32, "big") + public_point[1].to_bytes(32, "big")
    keccak = import_keccak()
    address_hash = keccak.new(digest_bits=256)
    address_hash.update(public_key)
    recovered_address = "0x" + address_hash.digest()[-20:].hex()
    if recovered_address.lower() != info.device_address.lower():
        raise RuntimeError(
            f"recovered signer {recovered_address} != GET_INFO {info.device_address}"
        )
    return {
        "event_count": len(events),
        "duration_us": duration_us,
        "commitment_is_infinity": int(not any(commitment)),
        "public_key": "04" + public_key.hex(),
        "recovered_address": recovered_address,
    }


def get_info(device: Any, timeout_ms: int) -> Any:
    payload = transact(device, base.GET_INFO, timeout_ms=timeout_ms)
    return base.parse_info(payload)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run SET_HEADER/START/STOP/GET_RESULT and verify the TA signature"
    )
    parser.add_argument("--vid", type=base.number, default=base.VID_DEFAULT)
    parser.add_argument("--pid", type=base.number, default=base.PID_DEFAULT)
    parser.add_argument("--path")
    parser.add_argument("--capture-seconds", type=float, default=5.0)
    parser.add_argument("--min-events", type=int, default=0)
    parser.add_argument("--timeout-ms", type=int, default=10000)
    args = parser.parse_args()
    if args.capture_seconds < 0 or args.min_events < 0 or args.timeout_ms <= 0:
        parser.error("capture seconds, min events and timeout must be nonnegative/positive")
    hid = base.import_hid()
    entry = base.select_device(hid, args.vid, args.pid, args.path)
    device = hid.device()
    try:
        device.open_path(entry["path"])
        try:
            device.set_nonblocking(False)
        except (AttributeError, OSError):
            pass
        info = get_info(device, args.timeout_ms)
        print(f"TA ready: {info.device_address}")
        try:
            transact(device, ABORT, timeout_ms=args.timeout_ms)
        except RuntimeError:
            pass
        header, session_id = build_header(info)
        transact(device, SET_HEADER, header, args.timeout_ms)
        transact(device, START, timeout_ms=args.timeout_ms)
        print(
            f"Recording for {args.capture_seconds:g}s. "
            "Press and release D/F/J/K on the keyboard now...",
            flush=True,
        )
        time.sleep(args.capture_seconds)
        recording = parse_status(transact(device, GET_STATUS, timeout_ms=args.timeout_ms))
        if recording["state"] != 2:
            raise RuntimeError(f"session left RECORDING state: {recording}")
        transact(device, STOP, timeout_ms=args.timeout_ms)
        finalized = parse_status(transact(device, GET_STATUS, timeout_ms=args.timeout_ms))
        if finalized["state"] != 3 or finalized["error"] != 0:
            raise RuntimeError(f"session did not finalize cleanly: {finalized}")
        result = transact(device, GET_RESULT, timeout_ms=args.timeout_ms)
        trace = transact(device, GET_TRACE, timeout_ms=args.timeout_ms)
        verified = verify_result(info, header, session_id, result, trace, args.min_events)
        print("TA stateful signing: PASS")
        print(f"event_count:          {verified['event_count']}")
        print(f"duration_us:          {verified['duration_us']}")
        print(f"trace_root:           {result[304:336].hex()}")
        print(f"commitment:           {result[336:400].hex()}")
        print(f"signature_r:          {result[400:432].hex()}")
        print(f"signature_s:          {result[432:464].hex()}")
        print(f"recovery_v:           {result[464]}")
        print(f"recovered_address:    {info.device_address}")
        print(f"public_key_uncompressed: {verified['public_key']}")
        print("signature_low_s:      yes")
        print("trace_root_verified:  yes")
        print("commitment_recompute: not performed (requires the development SRS)")
        transact(device, ABORT, timeout_ms=args.timeout_ms)
        return 0
    finally:
        device.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, TimeoutError, OSError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
