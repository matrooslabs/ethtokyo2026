//! Fiat–Shamir transcript.
//!
//! Upstream derived every challenge as `MiMC(current message)` only, so a challenge
//! did not depend on the circuit, the public input/output or any earlier message.
//! Here every challenge is squeezed from a running state that has absorbed the
//! domain separator, the circuit digest, the public input and output, and every
//! prover message sent so far (see `prover::prove` / `verifier::verify` for the
//! exact schedule).
//!
//! `MimcTranscript` is designed to be recomputed inside circom with circomlib's
//! `MultiMiMC7(n, 91)`:
//!   init:        s = MultiMiMC7([domain], k = 0)
//!   absorb(xs):  s = MultiMiMC7([s, len(xs), xs...], k = 0)
//!   squeeze():   s = MultiMiMC7([s], k = 1); return s
use ff::{Field, PrimeField};
use halo2curves::bn256::Fr;
use sha3::{Digest, Keccak256};
use std::sync::OnceLock;

/// Domain separator of the main proof transcript ("gkr-fs-1" as a big-endian integer).
pub const DOMAIN_PROOF: u64 = 0x676b_722d_6673_2d31;
/// Domain separator used to derive the circuit digest ("gkr-circ").
pub const DOMAIN_CIRCUIT: u64 = 0x676b_722d_6369_7263;

pub trait Transcript<F>: Sized {
    fn new(domain: u64) -> Self;
    fn absorb(&mut self, xs: &[F]);
    fn squeeze(&mut self) -> F;
    fn squeeze_n(&mut self, n: usize) -> Vec<F> {
        (0..n).map(|_| self.squeeze()).collect()
    }
}

pub const MIMC_ROUNDS: usize = 91;

/// MiMC7 round constants, derived exactly as circomlib / mimc-rs do:
/// c_0 = 0, h_0 = keccak256("mimc"), h_i = keccak256(h_{i-1} without leading zero
/// bytes), c_i = h_i mod r.
fn constants() -> &'static [Fr] {
    static CTS: OnceLock<Vec<Fr>> = OnceLock::new();
    CTS.get_or_init(|| {
        let mut cts = vec![Fr::ZERO];
        let mut h: [u8; 32] = Keccak256::digest(b"mimc").into();
        for _ in 1..MIMC_ROUNDS {
            let first = h.iter().position(|b| *b != 0).unwrap_or(32);
            h = Keccak256::digest(&h[first..]).into();
            cts.push(fr_from_be_bytes_mod(&h));
        }
        cts
    })
}

/// Big-endian bytes reduced modulo r.
pub fn fr_from_be_bytes_mod(bytes: &[u8]) -> Fr {
    let base = Fr::from(256u64);
    bytes
        .iter()
        .fold(Fr::ZERO, |acc, b| acc * base + Fr::from(*b as u64))
}

/// circomlib `MiMC7(91)`.
pub fn mimc7(x_in: Fr, k: Fr) -> Fr {
    let cts = constants();
    let mut h = Fr::ZERO;
    for (i, c) in cts.iter().enumerate() {
        let t = if i == 0 { x_in + k } else { h + k + c };
        let t2 = t.square();
        let t4 = t2.square();
        h = t4 * t2 * t;
    }
    h + k
}

/// circomlib `MultiMiMC7(n, 91)`.
pub fn multi_mimc7(xs: &[Fr], k: Fr) -> Fr {
    let mut r = k;
    for x in xs {
        let h = mimc7(*x, r);
        r += *x + h;
    }
    r
}

#[derive(Clone, Debug)]
pub struct MimcTranscript {
    state: Fr,
}

impl MimcTranscript {
    pub fn state(&self) -> Fr {
        self.state
    }
}

impl Transcript<Fr> for MimcTranscript {
    fn new(domain: u64) -> Self {
        MimcTranscript {
            state: multi_mimc7(&[Fr::from(domain)], Fr::ZERO),
        }
    }

    fn absorb(&mut self, xs: &[Fr]) {
        let mut buf = Vec::with_capacity(xs.len() + 2);
        buf.push(self.state);
        buf.push(Fr::from(xs.len() as u64));
        buf.extend_from_slice(xs);
        self.state = multi_mimc7(&buf, Fr::ZERO);
    }

    fn squeeze(&mut self) -> Fr {
        self.state = multi_mimc7(&[self.state], Fr::ONE);
        self.state
    }
}

/// Converts a field element to its canonical little-endian bytes.
pub fn to_le_bytes<F: PrimeField>(f: &F) -> Vec<u8> {
    f.to_repr().as_ref().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ff012::PrimeField as _;

    fn to_ref(x: Fr) -> mimc_rs::Fr {
        let mut b = [0u8; 32];
        b.copy_from_slice(x.to_repr().as_ref());
        mimc_rs::Fr::from_repr(mimc_rs::FrRepr(b)).unwrap()
    }

    #[test]
    fn mimc_matches_upstream_reference_implementation() {
        let reference = mimc_rs::Mimc7::new(MIMC_ROUNDS);
        for (x, k) in [(0u64, 0u64), (1, 0), (2, 3), (12345, 678910)] {
            let (x, k) = (Fr::from(x), Fr::from(k));
            assert_eq!(to_ref(mimc7(x, k)), reference.hash(&to_ref(x), &to_ref(k)));
            let xs = [x, k, x + k];
            assert_eq!(
                to_ref(multi_mimc7(&xs, k)),
                reference.multi_hash(xs.iter().map(|v| to_ref(*v)).collect(), &to_ref(k))
            );
        }
    }

    #[test]
    fn transcript_binds_order_and_length() {
        let mut a = MimcTranscript::new(DOMAIN_PROOF);
        a.absorb(&[Fr::from(1), Fr::from(2)]);
        let mut b = MimcTranscript::new(DOMAIN_PROOF);
        b.absorb(&[Fr::from(1)]);
        b.absorb(&[Fr::from(2)]);
        assert_ne!(a.squeeze(), b.squeeze());
        let mut c = MimcTranscript::new(DOMAIN_CIRCUIT);
        c.absorb(&[Fr::from(1), Fr::from(2)]);
        let mut d = MimcTranscript::new(DOMAIN_PROOF);
        d.absorb(&[Fr::from(1), Fr::from(2)]);
        assert_ne!(c.squeeze(), d.squeeze());
    }
}

#[cfg(test)]
mod vectors {
    use super::*;

    fn hex(x: Fr) -> String {
        format!("{:?}", x)
    }

    /// Known-answer vectors shared with python/test_security.py (and the circom transcript).
    #[test]
    fn known_answer_vectors() {
        assert_eq!(
            hex(mimc7(Fr::from(2), Fr::from(3))),
            "0x169fb7b0a230e5fa8fba53a45d49e15bb638b970a65854cb3825eb4534d1348d"
        );
        let mut t = MimcTranscript::new(DOMAIN_PROOF);
        t.absorb(&[Fr::from(1), Fr::from(2)]);
        assert_eq!(hex(t.squeeze()), "0x202baedcc3fd6bd533f6fd9e5a7844027c53062cb07965a0461f244d0078eaab");
        assert_eq!(hex(t.squeeze()), "0x177bbe3904bf1de13a201c6d473c033a36e4fa04b599ffe5bbbef72d9fb306d0");
    }
}
