# Context

This is a hackathon project for an on-chain osu! rhythm game leaderboard. Each game costs 1 USDC, which funds a shared prize pot. The first-place player takes the entire collected pot.

Players use the web version of osu! with wallet extension support. Players should also be able to pay using a wallet app on their phone: the osu! web app displays a QR code to initiate the payment transaction. The first-place player can later claim the prize using their wallet.

# Components

## osu! web

The core web app for playing the game.

- `Web-Osu-Mania/`: web game application. (Currently used)
- `osu-old/`: legacy osu! application.

## Scoring

We prove the score from osu! gameplay logs using GKR and sumcheck, then verify the proof on-chain.

- `scoring/gkr-scoring/`: GKR scoring, proof generation, and on-chain verification.
- `scoring/sp1-scoring/`: first-version SP1 scoring and proof generation.

## Hardware

We use custom hardware to sign the contract.

- `scoring/gkr-scoring/docs/fpga/`: hardware protocol, integration documentation, and validation vectors. Hardware implementation does not yet have a dedicated subdirectory.

# Coding style

- Speed > quality.
- Robustness > abstraction.
- Agile > perfect.

This is a hackathon project. Prioritize a stable, robust demo over abstraction. Keep implementations straightforward and avoid overengineering for speculative failure scenarios.
