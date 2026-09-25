//! Zeromorph multilinear evaluation proofs over KZG/BN254 with an explicit
//! degree check for the batched quotient (SPEC §7.6).
use crate::field::{
    g1_to_words, g2_to_words, Curve, Field, G1Affine, G2Affine, Group, PrimeCurveAffine,
    PrimeField, Word, F, G1, G2,
};
use crate::transcript::{keccak, Transcript};
use anyhow::{bail, ensure, Context, Result};
use halo2curves::bn256::{multi_miller_loop, Gt};
use halo2curves::msm::msm_best;
use halo2curves::pairing::MillerLoopResult;
use halo2curves::serde::SerdeObject;
use halo2curves::CurveAffine;
use rand::SeedableRng;
use rayon::prelude::*;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::Path;

/// Powers-of-tau SRS: [τ^i]_1 for i < 2^smax, [1]_2, [τ]_2 and
/// shift[n] = [τ^{2^smax − 2^n}]_2 for n ≤ smax (degree check of q̂ < 2^n).
#[derive(Clone)]
pub struct Srs {
    pub smax: usize,
    pub g1: Vec<G1Affine>,
    pub g2_one: G2Affine,
    pub g2_tau: G2Affine,
    pub g2_shift: Vec<G2Affine>,
}

/// Verifier-side part of the SRS.
#[derive(Clone)]
pub struct VerifierKey {
    pub smax: usize,
    pub g1_one: G1Affine,
    pub g2_one: G2Affine,
    pub g2_tau: G2Affine,
    pub g2_shift: Vec<G2Affine>,
}

impl VerifierKey {
    /// srsId = keccak256(τG2 ‖ shift[1] ‖ … ‖ shift[smax]) in EVM G2 word order.
    pub fn id(&self) -> Word {
        let mut bytes = Vec::new();
        for w in g2_to_words(&self.g2_tau) {
            bytes.extend_from_slice(&w);
        }
        for p in &self.g2_shift[1..=self.smax] {
            for w in g2_to_words(p) {
                bytes.extend_from_slice(&w);
            }
        }
        keccak(&[&bytes])
    }
}

fn fixed_base_table(base: G1) -> Vec<Vec<G1Affine>> {
    // 32 windows of 8 bits: T[w][d] = d · 2^{8w} · base.
    (0..32)
        .into_par_iter()
        .map(|w| {
            let mut start = base;
            for _ in 0..8 * w {
                start = start.double();
            }
            let mut row = vec![G1::identity(); 256];
            for d in 1..256 {
                row[d] = row[d - 1] + start;
            }
            let mut affine = vec![G1Affine::identity(); 256];
            G1::batch_normalize(&row, &mut affine);
            affine
        })
        .collect()
}

fn fixed_base_mul(table: &[Vec<G1Affine>], s: &F) -> G1 {
    let repr = s.to_repr();
    let bytes = repr.as_ref(); // little-endian
    let mut acc = G1::identity();
    for (w, &b) in bytes.iter().enumerate() {
        if b != 0 {
            acc += table[w][b as usize];
        }
    }
    acc
}

impl Srs {
    /// INSECURE development SRS: τ is derived from `seed` and therefore known.
    pub fn insecure_dev(smax: usize, seed: u64) -> Self {
        let mut rng = rand_chacha::ChaCha20Rng::seed_from_u64(seed);
        let tau = F::random(&mut rng);
        let n = 1usize << smax;
        let chunk = 1 << 14;
        let table = fixed_base_table(G1::generator());
        let mut g1 = vec![G1Affine::identity(); n];
        g1.par_chunks_mut(chunk).enumerate().for_each(|(c, out)| {
            let mut s = tau.pow_vartime([(c * chunk) as u64]);
            let mut proj = Vec::with_capacity(out.len());
            for _ in 0..out.len() {
                proj.push(fixed_base_mul(&table, &s));
                s *= tau;
            }
            G1::batch_normalize(&proj, out);
        });
        let g2 = G2::generator();
        let g2_shift = (0..=smax)
            .map(|a| (g2 * tau.pow_vartime([(n - (1usize << a)) as u64])).to_affine())
            .collect();
        Srs {
            smax,
            g1,
            g2_one: g2.to_affine(),
            g2_tau: (g2 * tau).to_affine(),
            g2_shift,
        }
    }

    /// Loads a public powers-of-tau ceremony file (snarkjs `.ptau`, BN254), e.g. the PSE
    /// Perpetual Powers of Tau. Points are stored little-endian Montgomery, which is the
    /// halo2curves in-memory representation. The result is validated: every point on curve,
    /// generators match, and pairing checks tie the G1 powers to [τ]_2 and every shift point.
    pub fn from_ptau(path: &Path, smax: usize) -> Result<Self> {
        use std::io::{Seek, SeekFrom};
        let mut f =
            std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
        let mut head = [0u8; 12];
        f.read_exact(&mut head)?;
        ensure!(&head[..4] == b"ptau", "not a .ptau file");
        let n_sections = u32::from_le_bytes(head[8..12].try_into().unwrap());
        let mut sections = std::collections::HashMap::new();
        let mut pos = 12u64;
        for _ in 0..n_sections {
            let mut h = [0u8; 12];
            f.seek(SeekFrom::Start(pos))?;
            f.read_exact(&mut h)?;
            let ty = u32::from_le_bytes(h[..4].try_into().unwrap());
            let size = u64::from_le_bytes(h[4..12].try_into().unwrap());
            sections.insert(ty, (pos + 12, size));
            pos += 12 + size;
        }
        let read_at = |f: &mut std::fs::File, off: u64, len: usize| -> Result<Vec<u8>> {
            let mut buf = vec![0u8; len];
            f.seek(SeekFrom::Start(off))?;
            f.read_exact(&mut buf)?;
            Ok(buf)
        };
        let (h_off, _) = *sections.get(&1).context("missing header section")?;
        let header = read_at(&mut f, h_off, 44)?;
        ensure!(
            u32::from_le_bytes(header[..4].try_into().unwrap()) == 32,
            "unexpected field size"
        );
        let q_le: [u8; 32] = header[4..36].try_into().unwrap();
        let mut q_be = q_le;
        q_be.reverse();
        ensure!(
            hex::encode(q_be) == "30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47",
            "not a BN254 ceremony"
        );
        let power = u32::from_le_bytes(header[36..40].try_into().unwrap()) as usize;
        ensure!(
            smax <= power,
            "ceremony power {power} < requested smax {smax}"
        );
        let n = 1usize << smax;
        let (g1_off, _) = *sections.get(&2).context("missing tauG1 section")?;
        let (g2_off, _) = *sections.get(&3).context("missing tauG2 section")?;
        let raw = read_at(&mut f, g1_off, n * 64)?;
        let g1: Vec<G1Affine> = raw
            .par_chunks(64)
            .map(G1Affine::from_raw_bytes_unchecked)
            .collect();
        ensure!(
            g1.par_iter().all(|p| bool::from(p.is_on_curve())),
            "G1 point not on curve"
        );
        let g2_at = |f: &mut std::fs::File, i: usize| -> Result<G2Affine> {
            let b = read_at(f, g2_off + (i as u64) * 128, 128)?;
            G2Affine::from_raw_bytes(&b).context("G2 point not on curve")
        };
        let g2_one = g2_at(&mut f, 0)?;
        let g2_tau = g2_at(&mut f, 1)?;
        let g2_shift = (0..=smax)
            .map(|a| g2_at(&mut f, n - (1usize << a)))
            .collect::<Result<Vec<_>>>()?;
        ensure!(
            g1[0] == G1Affine::generator() && g2_one == G2Affine::generator(),
            "unexpected generators"
        );
        let srs = Srs {
            smax,
            g1,
            g2_one,
            g2_tau,
            g2_shift,
        };
        srs.check_consistency()?;
        Ok(srs)
    }

    /// Pairing checks: e([τ^{i+1}]_1, [1]_2) = e([τ^i]_1, [τ]_2) for sampled i, and
    /// e([τ^k]_1, [1]_2) = e([1]_1, shift) for every stored G2 shift point.
    pub fn check_consistency(&self) -> Result<()> {
        let n = self.g1.len();
        let eq_pairs = |a: &G1Affine, b: &G2Affine, c: &G1Affine, d: &G2Affine| -> bool {
            let neg_c = (-c.to_curve()).to_affine();
            multi_miller_loop(&[(a, b), (&neg_c, d)]).final_exponentiation() == Gt::identity()
        };
        let mut idx = vec![0usize, 1, n / 2, n - 2];
        let mut rng = rand_chacha::ChaCha20Rng::seed_from_u64(0x5eed);
        idx.extend((0..8).map(|_| rand::Rng::gen_range(&mut rng, 0..n - 1)));
        for i in idx {
            ensure!(
                eq_pairs(&self.g1[i + 1], &self.g2_one, &self.g1[i], &self.g2_tau),
                "tau powers inconsistent at {i}"
            );
        }
        for (a, sh) in self.g2_shift.iter().enumerate() {
            ensure!(
                eq_pairs(&self.g1[n - (1usize << a)], &self.g2_one, &self.g1[0], sh),
                "shift point {a} inconsistent"
            );
        }
        Ok(())
    }

    pub fn vk(&self) -> VerifierKey {
        VerifierKey {
            smax: self.smax,
            g1_one: self.g1[0],
            g2_one: self.g2_one,
            g2_tau: self.g2_tau,
            g2_shift: self.g2_shift.clone(),
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let mut w = BufWriter::new(std::fs::File::create(path)?);
        w.write_all(b"MGKRSRS1")?;
        w.write_all(&(self.smax as u32).to_le_bytes())?;
        for p in [&self.g2_one, &self.g2_tau]
            .into_iter()
            .chain(self.g2_shift.iter())
        {
            p.write_raw(&mut w)?;
        }
        for p in &self.g1 {
            p.write_raw(&mut w)?;
        }
        Ok(())
    }

    /// Loads a file written by `save`. Points are trusted local data (no subgroup checks);
    /// a corrupted file can only break completeness, never verifier soundness, because the
    /// verifier uses its own immutable G2 key.
    pub fn load(path: &Path) -> Result<Self> {
        let mut r = BufReader::with_capacity(
            1 << 22,
            std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?,
        );
        let mut magic = [0u8; 8];
        r.read_exact(&mut magic)?;
        ensure!(&magic == b"MGKRSRS1", "not an SRS file");
        let mut b = [0u8; 4];
        r.read_exact(&mut b)?;
        let smax = u32::from_le_bytes(b) as usize;
        ensure!(smax <= 28, "SRS too large");
        let g2_one = G2Affine::read_raw_unchecked(&mut r);
        let g2_tau = G2Affine::read_raw_unchecked(&mut r);
        let g2_shift = (0..=smax)
            .map(|_| G2Affine::read_raw_unchecked(&mut r))
            .collect();
        let n = 1usize << smax;
        let mut raw = vec![0u8; n * 64];
        r.read_exact(&mut raw)?;
        let g1 = raw
            .par_chunks(64)
            .map(G1Affine::from_raw_bytes_unchecked)
            .collect();
        Ok(Srs {
            smax,
            g1,
            g2_one,
            g2_tau,
            g2_shift,
        })
    }

    pub fn commit(&self, values: &[F]) -> G1Affine {
        self.commit_at(values, 0)
    }

    /// Σ_i values[i]·[τ^{offset+i}]_1
    pub fn commit_at(&self, values: &[F], offset: usize) -> G1Affine {
        assert!(offset + values.len() <= self.g1.len(), "SRS too small");
        if values.is_empty() {
            return G1Affine::identity();
        }
        msm_best(values, &self.g1[offset..offset + values.len()]).to_affine()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ZmProof {
    pub q: Vec<G1Affine>,
    pub qhat: G1Affine,
    pub qhat_shift: G1Affine,
    pub pi: G1Affine,
}

/// Quotients q_k (k = 0..n-1, |q_k| = 2^k) with f − f(u) = Σ_k (X_k − u_k) q_k(X_{<k}).
pub fn quotients(f: &[F], u: &[F]) -> (Vec<Vec<F>>, F) {
    let n = u.len();
    assert_eq!(f.len(), 1 << n);
    let mut cur = f.to_vec();
    let mut qs = vec![Vec::new(); n];
    for k in (0..n).rev() {
        let half = 1 << k;
        let (lo, hi) = cur.split_at(half);
        let q: Vec<F> = lo
            .par_iter()
            .zip(hi.par_iter())
            .map(|(a, b)| *b - a)
            .collect();
        let next: Vec<F> = lo
            .par_iter()
            .zip(q.par_iter())
            .map(|(a, qi)| *a + u[k] * qi)
            .collect();
        qs[k] = q;
        cur = next;
    }
    (qs, cur[0])
}

/// x^{2^j} for j = 0..=n.
fn pow2_powers(x: F, n: usize) -> Vec<F> {
    let mut out = Vec::with_capacity(n + 1);
    let mut cur = x;
    for _ in 0..=n {
        out.push(cur);
        cur = cur.square();
    }
    out
}

/// Scalars shared by prover and verifier: per-k coefficient of U(q_k) in ζ + zZ,
/// and the constant term v·Φ_n(x).
fn scalars(u: &[F], v: F, y: F, x: F, z: F) -> Result<(Vec<F>, F)> {
    let n = u.len();
    let xp = pow2_powers(x, n); // xp[j] = x^{2^j}, xp[n] = x^N
    let x_n = xp[n];
    let mut dens: Vec<F> = xp.iter().map(|p| *p - F::ONE).collect(); // x^{2^j} − 1
    dens.push(x);
    if dens.iter().any(|d| bool::from(d.is_zero())) {
        bail!("degenerate Zeromorph challenge");
    }
    let invs: Vec<F> = dens.iter().map(|d| d.invert().unwrap()).collect();
    let x_inv = invs[n + 1];
    let phi_n = (x_n - F::ONE) * invs[0];
    let mut coeffs = Vec::with_capacity(n);
    let mut y_pow = F::ONE;
    let mut x_inv_pow = x_inv; // x^{-2^k}
    for k in 0..n {
        // x^{2^k} Φ_{n−k−1}(x^{2^{k+1}}) − u_k Φ_{n−k}(x^{2^k})
        let c_k = (x_n - F::ONE) * (xp[k] * invs[k + 1] - u[k] * invs[k]);
        coeffs.push(y_pow * x_n * x_inv_pow + z * c_k);
        y_pow *= y;
        x_inv_pow = x_inv_pow.square();
    }
    Ok((coeffs, v * phi_n))
}

pub fn open(srs: &Srs, f: &[F], u: &[F], tr: &mut Transcript) -> ZmProof {
    let n = u.len();
    let big_n = 1usize << n;
    assert!(n <= srs.smax && f.len() == big_n);
    let (qs, v) = quotients(f, u);
    // Small quotient MSMs underuse cores individually; run them concurrently.
    let q_commits: Vec<G1Affine> = qs.par_iter().map(|q| srs.commit(q)).collect();
    tr.absorb_g1(&q_commits);
    let y = tr.squeeze();
    let mut qhat = vec![F::ZERO; big_n];
    let mut y_pow = F::ONE;
    for (k, q) in qs.iter().enumerate() {
        let off = big_n - (1 << k);
        for (i, qi) in q.iter().enumerate() {
            qhat[off + i] += y_pow * qi;
        }
        y_pow *= y;
    }
    // q̂ is zero below N − 2^{n−1}; commit only the nonzero upper half.
    let lo = big_n - (big_n >> 1);
    let (qhat_c, qhat_shift) = rayon::join(
        || srs.commit_at(&qhat[lo..], lo),
        || srs.commit_at(&qhat[lo..], (1usize << srs.smax) - big_n + lo),
    );
    tr.absorb_g1(&[qhat_c, qhat_shift]);
    let x = tr.squeeze();
    let z = tr.squeeze();
    let (coeffs, const_term) = scalars(u, v, y, x, z).expect("degenerate challenge");
    // poly = q̂ + z·f − z·vΦ_n(x) − Σ_k coeffs[k]·U(q_k)
    let mut poly: Vec<F> = qhat
        .par_iter()
        .zip(f.par_iter())
        .map(|(a, b)| *a + z * b)
        .collect();
    poly[0] -= z * const_term;
    for (k, q) in qs.iter().enumerate() {
        for (i, qi) in q.iter().enumerate() {
            poly[i] -= coeffs[k] * qi;
        }
    }
    // Synthetic division by (X − x): π_{i-1} = poly_i + x·π_i from the top.
    let mut pi = vec![F::ZERO; big_n - 1];
    let mut carry = F::ZERO;
    for i in (1..big_n).rev() {
        carry = poly[i] + x * carry;
        pi[i - 1] = carry;
    }
    debug_assert_eq!(poly[0] + x * carry, F::ZERO, "ζ + zZ must vanish at x");
    let pi_c = srs.commit(&pi);
    tr.absorb_g1(&[pi_c]);
    let _rho = tr.squeeze();
    ZmProof {
        q: q_commits,
        qhat: qhat_c,
        qhat_shift,
        pi: pi_c,
    }
}

/// Verifies `commitment` opens to `v` at `u`. Consumes the same transcript steps as `open`.
pub fn verify(
    vk: &VerifierKey,
    commitment: G1Affine,
    u: &[F],
    v: F,
    proof: &ZmProof,
    tr: &mut Transcript,
) -> Result<()> {
    let n = u.len();
    ensure!(n >= 1 && n <= vk.smax, "unsupported number of variables");
    ensure!(proof.q.len() == n, "wrong number of quotient commitments");
    tr.absorb_g1(&proof.q);
    let y = tr.squeeze();
    tr.absorb_g1(&[proof.qhat, proof.qhat_shift]);
    let x = tr.squeeze();
    let z = tr.squeeze();
    tr.absorb_g1(&[proof.pi]);
    let rho = tr.squeeze();
    let (coeffs, const_term) = scalars(u, v, y, x, z)?;
    let mut scalars_v: Vec<F> = coeffs.iter().map(|c| -*c).collect();
    let mut bases: Vec<G1Affine> = proof.q.clone();
    scalars_v.extend([F::ONE, z, -(z * const_term), x, rho]);
    bases.extend([
        proof.qhat,
        commitment,
        vk.g1_one,
        proof.pi,
        proof.qhat_shift,
    ]);
    let lhs = msm_best(&scalars_v, &bases).to_affine();
    let neg_pi = (-proof.pi.to_curve()).to_affine();
    let neg_rho_qhat = (proof.qhat.to_curve() * (-rho)).to_affine();
    let ok = multi_miller_loop(&[
        (&lhs, &vk.g2_one),
        (&neg_pi, &vk.g2_tau),
        (&neg_rho_qhat, &vk.g2_shift[n]),
    ])
    .final_exponentiation()
        == Gt::identity();
    ensure!(ok, "Zeromorph pairing check failed");
    Ok(())
}

/// Word encoding used in calldata: q_0..q_{n-1}, q̂, q̂', π (2 words each).
pub fn proof_words(p: &ZmProof) -> Vec<Word> {
    p.q.iter()
        .chain([&p.qhat, &p.qhat_shift, &p.pi])
        .flat_map(g1_to_words)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mle::mle_eval;

    fn setup() -> Srs {
        Srs::insecure_dev(8, 42)
    }

    #[test]
    fn quotient_identity() {
        let mut rng = rand_chacha::ChaCha20Rng::seed_from_u64(1);
        let n = 5;
        let f: Vec<F> = (0..1 << n).map(|_| F::random(&mut rng)).collect();
        let u: Vec<F> = (0..n).map(|_| F::random(&mut rng)).collect();
        let (_, v) = quotients(&f, &u);
        assert_eq!(v, mle_eval(&f, &u));
    }

    #[test]
    fn open_verify_and_reject() {
        let srs = setup();
        let vk = srs.vk();
        let mut rng = rand_chacha::ChaCha20Rng::seed_from_u64(2);
        for n in [1usize, 2, 5, 8] {
            let f: Vec<F> = (0..1 << n).map(|_| F::random(&mut rng)).collect();
            let u: Vec<F> = (0..n).map(|_| F::random(&mut rng)).collect();
            let v = mle_eval(&f, &u);
            let c = srs.commit(&f);
            let proof = open(&srs, &f, &u, &mut Transcript::new(b"zm"));
            verify(&vk, c, &u, v, &proof, &mut Transcript::new(b"zm")).unwrap();
            assert!(verify(&vk, c, &u, v + F::ONE, &proof, &mut Transcript::new(b"zm")).is_err());
            let mut bad = proof.clone();
            bad.pi = (bad.pi.to_curve() + G1::generator()).to_affine();
            assert!(verify(&vk, c, &u, v, &bad, &mut Transcript::new(b"zm")).is_err());
            let mut bad = proof.clone();
            bad.qhat_shift = (bad.qhat_shift.to_curve() + G1::generator()).to_affine();
            assert!(verify(&vk, c, &u, v, &bad, &mut Transcript::new(b"zm")).is_err());
        }
    }

    #[test]
    fn shorter_vector_is_zero_padded_commitment() {
        let srs = setup();
        let mut rng = rand_chacha::ChaCha20Rng::seed_from_u64(3);
        let f: Vec<F> = (0..8).map(|_| F::random(&mut rng)).collect();
        let mut padded = f.clone();
        padded.resize(32, F::ZERO);
        assert_eq!(srs.commit(&f), srs.commit(&padded));
        let u: Vec<F> = (0..5).map(|_| F::random(&mut rng)).collect();
        let v = mle_eval(&padded, &u);
        let proof = open(&srs, &padded, &u, &mut Transcript::new(b"zm"));
        verify(
            &srs.vk(),
            srs.commit(&f),
            &u,
            v,
            &proof,
            &mut Transcript::new(b"zm"),
        )
        .unwrap();
    }

    #[test]
    fn dev_srs_is_consistent() {
        Srs::insecure_dev(6, 11).check_consistency().unwrap();
        let mut bad = Srs::insecure_dev(6, 11);
        bad.g2_shift[3] = bad.g2_tau;
        assert!(bad.check_consistency().is_err());
    }

    /// Needs a real ceremony file: MGKR_PTAU=/path/to/ppot_0080_12.ptau cargo test --release ptau
    #[test]
    fn loads_public_ptau_when_available() {
        let Ok(path) = std::env::var("MGKR_PTAU") else {
            eprintln!("skipped: set MGKR_PTAU to a BN254 .ptau file");
            return;
        };
        let srs = Srs::from_ptau(Path::new(&path), 11).unwrap();
        let vk = srs.vk();
        let mut rng = rand_chacha::ChaCha20Rng::seed_from_u64(9);
        let f: Vec<F> = (0..1 << 11).map(|_| F::random(&mut rng)).collect();
        let u: Vec<F> = (0..11).map(|_| F::random(&mut rng)).collect();
        let v = crate::mle::mle_eval(&f, &u);
        let proof = open(&srs, &f, &u, &mut Transcript::new(b"zm"));
        verify(
            &vk,
            srs.commit(&f),
            &u,
            v,
            &proof,
            &mut Transcript::new(b"zm"),
        )
        .unwrap();
    }

    #[test]
    fn save_load_roundtrip() {
        let srs = Srs::insecure_dev(4, 7);
        let dir = std::env::temp_dir().join(format!("mgkr-srs-{}", std::process::id()));
        srs.save(&dir).unwrap();
        let back = Srs::load(&dir).unwrap();
        std::fs::remove_file(&dir).ok();
        assert_eq!(back.g1, srs.g1);
        assert_eq!(back.g2_shift, srs.g2_shift);
        assert_eq!(back.vk().id(), srs.vk().id());
    }
}
