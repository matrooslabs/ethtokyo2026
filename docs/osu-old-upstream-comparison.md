# osu-old upstream comparison

Compared on 2026-09-26 at workspace commit `2d2a5cb020344b56faededabb4c5660b94dea5ea`.

## Finding

`osu-old/` matches [ppy/osu at 6408b4e0e46a9f4ea1b8d263afccd1df799604e4](https://github.com/ppy/osu/tree/6408b4e0e46a9f4ea1b8d263afccd1df799604e4), dated September 21, 2026, except for repository housekeeping. There is no custom gameplay, scoring, replay capture, wallet, or proof integration in the local delta to port to `Web-Osu-Mania/`. This is a content-matched baseline; the local repository imported a snapshot and does not preserve upstream ancestry.

## Method and reproducibility

Used the installed `opensrc` binary:

```sh
opensrc path ppy/osu
opensrc path 'ppy/osu@6408b4e0e46a9f4ea1b8d263afccd1df799604e4'
opensrc path 'ppy/osu#6408b4e0e46a9f4ea1b8d263afccd1df799604e4'
```

The master snapshot had 18 content differences, nine line-ending-only differences, and 13 missing files compared with `osu-old`. Upstream history showed the gameplay/UI differences corresponded to seven newer commits after September 21 (storyboard loops, settings search, opacity, coordinate clamping, screenshot uploading, key-counter alignment, screenshot rate-limit handling).

Both pinned opensrc invocations resolved to a commit-named cache directory whose contents still matched master. Therefore the final comparison uses the exact-commit GitHub archive, fetched independently:

```sh
gh api repos/ppy/osu/tarball/6408b4e0e46a9f4ea1b8d263afccd1df799604e4 > /tmp/osu-baseline.tar.gz
```

Compared every regular file by relative path and bytes, including binary assets and hidden configuration files. Separately normalized CRLF to LF to identify line-ending-only changes. No application builds or runtime tests were needed for this source comparison.

## Exact baseline results

| Category | Files |
| --- | ---: |
| Upstream files | 5,580 |
| Local files | 5,569 |
| Byte-identical files | 5,558 |
| Line-ending-only differences | 9 |
| Content edits | 2 |
| Added local files | 0 |
| Missing from osu-old | 11 |

The two content edits, fully recorded in [osu-old-local-edits.patch](../osu-old-local-edits.patch), are:

- `README.md`: removes the upstream CI build-status badge.
- `osu.Game/Utils/SentryLogger.cs`: replaces a comment referencing the removed Sentry workflow with a generic comment. Executable code is unchanged.

The nine line-ending-only changes are `.editorconfig`, `LICENCE`, `osu.Desktop/osu.nuspec`, two Taiko test beatmaps, and four game test beatmaps. The patch contains only the two content edits, not line endings or absent configuration files.

Of the 11 files absent from `osu-old`, five exist unchanged at the workspace root: `.git-blame-ignore-revs`, `.github/FUNDING.yml`, `.github/ISSUE_TEMPLATE/bug-issue.yml`, `.github/ISSUE_TEMPLATE/config.yml`, and `.github/dependabot.yml`. The other six are omitted upstream workflows: `_diffcalc_processor.yml`, `ci.yml`, `deploy.yml`, `diffcalc.yml`, `sentry-release.yml`, and `update-web-mod-definitions.yml`.

## Implication for the web migration

There is no legacy custom patch to transplant. The remaining work is integrating the existing scoring/hardware stack with the web client.

Useful existing integration points, based on source inspection:

- `Web-Osu-Mania/src/osuMania/systems/replayRecorder.ts`: records ordered `[column, time, isDown]` events. Its browser replay is not itself a signed hardware session; event timing, encoding, and chart identity need to agree with the prover contract.
- `Web-Osu-Mania/src/stores/gameStore.ts`: already checks wallet connection and restricts play to 4K charts. These checks do not implement the USDC entry payment.
- `scoring/gkr-scoring/engine/src/scoring/api.rs`: proof entry points consume `PlayInput` from `mania_scoring_core` in the SP1 subtree.
- `scoring/gkr-scoring/engine/src/scoring/session.rs`: canonical chart encoding and session digest construction.
- `scoring/gkr-scoring/SPEC.md` and `scoring/sp1-scoring/SPEC.md`: authoritative scoring/session requirements. The GKR specification explicitly retains the SP1 scoring semantics and relies on a registered device signing the session.

A practical next task is to trace one bundled 4K beatmap through canonical chart registration, paid session creation, hardware input capture, proof generation/submission, and result display. The web game's displayed score should not be assumed identical to the on-chain ruleset without checking it. This report does not implement that integration or fully audit the web client's differences from HecticKiwi/Web-Osu-Mania.

## Subsequent cleanup

After this comparison, `osu-old/` was removed at the user’s request. The two content edits are preserved in `../osu-old-local-edits.patch`; the comparison above describes the snapshot before removal.
