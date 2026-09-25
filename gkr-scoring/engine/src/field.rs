//! BN254 scalar field helpers and the EVM word encodings used on the wire.
pub use halo2curves::bn256::{Bn256, Fq, Fq2, Fr as F, G1Affine, G2Affine, G1, G2};
pub use halo2curves::ff::{Field, PrimeField};
pub use halo2curves::group::{prime::PrimeCurveAffine, Curve, Group};

pub type Word = [u8; 32];

pub fn fe(x: u64) -> F {
    F::from(x)
}

/// Canonical 32-byte big-endian encoding.
pub fn fe_to_be(x: &F) -> Word {
    let repr = x.to_repr();
    let mut out = [0u8; 32];
    out.copy_from_slice(repr.as_ref());
    out.reverse();
    out
}

/// Rejects non-canonical encodings (>= p); the Solidity verifier does the same.
pub fn fe_from_be(bytes: &Word) -> Option<F> {
    let mut le = *bytes;
    le.reverse();
    let mut repr = <F as PrimeField>::Repr::default();
    repr.as_mut().copy_from_slice(&le);
    Option::from(F::from_repr(repr))
}

/// Interprets 32 bytes as a big-endian integer and reduces it modulo p.
pub fn fe_reduce_be(bytes: &Word) -> F {
    let hi = u128::from_be_bytes(bytes[..16].try_into().unwrap());
    let lo = u128::from_be_bytes(bytes[16..].try_into().unwrap());
    let two128 = F::from_u128(1u128 << 64) * F::from_u128(1u128 << 64);
    F::from_u128(hi) * two128 + F::from_u128(lo)
}

/// Small nonnegative integers only (used for tests/debug output).
pub fn fe_to_u64(x: &F) -> Option<u64> {
    let be = fe_to_be(x);
    if be[..24].iter().any(|&b| b != 0) {
        return None;
    }
    Some(u64::from_be_bytes(be[24..].try_into().unwrap()))
}

pub fn fq_to_be(x: &Fq) -> Word {
    let repr = x.to_repr();
    let mut out = [0u8; 32];
    out.copy_from_slice(repr.as_ref());
    out.reverse();
    out
}

pub fn fq_from_be(bytes: &Word) -> Option<Fq> {
    let mut le = *bytes;
    le.reverse();
    let mut repr = <Fq as PrimeField>::Repr::default();
    repr.as_mut().copy_from_slice(&le);
    Option::from(Fq::from_repr(repr))
}

/// EVM precompile encoding (x, y); identity = (0, 0).
pub fn g1_to_words(p: &G1Affine) -> [Word; 2] {
    if bool::from(p.is_identity()) {
        return [[0u8; 32]; 2];
    }
    [fq_to_be(&p.x), fq_to_be(&p.y)]
}

pub fn g1_from_words(w: &[Word; 2]) -> Option<G1Affine> {
    if w[0] == [0u8; 32] && w[1] == [0u8; 32] {
        return Some(G1Affine::identity());
    }
    let x = fq_from_be(&w[0])?;
    let y = fq_from_be(&w[1])?;
    use halo2curves::CurveAffine;
    Option::from(G1Affine::from_xy(x, y))
}

/// EIP-197 order: x.c1, x.c0, y.c1, y.c0.
pub fn g2_to_words(p: &G2Affine) -> [Word; 4] {
    [
        fq_to_be(p.x.c1()),
        fq_to_be(p.x.c0()),
        fq_to_be(p.y.c1()),
        fq_to_be(p.y.c0()),
    ]
}

pub fn words_to_hex(words: &[Word]) -> Vec<String> {
    words
        .iter()
        .map(|w| format!("0x{}", hex::encode(w)))
        .collect()
}

/// Batch inversion (Montgomery's trick); zero inputs map to zero.
pub fn batch_invert(values: &mut [F]) {
    let mut prefix = Vec::with_capacity(values.len());
    let mut acc = F::ONE;
    for v in values.iter() {
        prefix.push(acc);
        if !bool::from(v.is_zero()) {
            acc *= v;
        }
    }
    let mut inv = acc.invert().unwrap();
    for (v, pre) in values.iter_mut().zip(prefix).rev() {
        if bool::from(v.is_zero()) {
            continue;
        }
        let next = inv * *v;
        *v = inv * pre;
        inv = next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn be_roundtrip_and_canonical() {
        let x = F::from(0x1234_5678_9abc_def0u64);
        let be = fe_to_be(&x);
        assert_eq!(be[31], 0xf0);
        assert_eq!(fe_from_be(&be), Some(x));
        let p_minus_one = -F::ONE;
        let mut p = fe_to_be(&p_minus_one);
        p[31] += 1; // p itself is non-canonical
        assert_eq!(fe_from_be(&p), None);
        assert_eq!(fe_reduce_be(&p), F::ZERO);
        assert_eq!(fe_to_u64(&x), Some(0x1234_5678_9abc_def0));
    }

    #[test]
    fn batch_inversion() {
        let mut v = vec![F::from(3), F::ZERO, F::from(7)];
        batch_invert(&mut v);
        assert_eq!(v[0] * F::from(3), F::ONE);
        assert_eq!(v[1], F::ZERO);
        assert_eq!(v[2] * F::from(7), F::ONE);
    }
}
