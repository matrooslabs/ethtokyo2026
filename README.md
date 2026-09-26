# ETH Tokyo 2026

- [osu! application](Web-Osu-Mania/): game projects, assets, tests, and build configuration.
- [scoring](scoring/): scoring and proof generation
    - [Shared scoring core](scoring/core/) and [canonical scoring specification](scoring/SCORING_SPEC.md).
    - [GKR scoring](scoring/gkr-scoring/): scoring and proof generation using GKR. To see the specification, see [README](scoring/gkr-scoring/README.md)

For osu! development, open `Web-Osu-Mania/` as the workspace and run build commands from that directory. See the [osu! README](Web-Osu-Mania/README.md) for setup instructions.
## Daily leaderboard demo

Each attempt pays 1 USDC into its chart’s UTC-day pot. The first accepted highest score wins; after midnight anyone can send the pot to that winner. A round with no accepted score permits payer refunds. Contracts enforce accounting and settlement; the indexer provides rankings/history.

- [Execution plan and draft PRs](docs/daily-leaderboard-plan.md)
- [Deployment, Sepolia manifests and settlement smoke commands](leaderboard/ops/README.md)
- [Local proof bridge and software-demo configuration](leaderboard/bridge/README.md)
- [Indexer setup and API](leaderboard/indexer/README.md)
- [Web wallet/payment/proof/claim setup](Web-Osu-Mania/DAILY_LEADERBOARD.md)

This demo uses software signing and a known-tau development SRS; it does not establish physical gameplay attestation or production proof soundness. Physical hardware verification is outside the current scope.
