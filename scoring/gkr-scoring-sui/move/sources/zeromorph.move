/// Zeromorph multilinear opening over KZG/BLS12-381 with the q̂ degree check (SPEC §7.6;
/// engine `zeromorph::verify`).
module mania_gkr::zeromorph;

use mania_gkr::fr::{Self, one};
use mania_gkr::reader::{Self, Reader};
use mania_gkr::transcript::{Self, Transcript};
use sui::bls12381::{Self, Scalar, G1, G2};
use sui::group_ops::{Self, Element};
use sui::hash::keccak256;

use fun fr::add as Element.add;
use fun fr::sub as Element.sub;
use fun fr::mul as Element.mul;

const EVars: u64 = 1;
const EDegenerate: u64 = 2;
const EPairing: u64 = 3;
const EVerifierKey: u64 = 4;

/// [1]_2, [τ]_2 and shift[n] = [τ^{2^smax − 2^n}]_2 for n ≤ smax; `id` is the srsId.
public struct VerifierKey has copy, drop, store {
    smax: u64,
    g2_tau: Element<G2>,
    g2_shift: vector<Element<G2>>,
    id: vector<u8>,
}

/// srsId = keccak256(τG2 ‖ shift[1] ‖ … ‖ shift[smax]) over 96-byte compressed points.
public fun new_vk(g2_tau: vector<u8>, g2_shift: vector<vector<u8>>): VerifierKey {
    let smax = g2_shift.length() - 1;
    assert!(smax >= 1 && smax <= 28, EVerifierKey);
    let mut id_bytes = g2_tau;
    let mut i = 1;
    while (i <= smax) {
        id_bytes.append(g2_shift[i]);
        i = i + 1;
    };
    VerifierKey {
        smax,
        g2_tau: bls12381::g2_from_bytes(&g2_tau),
        g2_shift: g2_shift.map_ref!(|b| bls12381::g2_from_bytes(b)),
        id: keccak256(&id_bytes),
    }
}

public fun smax(vk: &VerifierKey): u64 { vk.smax }

public fun id(vk: &VerifierKey): vector<u8> { vk.id }

/// Per-k coefficients of U(q_k) in ζ + zZ and the constant v·Φ_n(x).
fun scalars(
    u: &vector<Element<Scalar>>,
    v: &Element<Scalar>,
    y: &Element<Scalar>,
    x: &Element<Scalar>,
    z: &Element<Scalar>,
): (vector<Element<Scalar>>, Element<Scalar>) {
    let n = u.length();
    let one = one();
    // xp[j] = x^{2^j}, j = 0..=n
    let mut xp = vector[*x];
    let mut j = 0;
    while (j < n) {
        let sq = xp[j].mul(&xp[j]);
        xp.push_back(sq);
        j = j + 1;
    };
    let x_n = xp[n];
    let mut invs = vector[];
    j = 0;
    while (j <= n) {
        let d = xp[j].sub(&one);
        assert!(!fr::is_zero(&d), EDegenerate);
        invs.push_back(fr::inv(&d));
        j = j + 1;
    };
    assert!(!fr::is_zero(x), EDegenerate);
    let x_inv = fr::inv(x);
    let xn1 = x_n.sub(&one);
    let phi_n = xn1.mul(&invs[0]);
    let mut coeffs = vector[];
    let mut y_pow = one;
    let mut x_inv_pow = x_inv;
    let mut k = 0;
    while (k < n) {
        // x^{2^k} Φ_{n−k−1}(x^{2^{k+1}}) − u_k Φ_{n−k}(x^{2^k})
        let c_k = xn1.mul(&xp[k].mul(&invs[k + 1]).sub(&u[k].mul(&invs[k])));
        coeffs.push_back(y_pow.mul(&x_n).mul(&x_inv_pow).add(&z.mul(&c_k)));
        y_pow = y_pow.mul(y);
        x_inv_pow = x_inv_pow.mul(&x_inv_pow);
        k = k + 1;
    };
    (coeffs, v.mul(&phi_n))
}

/// Verifies that `commitment` opens to `v` at `u`, reading the proof from `r`.
public fun verify(
    vk: &VerifierKey,
    commitment: &Element<G1>,
    u: &vector<Element<Scalar>>,
    v: &Element<Scalar>,
    r: &mut Reader,
    tr: &mut Transcript,
) {
    let n = u.length();
    assert!(n >= 1 && n <= vk.smax, EVars);
    let mut qs = vector[];
    let mut items = vector[];
    let mut k = 0;
    while (k < n) {
        let (q, b) = reader::g1(r);
        qs.push_back(q);
        items.push_back(b);
        k = k + 1;
    };
    transcript::absorb(tr, items);
    let y = transcript::squeeze(tr);
    let (qhat, b1) = reader::g1(r);
    let (qhat_shift, b2) = reader::g1(r);
    transcript::absorb(tr, vector[b1, b2]);
    let x = transcript::squeeze(tr);
    let z = transcript::squeeze(tr);
    let (pi, b) = reader::g1(r);
    transcript::absorb(tr, vector[b]);
    let rho = transcript::squeeze(tr);
    let (coeffs, const_term) = scalars(u, v, &y, &x, &z);
    // C + xπ + ρq̂' with C = q̂ + z·f − z·vΦ_n(x)·[1] − Σ coeffs_k·[q_k]
    let mut sc = coeffs.map_ref!(|c| fr::neg(c));
    sc.append(vector[one(), z, fr::neg(&z.mul(&const_term)), x, rho]);
    qs.append(vector[qhat, *commitment, bls12381::g1_generator(), pi, qhat_shift]);
    // Σ sc_i·P_i with single multiplications: the MSM native is enabled only on devnet/localnet
    // (`enable_group_ops_native_function_msm` is off on testnet and mainnet).
    let mut lhs = bls12381::g1_identity();
    let mut i = 0;
    while (i < sc.length()) {
        lhs = bls12381::g1_add(&lhs, &bls12381::g1_mul(&sc[i], &qs[i]));
        i = i + 1;
    };
    let neg_pi = bls12381::g1_neg(&pi);
    let neg_rho_qhat = bls12381::g1_mul(&fr::neg(&rho), &qhat);
    let e = bls12381::gt_add(
        &bls12381::gt_add(
            &bls12381::pairing(&lhs, &bls12381::g2_generator()),
            &bls12381::pairing(&neg_pi, &vk.g2_tau),
        ),
        &bls12381::pairing(&neg_rho_qhat, &vk.g2_shift[n]),
    );
    assert!(group_ops::equal(&e, &bls12381::gt_identity()), EPairing);
}
