pub mod builder;
pub mod poly;
pub mod prover;
pub mod sumcheck;
pub mod transcript;
pub mod verifier;

use ff::PrimeField;
use std::fmt;

use transcript::{Transcript, DOMAIN_CIRCUIT};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GkrError {
    /// The circuit shape is not supported (empty circuit, a layer with a single gate, ...).
    UnsupportedCircuit(&'static str),
    /// The proof does not have the shape required by the verifier-side circuit.
    MalformedProof(&'static str),
    /// A sumcheck or layer consistency check failed.
    Rejected(&'static str),
    /// Public input/output does not fit the circuit.
    BadPublicIo(&'static str),
}

impl fmt::Display for GkrError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}", self)
    }
}

impl std::error::Error for GkrError {}

/// GKR proof.
///
/// Only `sumcheck_proofs` (exactly 2*k_{i+1} round polynomials per layer, each exactly
/// 3 coefficients, highest degree first) and `q` (exactly k_{i+1}+1 coefficients) are
/// read by the verifier. All other fields are prover-side debug hints kept for the
/// upstream circom input format; verifiers recompute them and never trust them.
#[derive(Clone, Debug)]
pub struct Proof<S: PrimeField> {
    pub sumcheck_proofs: Vec<Vec<Vec<S>>>,
    pub sumcheck_r: Vec<Vec<S>>,
    pub d: Vec<Vec<S>>,
    pub q: Vec<Vec<S>>,
    pub z: Vec<Vec<S>>,
    pub r: Vec<S>,

    pub depth: usize,
    pub input_func: Vec<Vec<S>>,
    pub k: Vec<usize>,
}

pub struct Input<S: PrimeField> {
    // w[i] is function that gets index and returns value of each gate.
    // polynomial form
    pub w: Vec<Vec<Vec<S>>>,
    // d is output of circuit
    pub d: Vec<Vec<S>>,
    /// Values of the output layer (public output D), length 2^{k_0}.
    pub output_values: Vec<S>,
    /// Values of the input layer, length 2^{k_depth}.
    pub input_values: Vec<S>,
}

impl<S: PrimeField> Input<S> {
    pub fn w(&self, i: usize) -> Vec<Vec<S>> {
        self.w[i].clone()
    }
}

pub struct Layer<S: PrimeField> {
    pub k: usize,
    pub add: Vec<Vec<S>>,
    pub mult: Vec<Vec<S>>,
    pub wire: (Vec<Vec<S>>, Vec<Vec<S>>),
}

impl<S: PrimeField> Layer<S> {
    pub fn new(
        k: usize,
        add: Vec<Vec<S>>,
        mult: Vec<Vec<S>>,
        wire: (Vec<Vec<S>>, Vec<Vec<S>>),
    ) -> Self {
        Layer { k, add, mult, wire }
    }
}

pub struct GKRCircuit<S: PrimeField> {
    pub layer: Vec<Layer<S>>,
    input_k: usize,
    /// Input-layer positions that hold circuit constants (e.g. R1CS coefficients placed in
    /// the input layer by `convert.rs`). When the input layer is a private witness (circom
    /// aggregation), the verifier must pin these, otherwise the prover can change the
    /// constraints being checked. Part of the circuit digest.
    pub fixed_inputs: Vec<(usize, S)>,
}

impl<S: PrimeField> GKRCircuit<S> {
    pub fn new(layer: Vec<Layer<S>>, input_k: usize) -> Self {
        GKRCircuit {
            layer,
            input_k,
            fixed_inputs: vec![],
        }
    }

    pub fn with_fixed_inputs(mut self, fixed_inputs: Vec<(usize, S)>) -> Self {
        self.fixed_inputs = fixed_inputs;
        self
    }

    pub fn depth(&self) -> usize {
        self.layer.len()
    }

    pub fn add(&self, i: usize) -> Vec<Vec<S>> {
        self.layer[i].add.clone()
    }

    pub fn add_wire(&self, i: usize) -> Vec<Vec<S>> {
        self.layer[i].wire.0.clone()
    }

    pub fn mult(&self, i: usize) -> Vec<Vec<S>> {
        self.layer[i].mult.clone()
    }

    pub fn mult_wire(&self, i: usize) -> Vec<Vec<S>> {
        self.layer[i].wire.1.clone()
    }

    pub fn k(&self, i: usize) -> usize {
        if i == self.layer.len() {
            return self.input_k;
        }
        self.layer[i].k
    }

    pub fn get_k_list(&self) -> Vec<usize> {
        let mut ks = vec![];
        for i in 0..self.depth() {
            ks.push(self.k(i));
        }
        ks.push(self.input_k);
        ks
    }

    pub fn get_add_list(&self) -> Vec<Vec<Vec<S>>> {
        let mut adds = vec![];
        for i in 0..self.depth() {
            adds.push(self.add(i));
        }
        adds
    }

    /// Decodes the gate triples (z, b, c) of layer i from the binary wiring lists.
    /// Returns (add gates, mult gates).
    pub fn gates(&self, i: usize) -> (Vec<(usize, usize, usize)>, Vec<(usize, usize, usize)>) {
        let (kz, kn) = (self.k(i), self.k(i + 1));
        let decode = |bits: &Vec<S>| -> (usize, usize, usize) {
            let mut idx = [0usize; 3];
            for (pos, bit) in bits.iter().enumerate() {
                let slot = if pos < kz { 0 } else if pos < kz + kn { 1 } else { 2 };
                idx[slot] = (idx[slot] << 1) | usize::from(*bit == S::ONE);
            }
            (idx[0], idx[1], idx[2])
        };
        (
            self.layer[i].wire.0.iter().map(decode).collect(),
            self.layer[i].wire.1.iter().map(decode).collect(),
        )
    }

    /// Checks the verifier-side circuit description is well-formed and supported.
    pub fn validate(&self) -> Result<(), GkrError> {
        if self.layer.is_empty() {
            return Err(GkrError::UnsupportedCircuit("circuit has no layers"));
        }
        if self.fixed_inputs.iter().any(|(pos, _)| *pos >= 1usize << self.input_k) {
            return Err(GkrError::UnsupportedCircuit("fixed input outside the input layer"));
        }
        for i in 0..self.depth() {
            if self.k(i + 1) == 0 {
                return Err(GkrError::UnsupportedCircuit("layers below the output need >= 2 gates"));
            }
            if self.k(i) > 40 || self.k(i + 1) > 40 {
                return Err(GkrError::UnsupportedCircuit("layer too large"));
            }
            let width = self.k(i) + 2 * self.k(i + 1);
            for bits in self.layer[i].wire.0.iter().chain(self.layer[i].wire.1.iter()) {
                if bits.len() != width || bits.iter().any(|b| *b != S::ZERO && *b != S::ONE) {
                    return Err(GkrError::UnsupportedCircuit("malformed wiring"));
                }
            }
        }
        Ok(())
    }

    /// Transcript-bound digest of the circuit: depth, all k_i and every add/mult gate.
    pub fn digest<T: Transcript<S>>(&self) -> S {
        let mut t = T::new(DOMAIN_CIRCUIT);
        let mut shape = vec![S::from(self.depth() as u64)];
        shape.extend(self.get_k_list().iter().map(|k| S::from(*k as u64)));
        t.absorb(&shape);
        for i in 0..self.depth() {
            let (add, mult) = self.gates(i);
            for gates in [add, mult] {
                let mut flat = Vec::with_capacity(3 * gates.len());
                for (z, b, c) in gates {
                    flat.extend([S::from(z as u64), S::from(b as u64), S::from(c as u64)]);
                }
                t.absorb(&flat);
            }
        }
        let fixed: Vec<S> = self
            .fixed_inputs
            .iter()
            .flat_map(|(pos, v)| [S::from(*pos as u64), *v])
            .collect();
        t.absorb(&fixed);
        t.squeeze()
    }

    pub fn get_mult_list(&self) -> Vec<Vec<Vec<S>>> {
        let mut mults = vec![];
        for i in 0..self.depth() {
            mults.push(self.mult(i));
        }
        mults
    }
}
