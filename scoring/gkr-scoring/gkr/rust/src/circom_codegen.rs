//! Generates a circom verifier specialized to one GKR circuit.
//!
//! Upstream used a single generic `VerifyGKR(meta)` template whose challenges, points,
//! output polynomial, input polynomial and final-layer values were all free prover
//! inputs. The generated template instead:
//! - pins fixed (constant) input positions and the claimed output as constants,
//! - recomputes every challenge with the MiMC transcript (same schedule as
//!   `gkr::prover::prove` / `gkr::verifier::verify`), including z0,
//! - enforces exactly 3 coefficients per round and k+1 for q (degree bounds),
//! - checks every layer's sumcheck end value against add~/mult~ of the compile-time
//!   wiring, and
//! - evaluates the input MLE with constrained arithmetic.
//!
//! Library templates come from `gkr-verifier-circuits/circom/circom/verifier.circom`.
use crate::gkr::{
    transcript::{MimcTranscript, DOMAIN_PROOF},
    GKRCircuit, GkrError, Proof,
};
use ff::{Field, PrimeField};
use halo2curves::bn256::Fr;
use std::fmt::Write;

/// Decimal string of a field element.
pub fn fr_to_decimal(x: &Fr) -> String {
    let repr = x.to_repr();
    // little-endian bytes -> big-endian u32 limbs
    let mut limbs: Vec<u32> = repr
        .as_ref()
        .chunks(4)
        .rev()
        .map(|c| u32::from_le_bytes(c.try_into().unwrap()))
        .collect();
    let mut digits = vec![];
    while limbs.iter().any(|l| *l != 0) {
        let mut rem = 0u64;
        for limb in limbs.iter_mut() {
            let cur = (rem << 32) | *limb as u64;
            *limb = (cur / 10) as u32;
            rem = cur % 10;
        }
        digits.push(b'0' + rem as u8);
    }
    if digits.is_empty() {
        return "0".into();
    }
    digits.reverse();
    String::from_utf8(digits).unwrap()
}

/// Circom source of `template <name>()` verifying `circuit` with claimed `output`
/// (length <= 2^{k_0}; missing entries are zero, which is what R1CS-derived circuits use).
///
/// Inputs of the template: `inputValues[2^{k_d}]`, `rounds<i>[2 k_{i+1}][3]`,
/// `q<i>[k_{i+1} + 1]` for every layer i.
pub fn gkr_verifier_template(
    circuit: &GKRCircuit<Fr>,
    output: &[Fr],
    name: &str,
) -> Result<String, GkrError> {
    circuit.validate()?;
    let depth = circuit.depth();
    let k0 = circuit.k(0);
    let kd = circuit.k(depth);
    if output.len() > 1 << k0 {
        return Err(GkrError::BadPublicIo("output longer than output layer"));
    }
    let mut out_vals = output.to_vec();
    out_vals.resize(1 << k0, Fr::ZERO);
    let digest = circuit.digest::<MimcTranscript>();

    let mut s = String::new();
    let w = &mut s;
    writeln!(w, "template {name}() {{").unwrap();
    writeln!(w, "    signal input inputValues[{}];", 1 << kd).unwrap();
    for i in 0..depth {
        let k = circuit.k(i + 1);
        writeln!(w, "    signal input rounds{i}[{}][3];", 2 * k).unwrap();
        writeln!(w, "    signal input q{i}[{}];", k + 1).unwrap();
    }
    writeln!(w, "\n    // constant input positions (R1CS coefficients etc.) are part of the circuit").unwrap();
    for (pos, v) in &circuit.fixed_inputs {
        writeln!(w, "    inputValues[{pos}] === {};", fr_to_decimal(v)).unwrap();
    }

    writeln!(w, "\n    // statement: circuit digest, input, output").unwrap();
    writeln!(w, "    component tInit = TranscriptInit({});", DOMAIN_PROOF).unwrap();
    writeln!(w, "    component tDigest = TranscriptAbsorb(1);").unwrap();
    writeln!(w, "    tDigest.state <== tInit.out;").unwrap();
    writeln!(w, "    tDigest.xs[0] <== {};", fr_to_decimal(&digest)).unwrap();
    writeln!(w, "    component tInput = TranscriptAbsorb({});", 1 << kd).unwrap();
    writeln!(w, "    tInput.state <== tDigest.out;").unwrap();
    writeln!(w, "    for (var i = 0; i < {}; i++) {{ tInput.xs[i] <== inputValues[i]; }}", 1 << kd).unwrap();
    writeln!(w, "    component tOutput = TranscriptAbsorb({});", 1 << k0).unwrap();
    writeln!(w, "    tOutput.state <== tInput.out;").unwrap();
    for (j, v) in out_vals.iter().enumerate() {
        writeln!(w, "    tOutput.xs[{j}] <== {};", fr_to_decimal(v)).unwrap();
    }
    let mut state = "tOutput.out".to_string();

    // z0 and initial claim D~(z0)
    if k0 > 0 {
        writeln!(w, "    signal z0[{k0}];").unwrap();
        writeln!(w, "    component z0Squeeze[{k0}];").unwrap();
        for j in 0..k0 {
            writeln!(w, "    z0Squeeze[{j}] = TranscriptSqueeze();").unwrap();
            writeln!(w, "    z0Squeeze[{j}].state <== {state};").unwrap();
            writeln!(w, "    z0[{j}] <== z0Squeeze[{j}].out;").unwrap();
            state = format!("z0Squeeze[{j}].out");
        }
        writeln!(w, "    component outputEval = MLEEval({k0});").unwrap();
        for (j, v) in out_vals.iter().enumerate() {
            writeln!(w, "    outputEval.values[{j}] <== {};", fr_to_decimal(v)).unwrap();
        }
        writeln!(w, "    for (var j = 0; j < {k0}; j++) {{ outputEval.x[j] <== z0[j]; }}").unwrap();
    }
    let mut claim = if k0 > 0 {
        "outputEval.result".to_string()
    } else {
        fr_to_decimal(&out_vals[0])
    };

    for i in 0..depth {
        let kz = circuit.k(i);
        let k = circuit.k(i + 1);
        let v = 2 * k;
        writeln!(w, "\n    // ---- layer {i}: sumcheck over {v} variables").unwrap();
        writeln!(w, "    component sc{i}[{v}];").unwrap();
        for j in 0..v {
            writeln!(w, "    sc{i}[{j}] = SumcheckRound();").unwrap();
            writeln!(w, "    sc{i}[{j}].claim <== {claim};").unwrap();
            writeln!(w, "    sc{i}[{j}].stateIn <== {state};").unwrap();
            writeln!(w, "    for (var t = 0; t < 3; t++) {{ sc{i}[{j}].g[t] <== rounds{i}[{j}][t]; }}").unwrap();
            claim = format!("sc{i}[{j}].next");
            state = format!("sc{i}[{j}].stateOut");
        }
        // eq tables for z (previous point), b* and c*
        if kz > 0 {
            writeln!(w, "    component eqZ{i} = EqTable({kz});").unwrap();
            writeln!(w, "    for (var j = 0; j < {kz}; j++) {{ eqZ{i}.x[j] <== z{i}[j]; }}").unwrap();
        }
        writeln!(w, "    component eqB{i} = EqTable({k});").unwrap();
        writeln!(w, "    component eqC{i} = EqTable({k});").unwrap();
        writeln!(w, "    for (var j = 0; j < {k}; j++) {{ eqB{i}.x[j] <== sc{i}[j].r; eqC{i}.x[j] <== sc{i}[{k} + j].r; }}").unwrap();
        let (add, mult) = circuit.gates(i);
        for (label, gates) in [("add", &add), ("mult", &mult)] {
            if gates.is_empty() {
                writeln!(w, "    signal {label}Eval{i};").unwrap();
                writeln!(w, "    {label}Eval{i} <== 0;").unwrap();
                continue;
            }
            writeln!(w, "    signal {label}T{i}[{}];", gates.len()).unwrap();
            writeln!(w, "    signal {label}U{i}[{}];", gates.len()).unwrap();
            let mut sum = String::new();
            for (g, (gz, gb, gc)) in gates.iter().enumerate() {
                let ez = if kz > 0 { format!("eqZ{i}.eq[{gz}]") } else { "1".into() };
                writeln!(w, "    {label}T{i}[{g}] <== {ez} * eqB{i}.eq[{gb}];").unwrap();
                writeln!(w, "    {label}U{i}[{g}] <== {label}T{i}[{g}] * eqC{i}.eq[{gc}];").unwrap();
                if g > 0 {
                    sum.push_str(" + ");
                }
                write!(sum, "{label}U{i}[{g}]").unwrap();
            }
            writeln!(w, "    signal {label}Eval{i};").unwrap();
            writeln!(w, "    {label}Eval{i} <== {sum};").unwrap();
        }
        // q_i(0) = q[k], q_i(1) = sum(q)
        let q_one: Vec<String> = (0..=k).map(|t| format!("q{i}[{t}]")).collect();
        let q_one = q_one.join(" + ");
        writeln!(w, "    signal qProd{i};").unwrap();
        writeln!(w, "    qProd{i} <== q{i}[{k}] * ({q_one});").unwrap();
        writeln!(w, "    signal addSide{i};").unwrap();
        writeln!(w, "    addSide{i} <== addEval{i} * (q{i}[{k}] + {q_one});").unwrap();
        writeln!(w, "    signal multSide{i};").unwrap();
        writeln!(w, "    multSide{i} <== multEval{i} * qProd{i};").unwrap();
        writeln!(w, "    addSide{i} + multSide{i} === {claim};").unwrap();
        writeln!(w, "    component tq{i} = TranscriptAbsorb({});", k + 1).unwrap();
        writeln!(w, "    tq{i}.state <== {state};").unwrap();
        writeln!(w, "    for (var t = 0; t < {}; t++) {{ tq{i}.xs[t] <== q{i}[t]; }}", k + 1).unwrap();
        writeln!(w, "    component rStar{i} = TranscriptSqueeze();").unwrap();
        writeln!(w, "    rStar{i}.state <== tq{i}.out;").unwrap();
        writeln!(w, "    component qEval{i} = evalUnivariate({});", k + 1).unwrap();
        writeln!(w, "    for (var t = 0; t < {}; t++) {{ qEval{i}.coeffs[t] <== q{i}[t]; }}", k + 1).unwrap();
        writeln!(w, "    qEval{i}.x <== rStar{i}.out;").unwrap();
        let n = i + 1;
        writeln!(w, "    signal z{n}[{k}];").unwrap();
        writeln!(w, "    for (var j = 0; j < {k}; j++) {{ z{n}[j] <== sc{i}[j].r + rStar{i}.out * (sc{i}[{k} + j].r - sc{i}[j].r); }}").unwrap();
        claim = format!("qEval{i}.result");
        state = format!("rStar{i}.out");
    }
    writeln!(w, "\n    // input layer").unwrap();
    writeln!(w, "    component inputEval = MLEEval({kd});").unwrap();
    writeln!(w, "    for (var i = 0; i < {}; i++) {{ inputEval.values[i] <== inputValues[i]; }}", 1 << kd).unwrap();
    writeln!(w, "    for (var j = 0; j < {kd}; j++) {{ inputEval.x[j] <== z{depth}[j]; }}").unwrap();
    writeln!(w, "    inputEval.result === {claim};").unwrap();
    writeln!(w, "}}").unwrap();
    Ok(s)
}

/// Named template inputs (JSON array literals of decimal strings) for a proof, with every
/// name prefixed by `prefix` and suffixed by `suffix` (e.g. "gkrRounds" + "3" + "_0").
pub struct VerifierInputs {
    pub input_values: String,
    pub rounds: Vec<String>,
    pub q: Vec<String>,
}

fn json_array(xs: &[Fr]) -> String {
    let items: Vec<String> = xs.iter().map(|x| format!("\"{}\"", fr_to_decimal(x))).collect();
    format!("[{}]", items.join(","))
}

pub fn gkr_verifier_inputs(
    circuit: &GKRCircuit<Fr>,
    input_values: &[Fr],
    proof: &Proof<Fr>,
) -> Result<VerifierInputs, GkrError> {
    let kd = circuit.k(circuit.depth());
    if input_values.len() > 1 << kd {
        return Err(GkrError::BadPublicIo("input longer than input layer"));
    }
    let mut padded = input_values.to_vec();
    padded.resize(1 << kd, Fr::ZERO);
    let rounds = proof
        .sumcheck_proofs
        .iter()
        .map(|layer| {
            let items: Vec<String> = layer.iter().map(|g| json_array(g)).collect();
            format!("[{}]", items.join(","))
        })
        .collect();
    Ok(VerifierInputs {
        input_values: json_array(&padded),
        rounds,
        q: proof.q.iter().map(|q| json_array(q)).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::fr_to_decimal;
    use ff::Field;
    use halo2curves::bn256::Fr;

    #[test]
    fn decimal() {
        assert_eq!(fr_to_decimal(&Fr::ZERO), "0");
        assert_eq!(fr_to_decimal(&Fr::from(1234567890123u64)), "1234567890123");
        assert_eq!(
            fr_to_decimal(&(-Fr::ONE)),
            "21888242871839275222246405745257275088548364400416034343698204186575808495616"
        );
    }
}
