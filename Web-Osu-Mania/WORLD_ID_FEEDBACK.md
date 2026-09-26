# World IDKit debrief — ETHGlobal Tokyo 2026

**Trust moment:** A ranked wallet requests one of the pooled USDC prize shares. Paying and playing require no World ID. Before claim registration, the app proves the claimant is one unique person; the same person cannot collect again through another high-scoring wallet.

**Minimum sufficient credential:** IDKit v4 Proof of Human. At claim time the server signs the RP request, verifies the complete World proof, checks wallet signature, action, nonce, Challenge ID, chosen difficulty, environment and signal, then uses that Challenge's `IdentityCap` to register one claim. The World nullifier becomes a Challenge-specific SHA-256 commitment on Sui, never raw proof data on-chain. A wallet address alone proves neither humanity nor payout eligibility.

**Durable uniqueness without a separate database:** The on-chain `competition::Challenge` stores nullifier commitments and wallet claim bindings, enforcing one human and one wallet across Easy and Hard. The Worker issues short-lived authenticated challenge tickets and proof-confirmed attestation tickets; they carry wallet, difficulty and expiry so retries do not require a second World proof. The Sui shared object serializes concurrent registrations. A reused token cannot make a second payout or change the bound wallet/difficulty.

**Live configuration check:** `POST https://versu.astar.moe/api/identity/challenge` previously returned **503 `identity_not_configured`**. Public app `app_3b09fd5fe1c151bd37b19ceb95c45170` and RP `rp_78581d63ee7bed85` are configured as production Worker vars, but that does **not** confirm the production action is registered or provide the RP signing secret. The response is a fail-closed configuration result, not a successful World proof or proof denial.

**Time to first successful IDKit verification:** Not observed. Wrangler 4.118 under Node 22 reports **not authenticated**, so the RP signing key cannot be installed in the deployed Worker here. The Sui testnet Registry has no active Challenge or `IdentityCap`; even valid Portal credentials cannot authorize a prize claim yet.

**Friction:** The RP signing key must stay server-only; staging and production actions must match the World App/simulator. Expiring signed tickets authenticate each request, while final replay and uniqueness protection lives in the on-chain Challenge. Verification remains at claim time so ordinary paying players do not identify themselves before playing.

**Missing capability here:** Confirm Portal production registration/action `versu-prize-claim`; enter the RP signing key as a Worker secret; activate a secure Sui Challenge and map its `IdentityCap`; then observe a real World App proof success, on-chain `ClaimRegistered`, and meaningful duplicate-person and cancel/denial paths. Do not paste keys into chat.

**Most useful documentation improvement:** A Cloudflare Worker + Sui Wallet Standard example of claim-only IDKit, signed stateless proof context and on-chain nullifier uniqueness, including a successful claim and duplicate-person rejection.

Qualification reference: [World Best Use of IDKit at ETHGlobal Tokyo 2026](https://ethglobal.com/events/tokyo2026/prizes#world). A functioning proof success and one meaningful rejected/cancelled path remain required; this document does not claim prize qualification.
