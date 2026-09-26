#!/usr/bin/env python3
import ctypes as C
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "package/bridge-daemon"
VECTORS = ROOT / "tests/bridge-crypto-vectors.json"
SRS = SRC / "data/srs-g1-be.bin"


def build_library(path):
    subprocess.run([
        "cc", "-shared", "-fPIC", "-std=c11", "-O2", "-Wall", "-Wextra",
        "-Wno-deprecated-declarations", "-I", str(SRC), "-o", str(path),
        str(SRC / "osumania_protocol.c"), str(SRC / "osumania_crypto.c"),
        str(SRC / "optee_signer.c"), str(SRC / "keccak256.c"), "-lcrypto",
    ], check=True)


class Event(C.Structure):
    _fields_ = [("sequence", C.c_uint32), ("timestamp_us", C.c_uint64),
                ("lane", C.c_uint8), ("action", C.c_uint8), ("wire", C.c_uint8 * 14)]


class Rx(C.Structure):
    _fields_ = [("active", C.c_bool), ("message_type", C.c_uint8),
                ("transfer_id", C.c_uint32), ("total_length", C.c_uint32),
                ("next_offset", C.c_uint32), ("data", C.c_uint8 * 292)]


class Request(C.Structure):
    _fields_ = [("message_type", C.c_uint8), ("transfer_id", C.c_uint32),
                ("length", C.c_uint32), ("payload", C.POINTER(C.c_uint8))]


READ = C.CFUNCTYPE(C.c_int, C.c_void_p, C.c_uint32, C.POINTER(C.c_uint8), C.c_size_t)


class Tx(C.Structure):
    _fields_ = [("active", C.c_bool), ("zero_sent", C.c_bool),
                ("message_type", C.c_uint8), ("flags", C.c_uint8),
                ("transfer_id", C.c_uint32), ("total_length", C.c_uint32),
                ("offset", C.c_uint32), ("read", READ), ("context", C.c_void_p)]


class SignerInfo(C.Structure):
    _fields_ = [("device", C.c_uint8 * 20), ("bitstream_hash", C.c_uint8 * 32)]


def configure(lib):
    lib.osum_crypto_create.argtypes = [C.c_char_p]; lib.osum_crypto_create.restype = C.c_void_p
    lib.osum_crypto_destroy.argtypes = [C.c_void_p]
    lib.osum_crypto_reset.argtypes = [C.c_void_p, C.POINTER(C.c_uint8)]
    lib.osum_event_encode.argtypes = [C.POINTER(Event), C.c_uint32, C.c_uint64, C.c_uint8, C.c_uint8]
    lib.osum_crypto_add.argtypes = [C.c_void_p, C.POINTER(Event)]
    lib.osum_crypto_finalize.argtypes = [C.c_void_p, C.POINTER(C.c_uint8), C.POINTER(C.c_uint8)]
    lib.osum_rx_reset.argtypes = [C.POINTER(Rx)]
    lib.osum_rx_report.argtypes = [C.POINTER(Rx), C.POINTER(C.c_uint8), C.POINTER(Request)]
    lib.osum_rx_report.restype = C.c_int
    lib.osum_tx_begin.argtypes = [C.POINTER(Tx), C.c_uint8, C.c_uint8, C.c_uint32,
                                  C.c_uint32, READ, C.c_void_p]
    lib.osum_tx_next.argtypes = [C.POINTER(Tx), C.POINTER(C.c_uint8)]
    lib.osum_signer_open.argtypes = [C.c_char_p]; lib.osum_signer_open.restype = C.c_void_p
    lib.osum_signer_close.argtypes = [C.c_void_p]
    lib.osum_signer_get_info.argtypes = [C.c_void_p, C.POINTER(SignerInfo)]
    lib.osum_signer_set_header.argtypes = [C.c_void_p, C.POINTER(C.c_uint8), C.POINTER(C.c_uint8)]
    lib.osum_signer_start.argtypes = [C.c_void_p]
    lib.osum_signer_finalize.argtypes = [C.c_void_p, C.c_uint32, C.c_uint64,
                                         C.POINTER(C.c_uint8), C.POINTER(C.c_uint8)]
    lib.osum_signer_get_result.argtypes = [C.c_void_p, C.POINTER(C.c_uint8)]
    lib.osum_signer_abort.argtypes = [C.c_void_p]


def report(msg, transfer, offset, total, payload=b"", flags=0):
    assert len(payload) <= 48
    return bytes([0x4d, 1, msg, flags]) + transfer.to_bytes(4, "big") + \
        offset.to_bytes(4, "big") + total.to_bytes(4, "big") + payload.ljust(48, b"\0")


def test_protocol(lib):
    source = bytes((i * 17 + 3) & 0xff for i in range(292))
    rx, req = Rx(), Request(); lib.osum_rx_reset(C.byref(rx))
    for offset in range(0, len(source), 48):
        raw = report(0x10, 0x01020304, offset, len(source), source[offset:offset + 48])
        assert raw[:16] == bytes.fromhex("4d01100001020304") + offset.to_bytes(4, "big") + bytes.fromhex("00000124")
        assert lib.osum_rx_report(C.byref(rx), (C.c_uint8 * 64).from_buffer_copy(raw), C.byref(req)) == 0
    assert req.message_type == 0x10 and req.transfer_id == 0x01020304 and req.length == 292
    assert C.string_at(req.payload, req.length) == source

    lib.osum_rx_reset(C.byref(rx))
    first = report(0x10, 7, 0, 292, source[:48])
    assert lib.osum_rx_report(C.byref(rx), (C.c_uint8 * 64).from_buffer_copy(first), C.byref(req)) == 0
    bad = report(0x10, 7, 96, 292, source[96:144])
    assert lib.osum_rx_report(C.byref(rx), (C.c_uint8 * 64).from_buffer_copy(bad), C.byref(req)) == 4
    assert not rx.active
    padded = bytearray(report(0x10, 8, 288, 292, source[288:])); padded[-1] = 1
    assert lib.osum_rx_report(C.byref(rx), (C.c_uint8 * 64).from_buffer_copy(padded), C.byref(req)) == 3
    zero = report(0x11, 9, 0, 0)
    assert lib.osum_rx_report(C.byref(rx), (C.c_uint8 * 64).from_buffer_copy(zero), C.byref(req)) == 0
    assert req.message_type == 0x11 and req.length == 0

    response = bytes((i * 29 + 1) & 0xff for i in range(465))
    @READ
    def copy(_ctx, offset, dst, length):
        C.memmove(dst, response[offset:offset + length], length); return 0
    tx = Tx(); lib.osum_tx_begin(C.byref(tx), 0x20, 1, 0xa0b0c0d0, len(response), copy, None)
    rebuilt = bytearray(); packets = 0
    while True:
        out = (C.c_uint8 * 64)(); status = lib.osum_tx_next(C.byref(tx), out)
        if status == 0: break
        assert status == 1
        raw = bytes(out); offset = int.from_bytes(raw[8:12], "big")
        assert raw[:8] == bytes.fromhex("4d012001a0b0c0d0")
        assert int.from_bytes(raw[12:16], "big") == 465
        take = min(48, 465 - offset); rebuilt += raw[16:16 + take]
        assert raw[16 + take:] == b"\0" * (48 - take); packets += 1
    assert packets == 10 and bytes(rebuilt) == response


def test_crypto(lib):
    vectors = json.loads(VECTORS.read_text())["cases"]
    assert not lib.osum_crypto_create(None)
    for case in vectors:
        crypto = lib.osum_crypto_create(os.fsencode(SRS)); assert crypto
        try:
            sid = (C.c_uint8 * 32)(*case["session_id"])
            assert lib.osum_crypto_reset(crypto, sid) == 0
            for item in case["events"]:
                event = Event()
                assert lib.osum_event_encode(C.byref(event), item["sequence"], item["timestamp_us"],
                                             item["lane"], item["action"]) == 0
                assert bytes(event.wire) == item["sequence"].to_bytes(4, "big") + \
                    item["timestamp_us"].to_bytes(8, "big") + bytes([item["lane"], item["action"]])
                assert lib.osum_crypto_add(crypto, C.byref(event)) == 0
            root, commitment = (C.c_uint8 * 32)(), (C.c_uint8 * 64)()
            assert lib.osum_crypto_finalize(crypto, root, commitment) == 0
            assert bytes(root) == bytes.fromhex(case["traceRoot"][2:]), case["name"]
            expected = b"".join(int(value, 16).to_bytes(32, "big") for value in case["traceCommitment"])
            assert bytes(commitment) == expected, case["name"]
        finally:
            lib.osum_crypto_destroy(crypto)


P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f
N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141
G = (55066263022277343669578718895168534326250603453777594175500187360389116729240,
     32670510020758816978083085130507043184471273380659243275938904335757337482424)


def add(a, b):
    if a is None: return b
    if b is None: return a
    x, y = a; u, v = b
    if x == u:
        if (y + v) % P == 0: return None
        slope = 3 * x * x * pow(2 * y, -1, P) % P
    else: slope = (v - y) * pow((u - x) % P, -1, P) % P
    nx = (slope * slope - x - u) % P
    return nx, (slope * (x - nx) - y) % P


def mul(k, point):
    out = None
    while k:
        if k & 1: out = add(out, point)
        point = add(point, point); k >>= 1
    return out


def recover(digest, signature):
    r, s = int.from_bytes(signature[:32], "big"), int.from_bytes(signature[32:64], "big")
    recid = signature[64] - 27
    assert 0 < r < N and 0 < s <= N // 2 and recid < 2
    x = r + (recid // 2) * N; assert x < P
    alpha = (pow(x, 3, P) + 7) % P; y = pow(alpha, (P + 1) // 4, P)
    if y & 1 != recid & 1: y = P - y
    R = (x, y); assert mul(N, R) is None
    e = int.from_bytes(digest, "big")
    return mul(pow(r, -1, N), add(mul(s, R), mul((-e) % N, G)))


def test_signer(lib):
    os.environ["DEV_INSECURE_PRIVATE_KEY"] = "11" * 32
    os.environ["OSUMANIA_BITSTREAM_HASH"] = "44" * 32
    signer = lib.osum_signer_open(b"dev-insecure"); assert signer
    try:
        info = SignerInfo(); assert lib.osum_signer_get_info(signer, C.byref(info)) == 0
        doc = json.loads(VECTORS.read_text())
        header = bytearray.fromhex(doc["cases"][0]["headerPackedV2"][2:])
        header[144:164] = bytes(info.device); header[228:260] = bytes(info.bitstream_hash)
        header_c = (C.c_uint8 * 292).from_buffer_copy(header); detail = C.c_uint8()
        assert lib.osum_signer_start(signer) != 0
        assert lib.osum_signer_set_header(signer, header_c, C.byref(detail)) == 0
        assert lib.osum_signer_start(signer) == 0
        root = bytes(range(32)); commitment = bytes(range(64))
        assert lib.osum_signer_finalize(signer, 33, 1234567,
            (C.c_uint8 * 32).from_buffer_copy(root),
            (C.c_uint8 * 64).from_buffer_copy(commitment)) == 0
        a, b = (C.c_uint8 * 465)(), (C.c_uint8 * 465)()
        assert lib.osum_signer_get_result(signer, a) == 0 and lib.osum_signer_get_result(signer, b) == 0
        result = bytes(a); assert result == bytes(b) and result[:292] == header
        fields = (33).to_bytes(4, "big") + (1234567).to_bytes(8, "big") + root + commitment
        assert result[292:400] == fields
        preimage = b"OSUMANIA_HARDWARE_SESSION_V2" + (2).to_bytes(2, "big") + bytes(header) + fields
        assert len(preimage) == 430
        digest = hashlib.sha256(preimage).digest()
        assert recover(digest, result[400:]) == mul(int("11" * 32, 16), G)
        assert lib.osum_signer_abort(signer) == 0
    finally:
        lib.osum_signer_close(signer)


def main():
    with tempfile.TemporaryDirectory() as directory:
        library = Path(directory) / "libbridgecheck.so"; build_library(library)
        lib = C.CDLL(str(library)); configure(lib)
        test_protocol(lib); test_crypto(lib); test_signer(lib)
    print("PASS byte-exact HID framing, 10 canonical SHA/BN254 vectors, 430-byte signing preimage/result")


if __name__ == "__main__":
    main()
