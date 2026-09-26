# versu! web UI rules

These instructions apply to `Web-Osu-Mania/`. The root `AGENTS.md` still applies.

Sources (read the latest version before significant UI work):
- Anthropic's [frontend-design skill](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md): subject-specific identity, deliberate hierarchy, restrained motion, and explicit anti-template critique.
- [Impeccable](https://github.com/pbakaus/impeccable): `distill`, `clarify`, `critique`, and live browser iteration; use its principles, not a default template or an unreviewed installer/hook.
- [Vercel Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines/blob/main/command.md): accessibility, focus, layout, touch, and clear action copy.
- [World ID's official IDKit skill](https://docs.world.org/world-id/SKILL.md): reuse the existing Portal app/RP/action, server-only RP signing and proof verification, durable nullifier uniqueness, matching environments, and a real success plus denial/cancel demo. Never request signing keys in chat.

## Product truth
- Name: **versu!**; all site copy in English. Four-key rhythm game. A Sui 1 USDC purchase grants 3 paid plays. Starting one uses one credit, even if interrupted; gameplay never resumes. Only a World ID-verified human with an approved HID device can enter. The highest Sui-verified score wins the Sui pot.
- User flow: connect a wallet for Sui payment and prize destination → verify the **person** with World ID → check Bridge hardware → buy a 3-play pack on Sui → adjust speed/personalization → start a run. A wallet address is not proof of a unique person; never treat wallet connection as human verification.
- The first screen's job: show four lanes, their keys D/F/J/K, the hit line, the cost/credits, and the next playable action. History and claiming stay available without HID.
- Free practice and paid play both open the SAME preplay screen for note scroll speed, visual effects and keybinds. Moving sliders costs nothing; only confirming a new paid start burns a credit. Never hide personal controls for paid runs or allow paid gameplay resume.
- Do not try to identify ordinary keyboard origin in the browser or suppress other keyboards. Bridge connection gates both play modes, but the local visual score can reflect any keyboard. **Only the registered Bridge device's signed trace determines paid on-chain scores.** Label local results accordingly; never claim unverified local scores rank.
- A wallet already attested on Sui for the current round must be able to buy another pack without repeating the World proof; the on-chain binding, not a browser flag, is authority.

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
