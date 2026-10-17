---
session_id: 296c6669-a206-4d68-9b9f-1f8b302bff4b
date: 2026-10-17
time: "2026-10-16 12:50 PM PDT – 2026-10-17 04:12 AM PDT"
resumed: "2026-10-17 01:51 AM PDT"
project: syntax-supercut-studio
---

# Session Summary: Supercut punctuation handling and Regex tips

## Overview

Audited how `/supercut` phrase and regex modes treat punctuation, after "I dont know" returned 0 hits while "I don't know" returned 309. Fixed smart-quote apostrophes, corrected the help text, and added a "Regex tips" modal of corpus-checked examples. Three commits on `main`, none pushed.

Note on timestamps: the start time comes from the first SessionStart hook (`2026-10-16 12:50 PM PDT`). On resume, the metadata collector reported `session_start` as the resume time (`2026-10-17 01:51 AM PDT`), so that value is recorded only as the resume time.

## The Finding

`normalize()` in `src/lib/server/text.ts` strips everything except letters, digits and `'`. Phrase mode therefore ignores case, commas, periods and hyphens, but **not apostrophes**: `dont` ≠ `don't`. The old help text ("Case- and punctuation-insensitive") was wrong. Regex mode runs on word texts joined by single spaces, with punctuation attached to its word, and widens each match to every word it touches.

## Key Decisions Made

| Decision | Rationale |
|----------|-----------|
| **Keep apostrophes significant in phrase mode** | Stripping them would make `well`/`we'll`, `were`/`we're`, `its`/`it's`, `ill`/`i'll` and `hell`/`he'll` collide. Fixing the docs was safer than changing matching. |
| **Fold `’` `‘` `ʼ` to `'` (phrase and regex)** | Transcripts contain only straight apostrophes, so smart-quoted input (macOS/iOS Smart Punctuation) silently matched nothing. A one-for-one UTF-16 swap leaves regex word offsets intact. |
| **Skip folding escaped `’` in regex sources** (Codex P1) | Not a regression, since those patterns already matched nothing. Correct handling of escaped backslashes would cost more than the case is worth. |
| **Skip "not every match becomes a clip"** (Codex, second review) | Matches with no length, or shorter than `MIN_HIT_DURATION` (0.08 s), are too rare to explain in the modal. |
| **Native `<dialog>` in its own component** | Matches the existing `/film` and `/sentence` dialogs. Patterns live in script data because `{0,2}` would be parsed as a Svelte expression in markup. |
| **Backdrop color built from `--well`** | Codex flagged the copied `#0009` as violating the tokens-only rule in CLAUDE.md. |

## Changes Made

| Change | Detail |
|--------|--------|
| **Apostrophe folding** | `foldApostrophes()` added in `src/lib/server/text.ts` and used by `normalize()`. `collectHits` in `src/lib/server/hits.ts` rebuilds the regex from a folded source and folds each word text. This also covers `/songify` and the stats page. |
| **Help text** | `/supercut` phrase help now says apostrophes matter and hyphenated words are one word. Regex help explains that punctuation stays attached to its word and that a match clips every word it touches, with `\bit\b(?!')` as an example. |
| **Regex tips modal** | New `src/lib/RegexTips.svelte`, used below the regex help in `src/routes/supercut/+page.svelte`. Nine sections, each example with a "Use" button that fills the regex field. Ligatures are turned off so `(?<=` doesn't draw as `≤`. Includes the `\byour mom\|mam` trap added at the user's request. |
| **CHANGELOG** | 2026-10-17 entries: Added (Regex tips) and Fixed (smart-quote apostrophes, help text). |
| **Commits** | `9be4e9d` fix(supercut): smart-quote apostrophes + help text · `6fd9bd8` feat(supercut): Regex tips modal · `b2e5782` docs(supercut): `\byour mom\|mam` example |

## Testing / Research Performed

- **Corpus analysis:** scratch scripts went over all 702 transcripts (541,802 words, two buckets). Punctuation counts: `.` ×49,878, `,` ×38,536, `'` ×27,472, no curly apostrophes. Apostrophe-less spellings are rare (`dont` ×2, `thats` ×2).
- **Mode comparison:** ran phrase vs regex counts for about 40 patterns. Examples: `no` 7,660 vs `\bno\b` 1,474; `\bno|yes\b` 5,098 vs `\b(no|yes)\b` 2,021; `\bit\b` 6,650 vs `\bit\b(?!')` 4,395; `\bI .*know\b` produced a clip of 7,682 s; `\. so\b` a clip of 61 s, vs the lookbehind form at 1.1 s. These are talking-heads counts.
- **Reproduced the user's count:** "I don't know" = 309 in `talking-heads` and 196 in `talking-heads-onscreen`.
- **Real code:** called the real `collectHits` through `npx tsx` (a `.mts` file in the scratchpad). Curly `I don’t know` returned 0 before and 309 after, in both phrase and regex mode.
- **Type check:** `npm run check` gave 0 errors after each change.
- **Browser:** checked the modal in Chrome on `:5180` in dark and light themes and in a 390 px iframe. Confirmed that "Use" fills the field and closes the modal, and that the ligature fix and backdrop token work.
- **Codex reviews (gpt-5.6-luna, high):** two runs. The punctuation diff came back FIX: one P1 skipped, two help-text P2s applied. The modal came back FIX: four of five findings applied.
- **Running jobs:** checked `:5180` and `:5190` before editing `src/lib/server/` (per memory). None were running.

## Discoveries / Handoff Notes

- In `talking-heads-onscreen`, the 9,733 zero-length `|` tokens are deliberate gap markers from `engine/build_buckets.py`. Phrase mode can't span them. Regex patterns using `\W+` or `\S+` can, and then pull off-screen speech into the clip; `[^\s|]+` avoids that.
- Two `talking-heads` transcripts (c242 in both buckets) contain a word made of `different<unk><unk>…`, a transcription artifact.
- Regex hits record `m[0]` as the hit text, not the expanded words, so a hit shown as "your mom" may clip "your moment".
- `npx tsx` on a `.ts` file fails on top-level await (CJS output); a `.mts` extension works.
- JetBrains Mono ligatures change how regex text renders; any new UI showing code should set `font-variant-ligatures: none`.

## Summary Statistics

- Commits: 3 (not pushed)
- Files changed: 5 (`text.ts`, `hits.ts`, `supercut/+page.svelte`, new `RegexTips.svelte`, `CHANGELOG.md`)
- Transcripts analyzed: 702 (541,802 words)
- Codex review passes: 2; findings applied: 6 of 8
- `npm run check` runs: 6, all 0 errors

## Unfinished Work

None. Optional follow-ups, not requested: folding escaped `’` in regex sources, and noting in the modal that matches shorter than 0.08 s are dropped.
