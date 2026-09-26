# World IDKit integration debrief — ETHGlobal Tokyo 2026

**Trust moment:** Before a paid 3-play pack can be purchased, versu! binds a Sui wallet to one verified human for that UTC round. This prevents one person from entering with additional wallets to compete for the same prize. Further purchases and attempts from that same wallet remain possible.

**Minimum sufficient credential:** IDKit v4 Proof of Human. The prize needs uniqueness, not a legal name, age, nationality, or document. Passport/NFC would demand unnecessary identity assurance; a selfie risk score would not provide the same unique-person guarantee. The browser presents the proof request; the Cloudflare Worker validates the complete IDKit result through the World Developer Portal, checks action/nonce/environment/wallet signal, persists the nullifier binding in D1, and issues a Sui on-chain identity attestation. An unverified client response grants nothing.

**Alternative path observed:** With no D1/Portal configuration, `POST /api/identity/challenge` returned HTTP 503 `identity_not_configured` in the running app. No wallet can buy plays because the Sui vault also requires the attested binding. The missing-controller browser surface blocks playing. Cancellation, denial, and duplicate-human rejection have not been exercised with real World credentials.

**Time to first successful IDKit verification:** Not yet observed. This workstation is not authenticated with Cloudflare, has no World Developer Portal app/RP/action/signing key, and has no real D1 database binding. Claiming a successful verification or a prize-qualified live demo would be false.

**Friction encountered:** World ID v4 requires a server-only RP signing key, production/staging environment alignment, a durable nullifier constraint, and a server-held Sui IdentityCap. None can safely be replaced by browser state or a mocked success callback.

**Missing capability in this demo environment:** A provisioned Developer Portal action and signing key, D1 binding, a freshly deployed Sui competition, and a real World ID completion path. The code fails closed without them.

**Most useful improvement to documentation:** A complete Cloudflare Worker + D1 + non-EVM Sui-wallet IDKit example showing RP signing, wallet-signal binding, nullifier uniqueness and on-chain attestation, alongside a simulator cancellation case.

Prize qualification source: [ETHGlobal Tokyo 2026 — Best Use of IDKit](https://ethglobal.com/events/tokyo2026/prizes#world). This document records actual status, not a claim of qualification. Complete a live successful proof and a failed/cancelled/ineligible path before submission.
