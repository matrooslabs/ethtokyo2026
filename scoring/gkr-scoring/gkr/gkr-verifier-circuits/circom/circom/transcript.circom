pragma circom 2.0.4;

include "../node_modules/circomlib/circuits/mimc.circom";

// Fiat-Shamir transcript, identical to rust/src/gkr/transcript.rs and python/transcript.py:
//   init:        s = MultiMiMC7([domain], k = 0)
//   absorb(xs):  s = MultiMiMC7([s, len(xs), xs...], k = 0)
//   squeeze():   s = MultiMiMC7([s], k = 1); challenge = s

template TranscriptInit(domain) {
    signal output out;
    component h = MultiMiMC7(1, 91);
    h.in[0] <== domain;
    h.k <== 0;
    out <== h.out;
}

template TranscriptAbsorb(n) {
    signal input state;
    signal input xs[n];
    signal output out;
    component h = MultiMiMC7(n + 2, 91);
    h.in[0] <== state;
    h.in[1] <== n;
    for (var i = 0; i < n; i++) {
        h.in[i + 2] <== xs[i];
    }
    h.k <== 0;
    out <== h.out;
}

template TranscriptSqueeze() {
    signal input state;
    signal output out;
    component h = MultiMiMC7(1, 91);
    h.in[0] <== state;
    h.k <== 1;
    out <== h.out;
}
