pragma circom 2.0.4;
include "./upstream-circom/verifier.circom";
// meta: d=3, largest_k=2, k0=1, #D terms=1, round terms=3, q terms=3, #inputFunc terms=1, k_{d-1}=2, ks=[1,2,2]
component main = VerifyGKR([3, 2, 1, 1, 3, 3, 1, 2, 1, 2, 2]);
