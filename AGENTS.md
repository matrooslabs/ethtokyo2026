# Context

This is a hackathon project for an on-chain osu! rhythm game leaderboard. Each game costs 1 USDC, which funds a shared prize pot. The first-place player takes the entire collected pot.

Players use the web version of osu! with wallet extension support. Players should also be able to pay using a wallet app on their phone: the osu! web app displays a QR code to initiate the payment transaction. The first-place player can later claim the prize using their wallet.

# Components

## osu! web

The core web app for playing the game.

## Scoring

We prove the score from osu! gameplay logs using GKR and sumcheck, then verify the proof on-chain.

## Hardware

We use custom hardware to sign the contract.

# Coding style

- Speed > quality.
- Robustness > abstraction.
- Agile > perfect.

This is a hackathon project. Prioritize a stable, robust demo over abstraction. Keep implementations straightforward and avoid overengineering for speculative failure scenarios.
