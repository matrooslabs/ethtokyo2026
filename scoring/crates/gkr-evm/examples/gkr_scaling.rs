//! Times the data-parallel fractional-sum GKR on binary trees of 2^n leaves, for comparison
//! with gkr/BASELINE.md (fixed upstream generic prover on `tree 2^n`).
use halo2curves::ff::Field;
use mania_gkr::field::F;
use mania_gkr::logup_gkr;
use mania_gkr::transcript::Transcript;
use rand::SeedableRng;
use std::time::Instant;

fn main() {
    let mut rng = rand_chacha::ChaCha20Rng::seed_from_u64(1);
    println!("| leaves | tree nodes | prove ms | verify ms | proof elements |");
    println!("|---:|---:|---:|---:|---:|");
    for n in [10usize, 12, 14, 16, 18, 20, 22] {
        let size = 1usize << n;
        let gamma = F::random(&mut rng);
        let mut p = Vec::with_capacity(size);
        let mut q = Vec::with_capacity(size);
        for i in 0..size / 2 {
            let x = F::from(i as u64);
            p.extend([F::ONE, -F::ONE]);
            q.extend([gamma - x, gamma - x]);
        }
        let t = Instant::now();
        let (proof, _) = logup_gkr::prove(p, q, &mut Transcript::new(b"bench"));
        let prove_ms = t.elapsed().as_secs_f64() * 1e3;
        let t = Instant::now();
        logup_gkr::verify(&proof, n, &mut Transcript::new(b"bench")).unwrap();
        let verify_ms = t.elapsed().as_secs_f64() * 1e3;
        let elems = 4 + proof
            .layers
            .iter()
            .map(|l| 3 * l.rounds.len() + 4)
            .sum::<usize>();
        println!(
            "| 2^{n} | {} | {prove_ms:.1} | {verify_ms:.2} | {elems} |",
            size - 1
        );
    }
}
