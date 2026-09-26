# World IDKit debrief — ETHGlobal Tokyo 2026

**Trust moment:** A ranked wallet requests one of the pooled USDC prize shares. Paying and playing require no World ID. Before claim registration, the app proves the claimant is one unique person; the same person cannot collect again through another high-scoring wallet.

**Minimum sufficient credential:** IDKit v4 Proof of Human. Only unique-human assurance matters for one person, one reward; passport/age/nationality would request irrelevant identity data, and a selfie risk score does not provide the same uniqueness guarantee. The client requests the proof for the chosen best-scoring Sui wallet. A server signs the RP request, verifies the complete IDKit result with World, checks wallet signature/action/nonce/round/environment/signal, persists a unique round-scoped nullifier in D1 and registers the claim through a Sui `IdentityCap`. A wallet address alone proves neither identity nor payout eligibility.

**Durable nullifier storage:** SQLite cannot preserve a 256-bit `NUMERIC(78,0)` exactly. D1 stores a canonical lowercase, zero-padded 64-digit hexadecimal `TEXT` key and enforces `PRIMARY KEY(round,nullifier)` plus `UNIQUE(round,wallet)`. The on-chain record contains a round-specific commitment, not the raw World nullifier. Repeated proof from the same wallet is idempotent; a different wallet for that person is rejected.

**Alternative path observed:** Without a D1 binding and Portal settings, `POST /api/identity/challenge` returned 503 `identity_not_configured` on the running site. An unverified person cannot register a claim. Cancellation, failed proof and duplicate-human/different-wallet rejection have not yet been exercised with real World credentials.

**Time to first successful IDKit verification:** Not observed. This environment has no World Developer Portal app/RP/action/signing key and Wrangler reports no Cloudflare authentication for D1. The server fails closed instead of fabricating a successful proof.

**Friction:** The v4 RP signing key must remain server-only; staging and production actions must match the World App/simulator; proof replay and nullifier uniqueness need durable storage. Moving verification to claim time avoids forcing every paying player to identify before playing but requires an explicit claim window so late high scorers cannot overturn an already-paid share.

**Missing capability here:** Provisioned Portal claim action `versu-prize-claim`, RP secret in Worker, real D1 binding/migration, funded Sui claim round, and a World App/Simulator completion. Do not paste keys into chat.

**Most useful documentation improvement:** A Cloudflare Worker + D1 + Sui Wallet Standard example of a claim-only IDKit proof, wallet-signal binding and Sui capability-based claim registration, including successful and duplicate-person outcomes.

Qualification reference: [World Best Use of IDKit at ETHGlobal Tokyo 2026](https://ethglobal.com/events/tokyo2026/prizes#world). A functioning proof success and one meaningful rejected/cancelled path remain required; this document does not claim prize qualification.
