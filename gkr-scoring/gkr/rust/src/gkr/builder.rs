//! Builds `GKRCircuit`/`Input` values directly from layered gate lists (without circom),
//! using the same encodings as `convert.rs`. Used by tests and the baseline benchmark.
use super::{poly::*, GKRCircuit, Input, Layer};
use ff::PrimeField;

#[derive(Clone, Copy, Debug)]
pub enum Gate {
    Add(usize, usize),
    Mult(usize, usize),
}

/// `layers[0]` is the output layer; gate operands index into the next layer
/// (`layers[i + 1]`, or the input for the last layer).
#[derive(Clone, Debug)]
pub struct LayeredCircuit {
    pub layers: Vec<Vec<Gate>>,
    pub input_size: usize,
}

pub fn log2_ceil(n: usize) -> usize {
    let mut k = 0;
    while (1usize << k) < n {
        k += 1;
    }
    k
}

fn bits(value: usize, k: usize) -> String {
    if k == 0 {
        String::new()
    } else {
        format!("{:0k$b}", value, k = k)
    }
}

impl LayeredCircuit {
    fn k(&self, i: usize) -> usize {
        if i == self.layers.len() {
            log2_ceil(self.input_size)
        } else {
            log2_ceil(self.layers[i].len())
        }
    }

    pub fn to_gkr<S: PrimeField + std::hash::Hash>(&self) -> GKRCircuit<S> {
        let mut layers = vec![];
        for (i, gates) in self.layers.iter().enumerate() {
            let (k_i, k_next) = (self.k(i), self.k(i + 1));
            let v = k_i + 2 * k_next;
            let mut add_strings = vec![];
            let mut mult_strings = vec![];
            for (curr, gate) in gates.iter().enumerate() {
                let (l, r, target) = match gate {
                    Gate::Add(l, r) => (*l, *r, &mut add_strings),
                    Gate::Mult(l, r) => (*l, *r, &mut mult_strings),
                };
                target.push(format!("{}{}{}", bits(curr, k_i), bits(l, k_next), bits(r, k_next)));
            }
            let to_vec = |s: &String| -> Vec<S> {
                s.chars().map(|c| if c == '1' { S::ONE } else { S::ZERO }).collect()
            };
            let to_poly = |strings: &Vec<String>| -> Vec<Vec<S>> {
                let mut acc = get_empty::<S>(v);
                for s in strings {
                    acc = add_poly(&acc, &chi_w_for_binary::<S>(s));
                }
                if acc.is_empty() {
                    get_empty::<S>(v)
                } else {
                    acc
                }
            };
            let wire = (
                add_strings.iter().map(to_vec).collect(),
                mult_strings.iter().map(to_vec).collect(),
            );
            layers.push(Layer::new(k_i, to_poly(&add_strings), to_poly(&mult_strings), wire));
        }
        GKRCircuit::new(layers, self.k(self.layers.len()))
    }

    /// Values of every layer (padded to 2^k_i with zeros); index 0 is the output layer.
    pub fn evaluate<S: PrimeField>(&self, input: &[S]) -> Vec<Vec<S>> {
        let mut current = input.to_vec();
        current.resize(1 << self.k(self.layers.len()), S::ZERO);
        let mut values = vec![current.clone()];
        for (i, gates) in self.layers.iter().enumerate().rev() {
            let mut next: Vec<S> = gates
                .iter()
                .map(|g| match g {
                    Gate::Add(l, r) => current[*l] + current[*r],
                    Gate::Mult(l, r) => current[*l] * current[*r],
                })
                .collect();
            next.resize(1 << self.k(i), S::ZERO);
            values.push(next.clone());
            current = next;
        }
        values.reverse();
        values
    }

    /// Prover witness in the upstream (monomial) representation.
    pub fn witness<S: PrimeField + std::hash::Hash>(&self, input: &[S]) -> Input<S> {
        let values = self.evaluate(input);
        let w: Vec<Vec<Vec<S>>> = values
            .iter()
            .enumerate()
            .map(|(i, v)| get_multi_ext(v, self.k(i)))
            .collect();
        Input {
            d: w[0].clone(),
            w,
            output_values: values[0].clone(),
            input_values: values[values.len() - 1].clone(),
        }
    }
}
