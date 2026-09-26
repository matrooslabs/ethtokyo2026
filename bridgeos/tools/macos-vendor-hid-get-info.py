#!/usr/bin/env python3
"""Probe BridgeOS Vendor HID GET_INFO from macOS using python hidapi."""

from __future__ import annotations

import argparse
import json
import secrets
import struct
import sys
import time
from dataclasses import asdict, dataclass
from typing import Any

VID_DEFAULT = 0xD86A
PID_DEFAULT = 0x1000
USAGE_PAGE = 0xFF60
USAGE = 0x0001
REPORT_SIZE = 64
HEADER_SIZE = 16
PAYLOAD_SIZE = REPORT_SIZE - HEADER_SIZE
MAGIC = 0x4D
VERSION = 0x01
GET_INFO = 0x01
FLAG_RESPONSE = 0x01
FLAG_ERROR = 0x02
INFO_SIZE = 128

ERROR_NAMES = {
    0x0001: "BAD_PROTOCOL_VERSION",
    0x0002: "BAD_STATE",
    0x0003: "BAD_LENGTH",
    0x0004: "BAD_FRAGMENT_OFFSET",
    0x0005: "HEADER_MISMATCH",
    0x0006: "EVENT_OVERFLOW",
    0x0007: "SIGN_FAILED",
    0x0008: "NOT_READY",
    0x0009: "INVALID_EVENT",
    0x000A: "CLOCK_FAULT",
    0x00FF: "INTERNAL_ERROR",
}
DETAIL_NAMES = {
    0: "NONE",
    1: "DEVICE",
    2: "BITSTREAM",
    3: "POLICY",
    4: "SRS",
}
STATE_NAMES = {
    0: "IDLE",
    1: "HEADER_LOADED",
    2: "RECORDING",
    3: "FINALIZED",
    255: "ERROR",
}


@dataclass(frozen=True)
class DeviceInfo:
    protocol_version: int
    report_size: int
    capability_flags: int
    device_address: str
    bitstream_hash: str
    input_policy_hash: str
    srs_hash: str
    max_events: int


def number(value: str) -> int:
    return int(value, 0)


def describe(entry: dict[str, Any]) -> str:
    path = entry.get("path")
    if isinstance(path, bytes):
        path_text = path.hex()
    else:
        path_text = str(path)
    return (
        f"path={path_text} usage_page=0x{int(entry.get('usage_page') or 0):04x} "
        f"usage=0x{int(entry.get('usage') or 0):04x} "
        f"interface={entry.get('interface_number')} "
        f"product={entry.get('product_string')!r}"
    )


def select_device(hid: Any, vid: int, pid: int, requested_path: str | None) -> dict[str, Any]:
    entries = list(hid.enumerate(vid, pid))
    if not entries:
        raise RuntimeError(f"no HID device found for {vid:04x}:{pid:04x}")
    if requested_path is not None:
        wanted = requested_path.lower()
        for entry in entries:
            path = entry.get("path")
            candidates = [str(path).lower()]
            if isinstance(path, bytes):
                candidates.append(path.hex().lower())
                try:
                    candidates.append(path.decode().lower())
                except UnicodeDecodeError:
                    pass
            if wanted in candidates:
                return entry
        raise RuntimeError("requested HID path not found; use --list to inspect paths")
    exact = [
        entry for entry in entries
        if int(entry.get("usage_page") or 0) == USAGE_PAGE
        and int(entry.get("usage") or 0) == USAGE
    ]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        raise RuntimeError("multiple Vendor HID collections matched; select one with --path")
    raise RuntimeError(
        "BridgeOS Vendor HID collection (usage page 0xff60, usage 0x0001) not found; "
        "use --list to inspect macOS enumeration"
    )


def request_report(transfer_id: int) -> bytes:
    report = bytearray(REPORT_SIZE)
    report[0] = MAGIC
    report[1] = VERSION
    report[2] = GET_INFO
    report[3] = 0
    struct.pack_into(">III", report, 4, transfer_id, 0, 0)
    return bytes(report)


def write_report(device: Any, report: bytes) -> None:
    # hidapi reserves byte zero for the Report ID. This descriptor has no Report ID.
    framed = b"\x00" + report
    try:
        written = device.write(framed)
    except (OSError, ValueError) as first_error:
        try:
            written = device.write(report)
        except (OSError, ValueError) as second_error:
            raise RuntimeError(
                f"Vendor HID write failed with and without Report ID prefix: "
                f"{first_error}; {second_error}"
            ) from second_error
    if written not in (REPORT_SIZE, REPORT_SIZE + 1):
        raise RuntimeError(f"short Vendor HID write: {written} bytes")


def read_once(device: Any, timeout_ms: int) -> bytes:
    try:
        data = device.read(REPORT_SIZE, timeout_ms)
    except TypeError:
        device.set_nonblocking(True)
        deadline = time.monotonic() + timeout_ms / 1000.0
        data = []
        while time.monotonic() < deadline:
            data = device.read(REPORT_SIZE)
            if data:
                break
            time.sleep(0.005)
    if not data:
        raise TimeoutError(f"no Vendor HID response within {timeout_ms} ms")
    report = bytes(data)
    if len(report) == REPORT_SIZE + 1 and report[0] == 0:
        report = report[1:]
    if len(report) != REPORT_SIZE:
        raise RuntimeError(f"unexpected input report length: {len(report)}")
    return report


def receive_response(device: Any, transfer_id: int, timeout_ms: int) -> tuple[int, bytes]:
    deadline = time.monotonic() + timeout_ms / 1000.0
    payload = bytearray()
    total_length: int | None = None
    flags: int | None = None
    while total_length is None or len(payload) < total_length:
        remaining_ms = max(1, int((deadline - time.monotonic()) * 1000))
        if time.monotonic() >= deadline:
            raise TimeoutError(f"incomplete Vendor HID response: {len(payload)}/{total_length}")
        report = read_once(device, remaining_ms)
        if report[0] != MAGIC or report[1] != VERSION or report[2] != GET_INFO:
            continue  # Ignore stale or unrelated protocol traffic.
        report_flags = report[3]
        report_transfer, offset, report_total = struct.unpack_from(">III", report, 4)
        if report_transfer != transfer_id:
            continue
        if not (report_flags & FLAG_RESPONSE):
            raise RuntimeError(f"response flag missing: 0x{report_flags:02x}")
        if flags is None:
            flags = report_flags
            total_length = report_total
            if total_length > 4096:
                raise RuntimeError(f"unreasonable response length: {total_length}")
        elif report_flags != flags or report_total != total_length:
            raise RuntimeError("response metadata changed between fragments")
        if offset != len(payload):
            raise RuntimeError(f"fragment offset {offset} != expected {len(payload)}")
        fragment_length = min(PAYLOAD_SIZE, total_length - offset)
        fragment = report[HEADER_SIZE:HEADER_SIZE + fragment_length]
        padding = report[HEADER_SIZE + fragment_length:]
        if any(padding):
            raise RuntimeError("nonzero response padding")
        payload.extend(fragment)
    assert flags is not None
    return flags, bytes(payload)


def parse_error(payload: bytes) -> str:
    if len(payload) < 4:
        return f"malformed error payload: {payload.hex()}"
    code = struct.unpack_from(">H", payload, 0)[0]
    state = payload[2]
    detail = payload[3]
    diagnostic = payload[4:].split(b"\x00", 1)[0].decode("utf-8", "replace")
    return (
        f"Vendor HID error 0x{code:04x} ({ERROR_NAMES.get(code, 'UNKNOWN')}), "
        f"state={state} ({STATE_NAMES.get(state, 'UNKNOWN')}), "
        f"detail={detail} ({DETAIL_NAMES.get(detail, 'UNKNOWN')}), "
        f"diagnostic={diagnostic!r}"
    )


def parse_info(payload: bytes) -> DeviceInfo:
    if len(payload) != INFO_SIZE:
        raise RuntimeError(f"GET_INFO payload length {len(payload)} != {INFO_SIZE}")
    protocol_version, report_size = struct.unpack_from(">HH", payload, 0)
    capability_flags = struct.unpack_from(">I", payload, 4)[0]
    max_events = struct.unpack_from(">I", payload, 124)[0]
    if protocol_version != VERSION:
        raise RuntimeError(f"device protocol version {protocol_version} != {VERSION}")
    if report_size != REPORT_SIZE:
        raise RuntimeError(f"device report size {report_size} != {REPORT_SIZE}")
    return DeviceInfo(
        protocol_version=protocol_version,
        report_size=report_size,
        capability_flags=capability_flags,
        device_address="0x" + payload[8:28].hex(),
        bitstream_hash=payload[28:60].hex(),
        input_policy_hash=payload[60:92].hex(),
        srs_hash=payload[92:124].hex(),
        max_events=max_events,
    )


def import_hid() -> Any:
    try:
        import hid  # type: ignore
    except ImportError as error:
        raise RuntimeError(
            "python hidapi is missing. Install it on macOS with: "
            "python3 -m pip install --user hidapi"
        ) from error
    return hid


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify BridgeOS OP-TEE TA startup through Vendor HID GET_INFO"
    )
    parser.add_argument("--vid", type=number, default=VID_DEFAULT)
    parser.add_argument("--pid", type=number, default=PID_DEFAULT)
    parser.add_argument("--path", help="exact hidapi path string or hexadecimal bytes")
    parser.add_argument("--timeout-ms", type=int, default=5000)
    parser.add_argument("--list", action="store_true", help="list matching HID collections and exit")
    parser.add_argument("--json", action="store_true", help="print successful GET_INFO as JSON")
    args = parser.parse_args()
    if args.timeout_ms <= 0:
        parser.error("--timeout-ms must be positive")
    hid = import_hid()
    entries = list(hid.enumerate(args.vid, args.pid))
    if args.list:
        if not entries:
            print(f"No HID collections for {args.vid:04x}:{args.pid:04x}")
            return 1
        for entry in entries:
            print(describe(entry))
        return 0
    entry = select_device(hid, args.vid, args.pid, args.path)
    device = hid.device()
    try:
        device.open_path(entry["path"])
        try:
            device.set_nonblocking(False)
        except (AttributeError, OSError):
            pass
        # Drain stale reports without allowing an old transfer to satisfy this probe.
        try:
            device.set_nonblocking(True)
            while device.read(REPORT_SIZE):
                pass
            device.set_nonblocking(False)
        except (AttributeError, OSError, TypeError):
            pass
        transfer_id = secrets.randbits(32) or 1
        write_report(device, request_report(transfer_id))
        flags, payload = receive_response(device, transfer_id, args.timeout_ms)
        if flags & FLAG_ERROR:
            raise RuntimeError(parse_error(payload))
        info = parse_info(payload)
        if args.json:
            print(json.dumps(asdict(info), indent=2, sort_keys=True))
        else:
            print("TA startup: OK (GET_INFO invoked OSUMANIA_TA_GET_DEVICE)")
            print(f"protocol_version:  {info.protocol_version}")
            print(f"report_size:       {info.report_size}")
            print(f"capability_flags:  0x{info.capability_flags:08x}")
            print(f"device_address:    {info.device_address}")
            print(f"bitstream_hash:    {info.bitstream_hash}")
            print(f"input_policy_hash: {info.input_policy_hash}")
            print(f"srs_hash:          {info.srs_hash}")
            print(f"max_events:        {info.max_events}")
        return 0
    finally:
        device.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, TimeoutError, OSError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
