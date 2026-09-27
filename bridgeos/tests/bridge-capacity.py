#!/usr/bin/env python3
"""Host-only 50k Vendor HID Mode B session smoke; repeated generator is insecure.

Run from any directory with python3 bridgeos/tests/bridge-capacity.py. Builds a
throwaway host daemon, generates exactly 200,000 compressed BLS12-381 G1 points
from one known generator, and drives its real Vendor HID thread. This test bank
MUST NEVER be deployed on the board or used to fund a prize.
"""
from __future__ import annotations
import argparse
import ctypes
import hashlib
import importlib.util
import pathlib
import select
import socket
import struct
import subprocess
import sys
import tempfile
import time

BRIDGE = pathlib.Path(__file__).resolve().parent.parent
SOURCE = BRIDGE / "package/bridge-daemon"
MAC_SOURCE = BRIDGE / "tools/macos-vendor-hid-signing-test.py"
spec = importlib.util.spec_from_file_location("bridge_capacity_mac", MAC_SOURCE)
mac = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mac
spec.loader.exec_module(mac)
sys.path.insert(0, str(BRIDGE / "tests/vendor-hid"))
import check_vectors as bls

EVENTS = 50_000
POINT = bls.GENERATOR


class SocketHid:
    """HID report transport only; framing and response validation use Mac code."""

    def __init__(self, connection: socket.socket):
        self.connection = connection

    def write(self, framed: bytes) -> int:
        if len(framed) == 65 and framed[0] == 0:
            report = framed[1:]
        else:
            report = framed
        if len(report) != 64 or self.connection.send(report) != 64:
            raise RuntimeError("short host Vendor HID report")
        return len(framed)

    def read(self, size: int, timeout_ms: int) -> list[int]:
        ready, _, _ = select.select([self.connection], [], [], timeout_ms / 1000)
        if not ready:
            return []
        report = self.connection.recv(size)
        if len(report) != 64:
            raise RuntimeError(f"short device Vendor HID report: {len(report)}")
        return list(report)


def command(child: subprocess.Popen[str], count: int) -> tuple[int, int, int]:
    assert child.stdin and child.stdout
    child.stdin.write(f"CAPTURE {count}\n")
    child.stdin.flush()
    response = child.stdout.readline().split()
    if len(response) != 4 or response[0] != "CAPTURED":
        raise RuntimeError(f"device capture failure: {response!r}")
    return tuple(map(int, response[1:]))


def expect_error(device: SocketHid, request: int, code: str) -> None:
    try:
        mac.transact(device, request)
    except RuntimeError as error:
        if code not in str(error):
            raise AssertionError(f"expected {code}, got {error}") from error
    else:
        raise AssertionError(f"request 0x{request:02x} unexpectedly succeeded")


def test_mac_trace_cap() -> None:
    client, server = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    try:
        report = bytearray(mac.make_report(mac.GET_TRACE, 7, 0, 700_001, b""))
        report[3] = mac.base.FLAG_RESPONSE
        server.send(report)
        try:
            mac.receive(SocketHid(client), mac.GET_TRACE, 7, 1000)
        except RuntimeError as error:
            if "unreasonable response length: 700001" not in str(error):
                raise
        else:
            raise AssertionError("Mac accepted a trace exceeding 700,000 bytes")
    finally:
        client.close()
        server.close()


def ensure_keccak(tempdir: pathlib.Path) -> None:
    """Use the existing C Keccak when the optional Mac PyCryptodome is absent."""
    try:
        mac.import_keccak()
        return
    except RuntimeError:
        pass
    library_path = tempdir / "libbridge-keccak.so"
    subprocess.run(["cc", "-shared", "-fPIC", str(SOURCE / "keccak256.c"),
                    "-o", str(library_path)], check=True)
    library = ctypes.CDLL(str(library_path))
    library.osum_keccak256.argtypes = (ctypes.POINTER(ctypes.c_uint8), ctypes.c_size_t,
                                       ctypes.POINTER(ctypes.c_uint8))
    library.osum_keccak256.restype = None

    class CKeccak:
        def __init__(self) -> None:
            self.payload = bytearray()

        @staticmethod
        def new(*, digest_bits: int) -> CKeccak:
            if digest_bits != 256:
                raise ValueError("only Keccak-256 is supported")
            return CKeccak()

        def update(self, content: bytes) -> None:
            self.payload.extend(content)

        def digest(self) -> bytes:
            source = (ctypes.c_uint8 * len(self.payload)).from_buffer(self.payload)
            output = (ctypes.c_uint8 * 32)()
            library.osum_keccak256(source, len(source), output)
            return bytes(output)

    mac.import_keccak = lambda: CKeccak


def run_session(binary: pathlib.Path, bank_path: pathlib.Path, bank_hash: str,
                interval_us: int) -> None:
    host, device_socket = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    try:
        with subprocess.Popen([str(binary), str(device_socket.fileno()), str(bank_path),
                               str(interval_us)], pass_fds=(device_socket.fileno(),),
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              text=True) as child:
            device_socket.close()
            assert child.stdout and child.stdin
            if child.stdout.readline().strip() != "READY":
                raise RuntimeError("host Vendor HID daemon did not start")
            hid = SocketHid(host)
            info = mac.get_info(hid, 30_000)
            if info.max_events != EVENTS or info.srs_hash.lower() != bank_hash:
                raise AssertionError("GET_INFO did not advertise the installed 200,000-point bank")
            # Explicit hash is ONLY for the temporary, insecure, known-generator test bank.
            bank = mac.load_srs(bank_path, info, bank_hash)
            if len(bank) != EVENTS * 4 * 48:
                raise AssertionError("temporary BLS bank is not exactly 200,000 points")
            header, session_id = mac.build_header(info)
            mac.transact(hid, mac.SET_HEADER, header)
            mac.transact(hid, mac.START)
            started = time.monotonic()
            if command(child, EVENTS) != (EVENTS, 2, 0):
                raise AssertionError("capture failed before event 50,000")
            elapsed = time.monotonic() - started
            mac.transact(hid, mac.STOP, timeout_ms=180_000)
            status = mac.parse_status(mac.transact(hid, mac.GET_STATUS))
            if (status["state"], status["error"], status["event_count"]) != (3, 0, EVENTS):
                raise AssertionError(f"invalid finalized status: {status}")
            result = mac.transact(hid, mac.GET_RESULT)
            trace = mac.transact(hid, mac.GET_TRACE, timeout_ms=90_000)
            if len(trace) != 700_000 or struct.unpack_from(">I", result, 292)[0] != EVENTS:
                raise AssertionError("GET_TRACE size or signed n is not exactly 50,000 events")
            verified = mac.verify_result(info, header, session_id, result, trace, EVENTS)
            # One scalar multiplication checks all 50k row-major trace rows
            # against the independent BLS12-381 oracle for this repeated basis.
            total = sum(struct.unpack_from(">Q", trace, pos + 4)[0] + trace[pos + 12]
                        + trace[pos + 13] for pos in range(0, len(trace), mac.EVENT_SIZE))
            expected = bls.encode(bls.multiply(total % bls.R, bls.decode(POINT)))
            if result[336:384] != expected:
                raise AssertionError("50k signed BLS commitment differs from captured trace")
            if verified["event_count"] != EVENTS:
                raise AssertionError("Mac verifier rejected 50,000 events")
            print(f"PASS GET_INFO=50000, 700000-byte GET_TRACE, signed n=50000, "
                  f"root, commitment, signature; capture={elapsed:.2f}s", flush=True)

            mac.transact(hid, mac.ABORT)
            mac.transact(hid, mac.SET_HEADER, header)
            mac.transact(hid, mac.START)
            if command(child, EVENTS + 1) != (EVENTS, 255, 6):
                raise AssertionError("event 50,001 did not invalidate the recording")
            status = mac.parse_status(mac.transact(hid, mac.GET_STATUS))
            if (status["state"], status["error"], status["event_count"]) != (255, 6, EVENTS):
                raise AssertionError(f"overflow status changed: {status}")
            expect_error(hid, mac.STOP, "BAD_STATE")
            expect_error(hid, mac.GET_RESULT, "BAD_STATE")
            expect_error(hid, mac.GET_TRACE, "BAD_STATE")
            mac.transact(hid, mac.ABORT)
            print("PASS edge 50001=EVENT_OVERFLOW; no signed result or trace", flush=True)
            child.stdin.close()
            if child.wait(timeout=15):
                raise RuntimeError(f"harness exited {child.returncode}")
    finally:
        host.close()
        device_socket.close()


def run_missing_bank(binary: pathlib.Path, directory: pathlib.Path) -> None:
    host, device_socket = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    try:
        with subprocess.Popen([str(binary), str(device_socket.fileno()),
                               str(directory / "absent-bank.bin"), "0"],
                              pass_fds=(device_socket.fileno(),),
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as child:
            device_socket.close()
            assert child.stdin and child.stdout
            if child.stdout.readline().strip() != "READY":
                raise RuntimeError("missing-bank host could not start")
            expect_error(SocketHid(host), mac.base.GET_INFO, "SRS unavailable")
            child.stdin.close()
            if child.wait(timeout=15):
                raise RuntimeError(f"missing-bank harness exited {child.returncode}")
            print("PASS absent SRS: GET_INFO=NOT_READY, no advertised capacity", flush=True)
    finally:
        host.close()
        device_socket.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--interval-us", type=int, default=1000,
                        help="capture producer interval; 0 stress-tests queue saturation")
    args = parser.parse_args()
    if not 0 <= args.interval_us <= 1_000_000:
        parser.error("interval must be from 0 to 1000000 microseconds")
    with tempfile.TemporaryDirectory(prefix="bridge-capacity-INSECURE-") as temporary:
        path = pathlib.Path(temporary)
        binary, bank_path = path / "device", path / "INSECURE-repeated-generator.bin"
        sources = ("osumania_crypto.c", "osumania_protocol.c", "osumania_session.c",
                   "osumania_vendor.c", "optee_signer.c", "keccak256.c")
        subprocess.run(["cc", "-O2", "-Wno-deprecated-declarations", "-pthread",
                        "-DOSUMANIA_ALLOW_DEV_CRYPTO", "-I", str(SOURCE), str(BRIDGE / "tests/bridge-capacity-device.c"),
                        *(str(SOURCE / name) for name in sources), "-lcrypto", "-o", str(binary)],
                       check=True)
        ensure_keccak(path)
        test_mac_trace_cap()
        # Known tau=1 is not trusted or ceremony-derived; never package or advertise this bank.
        with bank_path.open("wb") as bank_file:
            block = POINT * 4096
            for _ in range(200_000 // 4096):
                bank_file.write(block)
            bank_file.write(POINT * (200_000 % 4096))
        bank_hash = hashlib.sha256(bank_path.read_bytes()).hexdigest()
        run_missing_bank(binary, path)
        run_session(binary, bank_path, bank_hash, args.interval_us)


if __name__ == "__main__":
    main()
