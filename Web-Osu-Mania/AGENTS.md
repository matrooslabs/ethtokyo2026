# versu! web UI rules

These instructions apply to `Web-Osu-Mania/`. The root `AGENTS.md` still applies.

Sources (read the latest version before significant UI work):
- Anthropic's [frontend-design skill](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md): subject-specific identity, deliberate hierarchy, restrained motion, and explicit anti-template critique.
- [Impeccable](https://github.com/pbakaus/impeccable): `distill`, `clarify`, `critique`, and live browser iteration; use its principles, not a default template or an unreviewed installer/hook.
- [Vercel Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines/blob/main/command.md): accessibility, focus, layout, touch, and clear action copy.
- [World ID's official IDKit skill](https://docs.world.org/world-id/SKILL.md): reuse the existing Portal app/RP/action, server-only RP signing and proof verification, durable nullifier uniqueness, matching environments, and a real success plus denial/cancel demo. Never request signing keys in chat.

## Product truth
- Name: **versu!**; all site copy in English. A single Sui Forest of Clock challenge contains **Easy and Hard** (4K). On-chain Challenge creation starts exactly **6 hours** of paid play and score acceptance; its immutable claim window follows. Sui Circle USDC 1 buys 3 non-transferable wallet plays usable on either difficulty. Each start spends 1 even if interrupted; paid gameplay never resumes.
- ALL stake belongs to one on-chain vault. Easy awards 30% and Hard 70% of the total pot. Each difficulty pays its five highest eligible scores 40/20/20/10/10 within that slice. One World ID human may claim only ONE share across BOTH difficulties per challenge. Missing winner shares return to buyers pro rata; never sweep to a single person.
- User flow: connect a Sui wallet (browser or WalletConnect phone pairing QR) → connect Bridge device → stake USDC for 3 plays → choose Easy/Hard → personalize speed/controls → play and submit Bridge-signed score → after the fixed 6h score cutoff, prove unique person with World ID to register ONE claim → after the claim window, permissionless Sui payout. The wallet is gameplay identity; World proves one-human-one-reward at claim only.
- The first leaderboard screen must NOT fetch/decode `forest.osz` (~18MB) or its audio. Use registered on-chain chart IDs and lightweight labels first; load/parse the chosen Forest archive only after explicit practice/paid play. Show 4 lanes, D/F/J/K, cost/credits, on-chain 6h countdown and the next available action.
- Free practice and paid play both open the SAME preplay screen for note scroll speed, visual effects and keybinds. Moving sliders costs nothing; only confirming a new paid start burns a credit. Never hide personal controls for paid runs or allow paid gameplay resume.
- Do not try to identify ordinary keyboard origin in the browser or suppress other keyboards. Bridge connection gates both play modes, but the local visual score can reflect any keyboard. **Only the registered Bridge device's signed trace determines paid on-chain scores.** Label local results accordingly; never claim unverified local scores rank.
- No World ID proof or identity cap is required to buy or play. Claim registration uniquely binds a challenge-scoped World nullifier to the chosen wallet and difficulty; switching after verification is disallowed.

## Non-negotiable UI filter
- Each sentence must answer one player question or enable the next action. Delete marketing copy, repeated rules, pseudo-profound slogans, explanatory framework names, and decorative labels. Errors say what failed and what to do next.
- No tracked-out ALL-CAPS eyebrow above each section; no dot-joined feature slogans (`X · Y · Z`), numbered cards that aren't a process, icon tiles, nested cards, gradient washes, arbitrary animation, or duplicated CTAs. Do not replace one template with another.
- One focal element only: the four playable lanes. Treat prize, verification, and controls as information, not decorative feature cards. One primary action per state; secondary actions visually quieter.
- Visual direction is **classic Macintosh rhythm arcade**, matched to the user-supplied `versu-logo.png`: warm computer gray, dark ink, one restrained coral hardware-key accent, flat 1px dividers, Silkscreen only for short display text and IBM Plex Mono for compact controls/data. This is product-specific, not permission for generic cream/terracotta landing-page cards. No neon dashboard or glossy gradients.
- Never claim a QR scans a payment, a connected HID is authenticated, or a local score is verified. State changes only after server/on-chain confirmation.
- Put costly or irreversible rules next to their buttons in one short sentence; do not repeat disclaimers as a paragraph. No sponsor or cryptography explanation on the hero; keep it in contextual help if needed.

## Review before shipping
1. Write the player path in five plain-English verbs; compare each screen against it. Remove redundant copy/components before adding new ones.
2. Open the running site in a browser. Inspect desktop and narrow-mobile screenshots, tap/click the wallet, HID, identity, claim and back paths, and check the actual denied/unconfigured states.
3. Remove at least one decoration after the first screenshot. Confirm keyboard focus, screen-reader labels, reduced-motion support, and no horizontal scrolling.
4. Do not call the work done because TS compiles. Prove visible behavior and report what real hardware/World ID/Sui transactions could or could not be exercised.
