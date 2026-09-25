use mania_scoring_core::{evaluate, PlayInput};
use std::{env, fs, time::Instant};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let path = args
        .next()
        .ok_or("usage: mania-scoring-cli INPUT.json [OUTPUT.json]")?;
    let input: PlayInput = serde_json::from_slice(&fs::read(path)?)?;
    let start = Instant::now();
    let output = evaluate(&input).map_err(std::io::Error::other)?;
    let elapsed = start.elapsed();
    let json = serde_json::json!({
        "result": output,
        "publicValues": format!("0x{}", hex::encode(output.abi_encode())),
        "nativeMicros": elapsed.as_micros(),
        "notes": input.chart.notes.len(),
        "events": input.events.len(),
        "proofGenerated": false,
    });
    let text = serde_json::to_string_pretty(&json)?;
    if let Some(path) = args.next() {
        fs::write(path, &text)?;
    }
    println!("{text}");
    Ok(())
}
