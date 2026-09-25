//! Keccak256 Fiat–Shamir transcript (SPEC §7.1), mirrored by the `_absorb*`/`_squeeze` helpers of GkrScoreVerifier.sol.
use crate::field::{fe_reduce_be, fe_to_be, g1_to_words, G1Affine, Word, F};
use tiny_keccak::{Hasher, Keccak};

pub fn keccak(parts: &[&[u8]]) -> Word {
    let mut h = Keccak::v256();
    for p in parts {
        h.update(p);
    }
    let mut out = [0u8; 32];
    h.finalize(&mut out);
    out
}

#[derive(Clone)]
pub struct Transcript {
    state: Word,
}

impl Transcript {
    pub fn new(domain: &[u8]) -> Self {
        Self {
            state: keccak(&[domain]),
        }
    }

    /// `s = keccak(s ‖ w_1 ‖ … ‖ w_k)`, k ≥ 1.
    pub fn absorb_words(&mut self, words: &[Word]) {
        assert!(!words.is_empty(), "absorb requires at least one word");
        let mut h = Keccak::v256();
        h.update(&self.state);
        for w in words {
            h.update(w);
        }
        h.finalize(&mut self.state);
    }

    pub fn absorb(&mut self, xs: &[F]) {
        let words: Vec<Word> = xs.iter().map(fe_to_be).collect();
        self.absorb_words(&words);
    }

    pub fn absorb_u64s(&mut self, xs: &[u64]) {
        let words: Vec<Word> = xs.iter().map(|&x| fe_to_be(&F::from(x))).collect();
        self.absorb_words(&words);
    }

    pub fn absorb_g1(&mut self, points: &[G1Affine]) {
        let words: Vec<Word> = points.iter().flat_map(g1_to_words).collect();
        self.absorb_words(&words);
    }

    /// `s = keccak(s)`, challenge = s mod p.
    pub fn squeeze(&mut self) -> F {
        self.state = keccak(&[&self.state]);
        fe_reduce_be(&self.state)
    }

    pub fn squeeze_n(&mut self, n: usize) -> Vec<F> {
        (0..n).map(|_| self.squeeze()).collect()
    }

    pub fn state(&self) -> Word {
        self.state
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keccak_matches_evm_empty_hash() {
        // keccak256("") as used by the EVM.
        assert_eq!(
            hex::encode(keccak(&[b""])),
            "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
        );
    }

    #[test]
    fn transcript_is_order_sensitive() {
        let mut a = Transcript::new(b"d");
        let mut b = Transcript::new(b"d");
        a.absorb(&[F::from(1), F::from(2)]);
        b.absorb(&[F::from(2), F::from(1)]);
        assert_ne!(a.squeeze(), b.squeeze());
    }
}
