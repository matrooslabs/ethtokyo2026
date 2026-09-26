/// Keccak256 Fiat–Shamir transcript (SPEC-SUI §3), byte-for-byte the engine's `Transcript`.
/// Framed for natives only: `absorb(items)`: s = keccak(BCS(s, items));
/// `squeeze()`: s = keccak(s), challenge = s with its top two bits cleared (< 2^254 < r).
module mania_gkr::transcript;

use sui::bcs;
use sui::bls12381::{Self, Scalar};
use sui::group_ops::Element;
use sui::hash::keccak256;

const EEmptyAbsorb: u64 = 1;

public struct Transcript has copy, drop {
    state: vector<u8>,
}

/// BCS: uleb(32) ‖ state ‖ uleb(k) ‖ Σ uleb(|item|) ‖ item.
public struct Absorb has drop {
    state: vector<u8>,
    items: vector<vector<u8>>,
}

/// Same BCS layout as `Absorb`: an Element<Scalar> serializes as its 32 bytes.
public struct AbsorbScalars has drop {
    state: vector<u8>,
    items: vector<Element<Scalar>>,
}

public fun new(domain: vector<u8>): Transcript {
    Transcript { state: keccak256(&domain) }
}

public fun absorb(t: &mut Transcript, items: vector<vector<u8>>) {
    assert!(!items.is_empty(), EEmptyAbsorb);
    t.state = keccak256(&bcs::to_bytes(&Absorb { state: t.state, items }));
}

public fun absorb_scalars(t: &mut Transcript, xs: &vector<Element<Scalar>>) {
    assert!(!xs.is_empty(), EEmptyAbsorb);
    t.state = keccak256(&bcs::to_bytes(&AbsorbScalars { state: t.state, items: *xs }));
}

public fun squeeze(t: &mut Transcript): Element<Scalar> {
    t.state = keccak256(&t.state);
    let mut b = t.state;
    *&mut b[0] = b[0] & 0x3f;
    bls12381::scalar_from_bytes(&b)
}

public fun squeeze_n(t: &mut Transcript, n: u64): vector<Element<Scalar>> {
    let mut out = vector[];
    let mut i = 0;
    while (i < n) {
        out.push_back(squeeze(t));
        i = i + 1;
    };
    out
}

public fun state(t: &Transcript): vector<u8> { t.state }
