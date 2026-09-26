//! BLS12-381 scalar field helpers and the Sui wire encodings.
//!
//! Sui exposes group operations only for BLS12-381 (`sui::bls12381`), so this port replaces
//! BN254 by BLS12-381. Encodings match Sui's natives: scalars are 32-byte big-endian and
//! canonical (< r); G1/G2 points are ZCash-compressed (48 / 96 bytes).
pub use halo2curves::bls12381::{Fr as F, G1Affine, G2Affine, G1, G2};
pub use halo2curves::ff::{Field, PrimeField};
pub use halo2curves::group::{prime::PrimeCurveAffine, Curve, GroupEncoding, Group};

pub type Word = [u8; 32];
pub type G1Bytes = [u8; 48];
pub type G2Bytes = [u8; 96];

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

/// Rejects non-canonical encodings (>= r); the Move verifier does the same.
pub fn fe_from_be(bytes: &Word) -> Option<F> {
    let mut le = *bytes;
    le.reverse();
    let mut repr = <F as PrimeField>::Repr::default();
    repr.as_mut().copy_from_slice(&le);
    Option::from(F::from_repr(repr))
}

/// Small nonnegative integers only (used for tests/debug output).
pub fn fe_to_u64(x: &F) -> Option<u64> {
    let be = fe_to_be(x);
    if be[..24].iter().any(|&b| b != 0) {
        return None;
    }
    Some(u64::from_be_bytes(be[24..].try_into().unwrap()))
}

/// ZCash-compressed G1 (the format of `sui::bls12381::g1_from_bytes`).
pub fn g1_to_bytes(p: &G1Affine) -> G1Bytes {
    let c = p.to_bytes();
    let mut out = [0u8; 48];
    out.copy_from_slice(c.as_ref());
    out
}

/// Decodes and validates (on curve, in the subgroup, canonical flags).
pub fn g1_from_bytes(b: &[u8]) -> Option<G1Affine> {
    let mut c = <G1Affine as GroupEncoding>::Repr::default();
    if b.len() != c.as_ref().len() {
        return None;
    }
    c.as_mut().copy_from_slice(b);
    Option::from(G1Affine::from_bytes(&c))
}

/// ZCash-compressed G2 (the format of `sui::bls12381::g2_from_bytes`). halo2curves writes
/// x as (c0, c1) with the flags on c0; ZCash writes (c1, c0) with the flags on c1.
pub fn g2_to_bytes(p: &G2Affine) -> G2Bytes {
    let c = p.to_bytes();
    let h = c.as_ref();
    let flags = h[0] & 0xe0;
    let mut out = [0u8; 96];
    out[..48].copy_from_slice(&h[48..]);
    out[48..].copy_from_slice(&h[..48]);
    out[48] &= 0x1f;
    out[0] |= flags;
    out
}

pub fn hex0x(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
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
        p[31] += 1; // r itself is non-canonical
        assert_eq!(fe_from_be(&p), None);
        assert_eq!(fe_to_u64(&x), Some(0x1234_5678_9abc_def0));
        // r = 0x73eda753…00000001
        assert_eq!(hex::encode(p), "73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001");
    }

    /// The generators must encode exactly as the constants in sui::bls12381.
    #[test]
    fn point_encoding_matches_sui() {
        assert_eq!(
            hex::encode(g1_to_bytes(&G1Affine::generator())),
            "97f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb"
        );
        assert_eq!(
            hex::encode(g1_to_bytes(&G1Affine::identity())),
            "c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"
        );
        assert_eq!(
            hex::encode(g2_to_bytes(&G2Affine::generator())),
            "93e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8"
        );
        let p = (G1::generator() * F::from(12345)).to_affine();
        assert_eq!(g1_from_bytes(&g1_to_bytes(&p)), Some(p));
    }

    /// Cross-check against the zkcrypto reference, including both y-sign cases.
    #[test]
    fn point_encoding_matches_reference() {
        use halo2curves::ff::Field as _;
        use rand::SeedableRng;
        let mut rng = rand_chacha::ChaCha20Rng::seed_from_u64(1);
        let mut signs = [false; 2];
        for i in 0..64u64 {
            let k = if i < 4 { F::from(i) } else { F::random(&mut rng) };
            let kr = bls12_381::Scalar::from_bytes(&{
                let mut le = fe_to_be(&k);
                le.reverse();
                le
            })
            .unwrap();
            let g1 = (G1::generator() * k).to_affine();
            let r1 = bls12_381::G1Affine::from(bls12_381::G1Affine::generator() * kr);
            assert_eq!(g1_to_bytes(&g1), r1.to_compressed());
            let g2 = (G2::generator() * k).to_affine();
            let r2 = bls12_381::G2Affine::from(bls12_381::G2Affine::generator() * kr);
            let b = g2_to_bytes(&g2);
            assert_eq!(b, r2.to_compressed(), "G2 mismatch for k #{i}");
            if i > 0 {
                signs[((b[0] >> 5) & 1) as usize] = true;
            }
        }
        assert_eq!(signs, [true, true], "both y-sign cases exercised");
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
