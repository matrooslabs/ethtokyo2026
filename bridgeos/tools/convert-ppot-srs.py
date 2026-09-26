#!/usr/bin/env python3
"""Convert a verified PSE BN254 ptau + scoring SRS into an external device G1 bank.

The source digest must be independently obtained/reviewed before invoking this tool;
PSE publishes the download URL, but not a SHA-256 of the prepared .ptau in its README.
The scoring SRS must be produced by `mania-gkr srs --ptau ... --smax 22` (the
scoring loader checks curve membership, generators, and sampled pairings).
Neither an unverified source nor a deterministic development SRS is accepted.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import struct
import tempfile

SOURCE_URL = 'https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_22.ptau'
Q = int('30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47', 16)
MONT_INV = pow(2**256, -1, Q)
POINTS = 200000
SMAX = 22
SOURCE_LENGTH = 4831931538  # S3 Content-Length observed on 2026-09-27; not an integrity digest.
G2_GENERATOR = (
    10857046999023057135944570762232829481370756359578518086990519993285655852781,
    11559732032986387107991004021392285783925812861821192530917403151452391805634,
    8495653923123431417604973247489272438418190587263600148770280649306958101930,
    4082367875863433681332203403145435568316851327593401208105741076214120093531,
)
MASK = (1 << 64) - 1
ROT = ((0, 36, 3, 41, 18), (1, 44, 10, 45, 2), (62, 6, 43, 15, 61),
       (28, 55, 25, 21, 56), (27, 20, 39, 8, 14))
ROUND = (0x0000000000000001, 0x0000000000008082, 0x800000000000808a,
         0x8000000080008000, 0x000000000000808b, 0x0000000080000001,
         0x8000000080008081, 0x8000000000008009, 0x000000000000008a,
         0x0000000000000088, 0x0000000080008009, 0x000000008000000a,
         0x000000008000808b, 0x800000000000008b, 0x8000000000008089,
         0x8000000000008003, 0x8000000000008002, 0x8000000000000080,
         0x000000000000800a, 0x800000008000000a, 0x8000000080008081,
         0x8000000000008080, 0x0000000080000001, 0x8000000080008008)


def fail(message):
    raise SystemExit('ceremony SRS conversion refused: ' + message)


def exact(f, n):
    data = f.read(n)
    if len(data) != n:
        fail('truncated ceremony or scoring SRS')
    return data


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as f:
        while chunk := f.read(4 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def sections(f):
    magic, version, count = struct.unpack('<4sII', exact(f, 12))
    if magic != b'ptau' or version != 1 or not (3 <= count <= 32):
        fail('not a supported snarkjs ptau')
    section = {}
    offset = 12
    for _ in range(count):
        f.seek(offset)
        ty, size = struct.unpack('<IQ', exact(f, 12))
        offset += 12
        if ty in section or offset + size > SOURCE_LENGTH:
            fail('invalid ptau section directory')
        section[ty] = (offset, size)
        offset += size
    if offset != SOURCE_LENGTH:
        fail('ptau section directory does not consume source')
    if not all(x in section for x in (1, 2, 3)):
        fail('missing ptau header/G1/G2 section')
    off, length = section[1]
    if length != 44:
        fail('unexpected ptau header size')
    f.seek(off)
    field_size, = struct.unpack('<I', exact(f, 4))
    modulus = int.from_bytes(exact(f, 32), 'little')
    power, ceremony_power = struct.unpack('<II', exact(f, 8))
    if field_size != 32 or modulus != Q or power != SMAX or ceremony_power < SMAX:
        fail('not the expected BN254 power-22 prepared ceremony')
    if section[2][1] < (1 << SMAX) * 64 or section[3][1] < (1 << SMAX) * 128:
        fail('insufficient contiguous G1 or G2 powers')
    return section


def keccak256(data):
    # Legacy Keccak-256 (Ethereum), not FIPS SHA3-256.
    data = bytearray(data)
    data.append(1)
    data.extend(b'\0' * ((-len(data) - 1) % 136))
    data.append(0x80)
    state = [0] * 25
    for offset in range(0, len(data), 136):
        for i in range(17):
            state[i] ^= int.from_bytes(data[offset + 8*i:offset + 8*i + 8], 'little')
        for rc in ROUND:
            c = [state[x] ^ state[x+5] ^ state[x+10] ^ state[x+15] ^ state[x+20] for x in range(5)]
            for x in range(5):
                d = c[(x-1) % 5] ^ ((c[(x+1) % 5] << 1 | c[(x+1) % 5] >> 63) & MASK)
                for y in range(5):
                    state[x+5*y] ^= d
            b = [0] * 25
            for x in range(5):
                for y in range(5):
                    v = state[x+5*y]
                    r = ROT[x][y]
                    b[y+5*((2*x+3*y) % 5)] = ((v << r) | (v >> (64-r if r else 64))) & MASK
            for x in range(5):
                for y in range(5):
                    state[x+5*y] = b[x+5*y] ^ ((~b[(x+1) % 5+5*y]) & b[(x+2) % 5+5*y])
            state[0] ^= rc
    return b''.join(v.to_bytes(8, 'little') for v in state)[:32]


def canonical(raw):
    value = int.from_bytes(raw, 'little')
    if value >= Q:
        fail('non-canonical Montgomery coordinate')
    return (value * MONT_INV % Q).to_bytes(32, 'big')


def convert(args):
    if keccak256(b'').hex() != 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470':
        fail('Keccak implementation failed known-answer check')
    ptau, scoring, dest = (Path(p).expanduser().resolve() for p in
                            (args.ptau, args.scoring_srs, args.output))
    if dest == ptau or dest == scoring or dest.exists():
        fail('output must be a new file distinct from both inputs')
    if ptau.stat().st_size != SOURCE_LENGTH:
        fail('source length differs from PSE power-22 artifact')
    source_hash = sha256(ptau)
    if source_hash != args.ptau_sha256.lower():
        fail('source SHA-256 differs from independently reviewed value')
    with ptau.open('rb') as source, scoring.open('rb') as srs:
        section = sections(source)
        if exact(srs, 8) != b'MGKRSRS1' or struct.unpack('<I', exact(srs, 4))[0] != SMAX:
            fail('not a scoring MGKRSRS1 power-22 SRS')
        if scoring.stat().st_size != 12 + (SMAX + 3)*128 + (1 << SMAX)*64:
            fail('scoring SRS length mismatch')
        g2_off = section[3][0]
        g2_words = []
        indices = [0, 1] + [(1 << SMAX) - (1 << a) for a in range(SMAX + 1)]
        for i in indices:
            source.seek(g2_off + i*128)
            raw = exact(source, 128)
            if exact(srs, 128) != raw:
                fail('scoring G2 key does not match the ceremony')
            coords = [canonical(raw[j:j+32]) for j in range(0, 128, 32)]
            g2_words.append(b''.join((coords[1], coords[0], coords[3], coords[2])))
        if tuple(int.from_bytes(g2_words[0][j:j+32], 'big') for j in (32, 0, 96, 64)) != G2_GENERATOR:
            fail('G2[0] is not the BN254 generator')
        if g2_words[1] == bytes(128):
            fail('identity G2 tau')
        srs_id = keccak256(b''.join([g2_words[1], *g2_words[3:]])).hex()
        if srs_id != args.srs_id.lower():
            fail('G2 SRS ID differs from scoring prover/contract ID')
        source.seek(section[2][0])
        digest = hashlib.sha256()
        dest.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='wb', dir=dest.parent, prefix='.srs-bank-', delete=False) as out:
                temporary = Path(out.name)
                for i in range(POINTS):
                    raw = exact(source, 64)
                    if raw != exact(srs, 64):
                        fail(f'G1 power {i} does not match the scoring prover SRS')
                    point = canonical(raw[:32]) + canonical(raw[32:])
                    if i == 0 and point != (1).to_bytes(32, 'big') + (2).to_bytes(32, 'big'):
                        fail('G1[0] is not the BN254 generator')
                    x = int.from_bytes(point[:32], 'big')
                    y = int.from_bytes(point[32:], 'big')
                    if (y*y - x*x*x - 3) % Q:
                        fail(f'G1 power {i} is not on BN254')
                    digest.update(point)
                    out.write(point)
            if temporary.stat().st_size != POINTS * 64:
                fail('unexpected output bank size')
            os.replace(temporary, dest)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    print(json.dumps({'source': SOURCE_URL, 'ptauSha256': source_hash, 'format': 'G1_AFFINE_BE_XY_V1',
                      'pointCount': POINTS, 'bytesPerPoint': 64, 'firstExponent': 0,
                      'srsId': '0x' + srs_id, 'g2One': '0x' + g2_words[0].hex(),
                      'g2Tau': '0x' + g2_words[1].hex(), 'bank': str(dest),
                      'bankSha256': digest.hexdigest()}, sort_keys=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ptau', required=True, help='complete official PSE power-22 ceremony file')
    parser.add_argument('--ptau-sha256', required=True, help='independently reviewed complete source SHA-256 (64 hex digits)')
    parser.add_argument('--scoring-srs', required=True, help='scoring SRS generated from the same ceremony at smax 22')
    parser.add_argument('--srs-id', required=True, help='64 hex digits of scoring CLI printed / deployed G2 verifier key ID')
    parser.add_argument('--output', required=True, help='new bank path outside the checkout')
    args = parser.parse_args()
    for field in ('ptau_sha256', 'srs_id'):
        value = getattr(args, field)
        if len(value) != 64 or any(c not in '0123456789abcdefABCDEF' for c in value):
            parser.error('--' + field.replace('_', '-') + ' must be 64 hex digits')
    if Path(args.output).expanduser().resolve().is_relative_to(Path(__file__).resolve().parents[2]):
        fail('production bank must remain outside project checkout')
    convert(args)


if __name__ == '__main__':
    main()
