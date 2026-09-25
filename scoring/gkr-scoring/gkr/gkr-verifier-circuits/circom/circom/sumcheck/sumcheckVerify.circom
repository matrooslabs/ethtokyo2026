pragma circom 2.0.4;
include "../poly/univariate.circom";
include "../transcript.circom";

// One round of the GKR sumcheck. Upstream took the round challenges as free prover
// inputs, did not bound the degree (nTerms = max over all proofs) and never used the
// final evaluation. Here: exactly 3 coefficients (degree <= 2, highest first),
// g(0) + g(1) === claim, the round polynomial is absorbed into the running transcript
// and the challenge r is squeezed from it; next = g(r).
template SumcheckRound() {
    signal input claim;
    signal input g[3];
    signal input stateIn;
    signal output next;
    signal output r;
    signal output stateOut;

    // g(0) = g[2], g(1) = g[0] + g[1] + g[2]
    2 * g[2] + g[1] + g[0] === claim;

    component absorb = TranscriptAbsorb(3);
    absorb.state <== stateIn;
    for (var i = 0; i < 3; i++) {
        absorb.xs[i] <== g[i];
    }
    component squeeze = TranscriptSqueeze();
    squeeze.state <== absorb.out;
    r <== squeeze.out;
    stateOut <== squeeze.out;

    component eval = evalUnivariate(3);
    for (var i = 0; i < 3; i++) {
        eval.coeffs[i] <== g[i];
    }
    eval.x <== r;
    next <== eval.result;
}
