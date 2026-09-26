# Retro crypto theme benchmark

Reviewed 26 September 2026 for the existing osu! arena app. This is a qualitative design/integration comparison, not a performance or conversion study.

## References

| Reference                                                                              | Evidence reviewed                                                                                                                          | Retro fit                                                         | Crypto / game fit                                                                                        | Integration decision                                                                                                                                                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [8bitcn/ui](https://www.8bitcn.com/)                                                   | Live desktop page and [registry docs](https://www.8bitcn.com/docs)                                                                         | Strong: bitmap type, hard-edged frames, tactile controls          | Game menus, player stats and difficulty components are directly relevant; not a crypto theme             | Primary component reference. Recreate the visual principles in existing CSS rather than replace working dialogs and controls.                                                             |
| [Neobrutalism components](https://www.neobrutalism.dev/)                               | Live desktop page, [styling](https://www.neobrutalism.dev/styling) and [installation docs](https://www.neobrutalism.dev/docs/installation) | Medium: thick outlines and hard shadows; less explicitly arcade   | Strong action hierarchy, but oversized decorative stars and marketing sections do not help a leaderboard | Use restrained physical button feedback and clear outlines. No component migration to Base UI.                                                                                            |
| [Nounish — Pixel Art DAO Landing Page](https://zylageth.gumroad.com/l/nounishtemplate) | Search-indexed creator listing; live page returned blank in the research browser                                                           | Strong according to listing: pixel styling and bold/lite variants | Explicitly aimed at NFT DAOs and games                                                                   | Closest crypto-retro template found. Framer delivery and a paid remix ($42 at lookup) make it an inspiration reference, not a code dependency. Its live layout was not visually verified. |
| [Web3Bit](https://web3bit.webflow.io/)                                                 | Public template listing                                                                                                                    | Weak for this brief: primarily crypto marketing                   | Crypto subject matter fits, but multi-page marketing content is not a playable app                       | Reject as implementation base: wrong platform and page structure.                                                                                                                         |

8bitcn has a shadcn-compatible registry. I did not verify a single drop-in shadcn theme combining retro styling, wallet entry, rhythm gameplay and a prize leaderboard. The best fit is an original theme on the current React/Tailwind 4/Radix components, using 8bitcn as the strongest visually verified reference.

No paid source code, template artwork, or new packages were imported. The pixel medal is original inline SVG. The warm cream/vermilion palette is an original choice, not a claimed extraction from Nounish.

## Audit and implementation

- The prior lobby accumulated several override passes: bitmap arcade, sparse typography, and Macintosh window styles. Replaced the lobby passes with one authored theme block while retaining game/setup/claim styles and the existing dialog chrome.
- The large faded trophy competed with live prize data. Replaced it with a small pixel rhythm medal and a distinct prize-window titlebar; removed its image preload.
- Weak gray outlines and similar surface weights flattened the hierarchy. Added a dark structural rule, warm surfaces, a single vermilion action color, and stronger primary buttons.
- Pixel type, body text and numeric data lacked a consistent role. Bitmap remains for identity, key headlines and Play; sans-serif for instructions; mono/tabular numbers for labels and financial data. All fonts are already local.
- Strengthened mobile stacking, table-contained horizontal scrolling, focus visibility, pressed states, and reduced-motion behavior. Added a skip-to-content link.
- Checked existing loading, empty, unavailable-data, disabled-payment, history, setup and claim states. Kept the unavailable-data message truthful; no invented prize totals or wallet records.
- Closing payment did not restore keyboard focus because its opener is outside DialogTrigger. Added explicit close-focus handling, excluding the handoff to the wallet picker.
- Retained the osu! logo, game renderer, pricing, contracts, wallet/QR logic and score calculation. The app still follows the OS light/dark preference with coordinated wallet colors.

## Validation

- TypeScript check, production client/server build, and all 9 existing leaderboard/QR tests passed.
- Browser smoke checks: payment opens; Escape closes it and restores focus to Play; practice setup, history date input and claim screen render; no page errors in these flows.
- No document-level horizontal overflow at 320, 390, 768, 1024 or 1366px. The wide leaderboard scrolls within its own container.
- Visually inspected desktop, mobile, dark theme, practice setup and payment. Mobile payment fits inside the viewport and remains scrollable on shorter screens.
- Live competition and phone QR are not configured locally. Paid transactions, live populated rankings, actual phone wallet scanning and prize settlement were not end-to-end verified.

Screenshots in `design/` show actual local application states, not a static mockup.
