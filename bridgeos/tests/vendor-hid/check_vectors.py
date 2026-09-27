#!/usr/bin/env python3
"""Independent BLS12-381 G1 and trace-root oracle for the insecure demo bank.

The local SRS was generated with a known toxic secret; these checks do not certify
secure setup or attest a physical board. Old BN254 commitment fields in the
historical trace vectors are intentionally not consumed.
"""
import hashlib
import json
import struct
import sys
from pathlib import Path

P = int('1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab', 16)
R = int('73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001', 16)
GENERATOR = bytes.fromhex('97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb')
POLICY = hashlib.sha256(b'OSUMANIA_INPUT_POLICY_V2_KZG_BLS12381').digest()


def decode(encoded):
    if encoded == b'\xc0' + bytes(47):
        return None
    if len(encoded) != 48 or encoded[0] & 0xc0 != 0x80:
        raise ValueError('noncanonical BLS compressed point')
    x = int.from_bytes(bytes([encoded[0] & 0x1f]) + encoded[1:], 'big')
    if x >= P:
        raise ValueError('BLS x outside base field')
    square = (x*x*x + 4) % P
    y = pow(square, (P + 1) // 4, P)
    if y*y % P != square:
        raise ValueError('BLS point is off curve')
    if (y > P - y) != bool(encoded[0] & 0x20):
        y = P - y
    return x, y


def encode(point):
    if point is None:
        return b'\xc0' + bytes(47)
    x, y = point
    result = bytearray(x.to_bytes(48, 'big'))
    result[0] |= 0x80 | (0x20 if y > P - y else 0)
    return bytes(result)


def add(a, b):
    if a is None:
        return b
    if b is None:
        return a
    x, y = a
    u, v = b
    if x == u and (y + v) % P == 0:
        return None
    m = ((3 * x*x) * pow(2*y, -1, P) if a == b else
         (v - y) * pow(u - x, -1, P)) % P
    rx = (m*m - x - u) % P
    return rx, (m * (x - rx) - y) % P


def multiply(n, point):
    result = None
    while n:
        if n & 1:
            result = add(result, point)
        point = add(point, point)
        n >>= 1
    return result


def trace_root(session_id, events):
    chain = hashlib.sha256(b'OSUMANIA_TRACE_V1' + session_id).digest()
    for first in range(0, len(events), 32):
        chunk = events[first:first + 32]
        wire = b''.join(struct.pack('>IQBB', e['sequence'], e['timestamp_us'], e['lane'], e['action']) for e in chunk)
        chain = hashlib.sha256(chain + struct.pack('>IH', first // 32, len(chunk)) + wire).digest()
    return chain


def commitment(bank, events):
    if len(bank) < 4 * len(events) * 48 or len(bank) % (4 * 48):
        raise ValueError('BLS bank does not cover the canonical row-major trace')
    accumulator = None
    for i, e in enumerate(events):
        for c, scalar in enumerate((e['timestamp_us'], e['lane'], e['action'])):
            if scalar:
                accumulator = add(accumulator, multiply(scalar, decode(bank[(4*i+c)*48:(4*i+c+1)*48])))
    return encode(accumulator)


def check(folder):
    bank = (folder / 'srs-g1-bls12381.bin').read_bytes()
    if len(bank) != 260 * 48 or bank[:48] != GENERATOR:
        raise ValueError('expected 260 compressed powers of the locally generated BLS SRS')
    assert multiply(R, decode(GENERATOR)) is None
    assert commitment(bank, [{'timestamp_us': 1, 'lane': 0, 'action': 0}]) == GENERATOR
    assert commitment(bank, []) == b'\xc0' + bytes(47)
    doc = json.loads((folder / 'device-vectors.json').read_text())
    for case in doc['cases']:
        events = case['events']
        root = trace_root(bytes(case['headerV2']['session_id']), events)
        assert root == bytes.fromhex(case['traceRoot'][2:]), case['name']
        wire = b''.join(struct.pack('>IQBB', e['sequence'], e['timestamp_us'], e['lane'], e['action']) for e in events)
        assert wire == bytes.fromhex(case['eventBytes'][2:]), case['name']
        value = commitment(bank, events)
        if not events or all(e['timestamp_us'] == e['lane'] == e['action'] == 0 for e in events):
            assert value == b'\xc0' + bytes(47), case['name']
        print('PASS BLS trace', case['name'], 'events=', len(events), 'commitment=', value.hex())
    print('PASS BLS12-381 commitment basis and historical canonical trace SHA vectors')


if __name__ == '__main__':
    check(Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / 'vectors')
