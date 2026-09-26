//! Keccak256 Fiat–Shamir transcript (SPEC-SUI §3), mirrored by `mania_gkr::transcript` in Move.
//!
//! Framed so that Move computes it with natives only (`bcs::to_bytes`, `keccak256`):
//! `absorb(items)`: s = keccak(BCS(s, items)) = keccak(uleb(32) ‖ s ‖ uleb(k) ‖ Σ uleb(|w|) ‖ w);
//! `squeeze()`: s = keccak(s), challenge = s with its top two bits cleared (< 2^254 < r).
use crate::field::{fe_from_be, fe_to_be, g1_to_bytes, G1Affine, Word, F};
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

/// BCS length prefix (ULEB128).
pub fn uleb(mut x: usize, out: &mut Vec<u8>) {
    loop {
        let b = (x & 0x7f) as u8;
        x >>= 7;
        if x == 0 {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
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

    /// `s = keccak(BCS(s, items))`, at least one item.
    pub fn absorb_items<T: AsRef<[u8]>>(&mut self, items: &[T]) {
        assert!(!items.is_empty(), "absorb requires at least one item");
        let mut buf = Vec::with_capacity(40 + items.len() * 50);
        uleb(32, &mut buf);
        buf.extend_from_slice(&self.state);
        uleb(items.len(), &mut buf);
        for it in items {
            let it = it.as_ref();
            uleb(it.len(), &mut buf);
            buf.extend_from_slice(it);
        }
        self.state = keccak(&[&buf]);
    }

    pub fn absorb_words(&mut self, words: &[Word]) {
        self.absorb_items(words);
    }

    pub fn absorb(&mut self, xs: &[F]) {
        let words: Vec<Word> = xs.iter().map(fe_to_be).collect();
        self.absorb_items(&words);
    }

    pub fn absorb_u64s(&mut self, xs: &[u64]) {
        let words: Vec<Word> = xs.iter().map(|&x| fe_to_be(&F::from(x))).collect();
        self.absorb_items(&words);
    }

    /// G1 points enter as 48-byte compressed items.
    pub fn absorb_g1(&mut self, points: &[G1Affine]) {
        let items: Vec<[u8; 48]> = points.iter().map(g1_to_bytes).collect();
        self.absorb_items(&items);
    }

    /// `s = keccak(s)`; the challenge is s with the top two bits cleared.
    pub fn squeeze(&mut self) -> F {
        self.state = keccak(&[&self.state]);
        let mut b = self.state;
        b[0] &= 0x3f;
        fe_from_be(&b).expect("masked word is below r")
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
