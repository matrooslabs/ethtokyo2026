pragma circom 2.0.4;

// Upstream's evalMultivariate (and evalGateFunction in optimizedGate.circom) computed the
// result with unconstrained `<--` assignments, so the prover could set the input-layer
// evaluation to anything. They are replaced by the fully constrained templates below,
// which work on dense evaluation vectors (MSB-first variable order, as in the prover).

// eq[idx] = prod_j (bit_j(idx) ? x[j] : 1 - x[j]), bit_0 = most significant bit.
template EqTable(k) {
    signal input x[k];
    signal output eq[1 << k];
    signal level[k + 1][1 << k];
    level[0][0] <== 1;
    for (var j = 0; j < k; j++) {
        for (var i = 0; i < (1 << j); i++) {
            level[j + 1][2 * i + 1] <== level[j][i] * x[j];
            level[j + 1][2 * i] <== level[j][i] - level[j + 1][2 * i + 1];
        }
    }
    for (var i = 0; i < (1 << k); i++) {
        eq[i] <== level[k][i];
    }
}

// Multilinear extension of `values` at `x` (MSB-first), by folding.
template MLEEval(k) {
    signal input values[1 << k];
    signal input x[k];
    signal output result;
    signal fold[k + 1][1 << k];
    for (var i = 0; i < (1 << k); i++) {
        fold[0][i] <== values[i];
    }
    for (var j = 0; j < k; j++) {
        var half = (1 << (k - j)) >> 1;
        for (var i = 0; i < half; i++) {
            fold[j + 1][i] <== fold[j][i] + (fold[j][i + half] - fold[j][i]) * x[j];
        }
    }
    result <== fold[k][0];
}
