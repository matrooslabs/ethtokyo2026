"""Fiat-Shamir transcript, identical to rust/src/gkr/transcript.rs (and circomlib MiMC7).

Upstream python used ethsnarks.mimc.mimc_hash of the *current* message only, which is
not even the same MiMC as circomlib's MiMC7. This module is the fixed, chained,
circomlib-compatible transcript:

  init:        s = MultiMiMC7([domain], k = 0)
  absorb(xs):  s = MultiMiMC7([s, len(xs), xs...], k = 0)
  squeeze():   s = MultiMiMC7([s], k = 1); return s
"""
from ethsnarks import field

try:  # pysha3 (installed with ethsnarks)
    from sha3 import keccak_256 as _keccak
except ImportError:  # pragma: no cover
    from Crypto.Hash import keccak as _k

    def _keccak(data):
        return _k.new(digest_bits=256, data=data)

P = field.SNARK_SCALAR_FIELD
ROUNDS = 91
DOMAIN_PROOF = 0x676B722D66732D31  # "gkr-fs-1"
DOMAIN_CIRCUIT = 0x676B722D63697263  # "gkr-circ"


def _constants():
    cts = [0]
    h = _keccak(b"mimc").digest()
    for _ in range(1, ROUNDS):
        h = _keccak(h.lstrip(b"\x00")).digest()
        cts.append(int.from_bytes(h, "big") % P)
    return cts


CONSTANTS = _constants()


def mimc7(x, k):
    x, k = int(x) % P, int(k) % P
    h = 0
    for i, c in enumerate(CONSTANTS):
        t = (x + k) % P if i == 0 else (h + k + c) % P
        h = pow(t, 7, P)
    return (h + k) % P


def multi_mimc7(xs, k):
    r = int(k) % P
    for x in xs:
        x = int(x) % P
        r = (r + x + mimc7(x, r)) % P
    return r


class Transcript:
    def __init__(self, domain):
        self.state = multi_mimc7([domain], 0)

    def absorb(self, xs):
        xs = [int(x) % P for x in xs]
        self.state = multi_mimc7([self.state, len(xs)] + xs, 0)

    def squeeze(self):
        self.state = multi_mimc7([self.state], 1)
        return field.FQ(self.state)

    def squeeze_n(self, n):
        return [self.squeeze() for _ in range(n)]
