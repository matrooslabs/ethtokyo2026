/// BLS12-381 scalar field helpers over `sui::bls12381` natives (SPEC-SUI §3).
/// Scalars are 32-byte big-endian and canonical (< r); decoding rejects anything else.
module mania_gkr::fr;

use sui::bls12381::{Self, Scalar};
use sui::group_ops::{Self, Element};

public fun zero(): Element<Scalar> { bls12381::scalar_zero() }

public fun one(): Element<Scalar> { bls12381::scalar_one() }

public fun from_u64(x: u64): Element<Scalar> { bls12381::scalar_from_u64(x) }

public fun add(a: &Element<Scalar>, b: &Element<Scalar>): Element<Scalar> {
    bls12381::scalar_add(a, b)
}

public fun sub(a: &Element<Scalar>, b: &Element<Scalar>): Element<Scalar> {
    bls12381::scalar_sub(a, b)
}

public fun mul(a: &Element<Scalar>, b: &Element<Scalar>): Element<Scalar> {
    bls12381::scalar_mul(a, b)
}

public fun neg(a: &Element<Scalar>): Element<Scalar> { bls12381::scalar_neg(a) }

/// Aborts on zero.
public fun inv(a: &Element<Scalar>): Element<Scalar> { bls12381::scalar_inv(a) }

public fun eq(a: &Element<Scalar>, b: &Element<Scalar>): bool { group_ops::equal(a, b) }

public fun is_zero(a: &Element<Scalar>): bool { group_ops::equal(a, &zero()) }

/// 1 − a
public fun one_minus(a: &Element<Scalar>): Element<Scalar> { sub(&one(), a) }

/// Canonical 32-byte big-endian encoding.
public fun to_bytes(a: &Element<Scalar>): vector<u8> { *group_ops::bytes(a) }

/// Canonical big-endian decoding; the native aborts on values ≥ r.
public fun from_bytes(b: &vector<u8>): Element<Scalar> { bls12381::scalar_from_bytes(b) }

/// Scalar of the 8-byte big-endian integer at `b[off..off+8]`, and that integer.
public fun from_be8(b: &vector<u8>, off: u64): (Element<Scalar>, u64) {
    let mut out = x"000000000000000000000000000000000000000000000000";
    let mut x = 0u64;
    let mut i = off;
    while (i < off + 8) {
        let byte = b[i];
        x = (x << 8) | (byte as u64);
        out.push_back(byte);
        i = i + 1;
    };
    (bls12381::scalar_from_bytes(&out), x)
}

public fun be_to_u256(b: &vector<u8>, off: u64): u256 {
    let mut x = 0u256;
    let mut i = 0u64;
    while (i < 32) {
        x = (x << 8) | (b[off + i] as u256);
        i = i + 1;
    };
    x
}

/// 32-byte big-endian word of a u64 (statement encoding).
public fun word_u64(x: u64): vector<u8> { to_bytes(&from_u64(x)) }

/// Π xs[off..off+len]
public fun prod(xs: &vector<Element<Scalar>>, off: u64, len: u64): Element<Scalar> {
    let mut acc = one();
    let mut i = 0u64;
    while (i < len) {
        acc = mul(&acc, &xs[off + i]);
        i = i + 1;
    };
    acc
}

/// Π (1 − xs[j]) for j in off..off+len
public fun prod_one_minus(xs: &vector<Element<Scalar>>, off: u64, len: u64): Element<Scalar> {
    let mut acc = one();
    let mut i = 0u64;
    while (i < len) {
        acc = mul(&acc, &one_minus(&xs[off + i]));
        i = i + 1;
    };
    acc
}

#[test]
fun canonical_decoding() {
    let rm1 = x"73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000000";
    assert!(eq(&add(&from_bytes(&rm1), &one()), &zero()));
    assert!(to_bytes(&from_u64(258)) == x"0000000000000000000000000000000000000000000000000000000000000102");
    let (s, x) = from_be8(&x"ff0000000000000102ff", 1);
    assert!(x == 258 && eq(&s, &from_u64(258)));
}

#[test, expected_failure]
fun rejects_r() {
    from_bytes(&x"73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001");
}
