# versu! web UI rules

These instructions apply to `Web-Osu-Mania/`. The root `AGENTS.md` still applies.

Sources (read the latest version before significant UI work):
- Anthropic's [frontend-design skill](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md): subject-specific identity, deliberate hierarchy, restrained motion, and explicit anti-template critique.
- [Impeccable](https://github.com/pbakaus/impeccable): `distill`, `clarify`, `critique`, and live browser iteration; use its principles, not a default template or an unreviewed installer/hook.
- [Vercel Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines/blob/main/command.md): accessibility, focus, layout, touch, and clear action copy.

## Product truth
- Name: **versu!**; all site copy in English. One Sui Forest of Clock Challenge contains **Easy and Hard** (4K). Its UTC start is chosen and made immutable at on-chain creation; exactly **6 hours from that start** accept paid buys, starts and scores, followed by an immutable claim window. No pre-start paid entry. Sui Circle USDC 1 buys 3 non-transferable wallet plays usable on either difficulty. Each start spends 1 even if interrupted; paid gameplay never resumes.
- ALL stake belongs to one on-chain vault. Easy awards 30% and Hard 70% of the total pot. Each difficulty pays its five highest eligible scores 40/20/20/10/10 within that slice. One Sui wallet may claim only ONE share across BOTH difficulties per challenge. Missing winner shares return to buyers pro rata; never sweep to a single person.
- User flow: choose Easy/Hard → connect a Sui wallet (browser or WalletConnect phone pairing QR) as the player identity → connect the Bridge device → stake 1 test USDC for 3 plays → configure speed/controls → spend 1 credit at start → submit the Bridge-signed score before the on-chain six-hour deadline → sign a Sui transaction for ONE chosen prize claim → permissionless Sui payout after the fixed claim window.
- The leaderboard must NOT fetch/decode `forest.osz` (~18 MB) or audio. Difficulty switching reads only on-chain IDs and labels. **Practice demo** uses the separate small `daily-demo.osz` archive only after an explicit practice action; **paid Easy/Hard** loads Forest only after explicit paid setup. Both require the Bridge connection, but only paid Forest scores rank.
- Free practice and paid play both open the SAME preplay screen for note scroll speed, visual effects and keybinds. Moving sliders costs nothing; only confirming a new paid start burns a credit. Never hide personal controls for paid runs or allow paid gameplay resume.
- Do not try to identify ordinary keyboard origin in the browser or suppress other keyboards. Bridge connection gates both play modes, but the local visual score can reflect any keyboard. **Only the registered Bridge device's signed trace determines paid on-chain scores.** Label local results accordingly; never claim unverified local scores rank.
- No World ID proof, identity cap, or attestor is required. Claim registration uses the transaction sender and binds that wallet to one difficulty; switching after registration is disallowed. There is no per-human uniqueness guarantee.
- Player UI in development and production uses the SAME real Sui wallet/PTB and direct wallet-signed Sui claim path. An unlinked `#_simulation` URL under `VITE_VERSU_MODE=dev` AND `import.meta.env.MODE === "development"` contains the isolated in-browser mock ledger/operator controls for internal testing only; it never claims real USDC or Bridge proofs. Production builds exclude it. Any testnet device simulation must be separately labeled and never treated as secure hardware. Show upcoming/active deadlines centrally in the navbar and remaining wallet plays beside buy/start actions.

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
4. Do not call the work done because TS compiles. Prove visible behavior and report what real hardware/Sui transactions could or could not be exercised.
