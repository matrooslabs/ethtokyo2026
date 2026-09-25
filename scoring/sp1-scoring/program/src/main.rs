#![no_main]
sp1_zkvm::entrypoint!(main);

pub fn main() {
    let input = sp1_zkvm::io::read::<mania_scoring_core::PlayInput>();
    let output = mania_scoring_core::evaluate(&input).expect("invalid play witness");
    sp1_zkvm::io::commit_slice(&output.abi_encode());
}
