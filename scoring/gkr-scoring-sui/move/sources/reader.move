/// Sequential decoder of a proof given as items (32-byte scalars, 48-byte compressed G1),
/// split into groups because a PTB pure argument is capped at 16 KiB. Items are decoded by
/// the natives, which reject non-canonical scalars and invalid points.
module mania_gkr::reader;

use sui::bls12381::{Self, Scalar, G1};
use sui::group_ops::Element;

const EShortProof: u64 = 1;
const ETrailingItems: u64 = 2;

public struct Reader has drop {
    groups: vector<vector<vector<u8>>>,
    g: u64,
    i: u64,
}

public fun new(groups: vector<vector<vector<u8>>>): Reader {
    let mut r = Reader { groups, g: 0, i: 0 };
    skip_empty(&mut r);
    r
}

fun skip_empty(r: &mut Reader) {
    while (r.g < r.groups.length() && r.i == r.groups[r.g].length()) {
        r.g = r.g + 1;
        r.i = 0;
    };
}

/// Position of the next item; advances.
fun advance(r: &mut Reader): (u64, u64) {
    assert!(r.g < r.groups.length(), EShortProof);
    let (g, i) = (r.g, r.i);
    r.i = i + 1;
    skip_empty(r);
    (g, i)
}

public fun scalar(r: &mut Reader): Element<Scalar> {
    let (g, i) = advance(r);
    bls12381::scalar_from_bytes(&r.groups[g][i])
}

public fun scalars(r: &mut Reader, n: u64): vector<Element<Scalar>> {
    let mut out = vector[];
    let mut k = 0;
    while (k < n) {
        out.push_back(scalar(r));
        k = k + 1;
    };
    out
}

/// Next G1 point, decoded and validated, together with its compressed bytes.
public fun g1(r: &mut Reader): (Element<G1>, vector<u8>) {
    let (g, i) = advance(r);
    let b = r.groups[g][i];
    (bls12381::g1_from_bytes(&b), b)
}

public fun finish(r: &Reader) { assert!(r.g == r.groups.length(), ETrailingItems); }
