---
session_id: 1faf8f06-cf06-4c42-901e-d4fa2233a6e2
date: 2026-10-21
time: "6:19 PM PDT – 10:27 PM PDT"
project: syntax-supercut-studio
---

# Session Summary: Resolve export (B24/B25 + songify), tom_hanks sentences, B26 render speedup

## Overview

This session shipped "Export for Resolve" for every page that renders an edit:
- B24: supercut saves a cut list beside each render.
- B25: an export API plus a button on `/clips` and in the job panel.
- Songify: saves the same cut list.

It built a few `tom_hanks` sentences on `/sentence` and explained why some phrasings can't be built. It reviewed the codebase for refactor opportunities, then delivered B26 (3–4× faster supercut/songify renders). B26 was verified against the old pipeline, the source files and synthetic test clips, and handed off B27/B28 in a baton.

## Key Decisions Made

| Decision | Rationale |
|----------|-----------|
| **Export API returns the file contents; the browser makes blob downloads** | Avoids new media routes and the 1 h `Cache-Control` on engine media. Re-exports overwrite the same filenames, so cached downloads could go stale. |
| **Tile `out` = `min(hit.end, start + duration·speed)`** (deviates from Desktop's spec) | `renderTile` trims sources at the word end. Past it, the export would show source the render never used. Noted to Desktop. |
| **Export only after a film render, not after Plan alone** | A plan from `plan` alone has no `t` fields, and engine `export --plan` fails with `KeyError: 't'`. |
| **Songify pitch shift goes in clip names and markers** | Cut list v1 has no pitch field. Asked Desktop whether FCPXML can carry one. |
| **Refactor order #2+#3 (B26) → #1 option A (B27) → #4 (B28)** | Agreed with Ryan. Ryan required more than one A/B listen for B26. |
| **Built an independent verification harness before implementation** | So the implementer doesn't grade its own work. It was proven to detect injected 2 ms gaps and clicks. |
| **MOV intermediates (1/15360 timescale) instead of the plan's MKV** | MKV's 1 ms timebase rounded frame times, and the output started at 0.067 s video / 0.046 s audio. MOV gives start 0 with exact 1/30 s frames. |
| **Judged sync against the sources, not the old render** | The old concat filter padded each segment to its AAC audio (1610 vs 1576 frames for 120 clips), so old-vs-new comparison can't judge sync. |
| **Cut list `rec` advances by rendered `N/30`** | Desktop's B24 spec says `rec` follows the concat. Codex review pass 2 flagged the mismatch. |
| **Songify 44.1 kHz pitch fix included in B26** | The B26 timeline change made old-vs-new songify comparison inexact anyway. |
| **Handed off B27/B28 via a baton** | Context was past Ryan's ~50% target; B27 is the largest item. |

## Changes Made

| Change | Detail |
|--------|--------|
| **B24/B25** `71033c4` | Supercut writes `<render>.cuts.json` (solo hits and tiles with rect/speed). `POST /api/export` (`{bucket,file}` or `{plan}`) runs engine `export` and checks the returned paths stay in the output dir. `ExportForResolve.svelte` is on `/clips` and in `JobPanel`. The jobs GET adds `exportTarget`. Clip delete also removes the cut list and exports, including the engine's sanitized export names. Board, changelog and both inboxes updated. |
| **Songify export** `282c11c` | New shared `src/lib/server/cutlist.ts`, used by supercut and songify. Songify writes a cut list. `JobPanel` shows export for any finished job with a target. |
| **B26 plan** `95f176a` | `docs/plans/b26-render-speedup.md`; board rows B26 (claimed), B27, B28. |
| **B26** `6946c47` | New `src/lib/server/render.ts`. It renders segments in parallel (`SYNTAX_RENDER_CONCURRENCY`, default 4) into MOV intermediates (H.264 + PCM), each exactly N frames and N×1600 audio samples. Segments are joined with the concat demuxer, video copied and audio encoded once. The pool has a first-failure-wins model. Relative concat names handle apostrophes. Songify gets clone-padding and the 44.1 kHz pitch fix. `CLAUDE.md`, `CHANGELOG.md` and the plan's "As built" section updated. Implemented by Codex in worktree `../ssc-b26`, then fixed and verified here. |
| **Desktop inbox** | Three notes. First, B24/B25 done, with exporter same-lane frame overlaps, the tile `out` deviation, and the `--plan` cut-list mismatch with the contract. Second, the songify pitch field question and plan-only export failures. Third (`d1074bc`), phrase files misattributing lines (Hoffman's "scotch bottle" under Hanks). |
| **Baton** | `.baton/2026-10-21-b27-b28-engine-hits-and-renders.md`, plus `.baton/2026-10-21-ab-harness/` (harness scripts and A/B listening pairs; gitignored). |
| **Worktrees** | `../ssc-b26` merged and removed; `../ssc-baseline` removed after Ryan's listen. |

## Testing / Research Performed

- **`npm run check`:** 0 errors after every change.
- **B24/B25 on a throwaway :5199 server:**
  - tiled and plain supercuts rendered and exported (20 items from 10 sources);
  - `--plan` export of a sentence;
  - 400/404 validation;
  - delete cleanup, including an apostrophe name;
  - browser check on `/clips` with the download suppressed.
- **Codex reviews (gpt-5.6-luna high):**
  - B24/B25 pass 1: FIX (5 findings) and pass 2: FIX (2), all fixed;
  - songify pass: 1 real finding fixed, 1 skipped as negligible;
  - B26 plan: REVISE (applied);
  - B26 diff pass 1: FIX (4, fixed) and pass 2: FIX (2, fixed).
- **Found by running it:**
  - the engine exporter puts consecutive items on one lane 1–2 frames overlapping (12 of 13 joins);
  - `export --plan` fails with `KeyError: 't'` on plan-only plans;
  - running `plan` overwrote `_test_pc.plan.json`.
- **`/sentence` with `cast: ["tom_hanks"]`:**
  - "I think we have a problem here." → cannot build (no "problem");
  - "Because there's no crying in my office." → rendered; QA failed (heard "crime … house");
  - "Calm down. I can get the appropriation." → QA passed 7/7;
  - "Calm down. I can get a bottle of scotch" → cannot build (scotch is Hoffman's, `c85/1`);
  - "Calm down. Get you a drink?" → QA passed 6/6.
- **B26 A/B harness** (`render.mts` with seeded `Math.random`, `analyze.py`, `absolute.py`):
  - **Harness validation:** the identical pair passes every check; 6 ms and 2 ms gaps and an injected click are detected.
  - **Corpora:** five real-media edits, all "SAME EDIT".
  - **Absolute check against sources** (four supercut corpora): frame count = ΣN, every segment at video shift 0, audio-minus-video 0.00 ms (max 0.02) on all reliably matched segments (n=12/50/110/39).
  - **Synthetic sources** (30/29.97/25/23.976/60 fps; H.264/VP9/AV1; 48/44.1 kHz; checker built by Codex): both renders start at 0 with no gaps. Per-source medians near 0 for 30/60 fps in the new render (old +9.2/+19.4 ms).
  - **Cancel mid-render:** `CancelledError`, no work dir, no ffmpeg left.
  - **Corrupt source:** the original ffmpeg error, siblings stopped, no leftovers.
- **Live check on :5180 after the merge:** a supercut rendered and exported.
- **Ryan's listen:** "can't tell a difference".

## Summary Statistics

- Commits on `main` this session: 5 (`71033c4`, `282c11c`, `95f176a`, `6946c47`, `d1074bc`); this summary is uncommitted.
- Board tasks completed: B24, B25, B26; added: B26, B27, B28.
- Codex runs: 2 implementations (B26 and its fix batch), 2 synthetic-checker builds, 8 review/validation passes.
- B26 render times at concurrency 4:

  | Edit | Old | New |
  | --- | --- | --- |
  | 120-clip solo | 32.8 s | 8.3 s |
  | 60-clip tiled | 19.9 s | 5.3 s |
  | 40-clip regex | 7.0 s | 2.4 s |
  | 15-clip tiled | 4.8 s | 1.8 s |
  | songify | 2.9 s | 1.0 s |

## Discoveries / Handoff Notes

- **The old join's padding was accidental, not a design choice.**
  - It has been in the concat-filter join since the upstream initial commit (`5055e51`), with no comment.
  - Each segment's AAC audio comes in 1024-sample blocks, so it ran up to ~21 ms longer than its video.
  - The concat filter starts the next segment only when the longest stream ends, and `-r 30 -fps_mode cfr` filled the gap by duplicating the last frame.
  - The amount varied per cut and didn't follow the content.
- **Supercut/songify don't use the engine to find clips** (`hits.ts` has no person or speaker-detection data). Only export is shared. B27 addresses this.
- **zsh `echo` interprets backslash escapes**, which corrupted JSON piped from `curl` into Python. Use `printf '%s'` or Python `urllib`.
- **Codex refuses to start outside a git repo.** `git init` scratch dirs rather than adding `--skip-git-repo-check`.
- **Python `round()` is banker's rounding.** A 0.35 s tile is exactly 10.5 frames, which differs from JS `Math.round`.
- **Detected pitches from aubio** land within 0.01 semitone of melody notes, so "0 st" shifts in songify cut lists can be genuine.
- **`phrases/<cid>_<n>.md` files** can credit lines to the wrong person; trust `/sentence`'s "by the cast" counts.

## Current State

- `main` at `d1074bc`, 4 commits ahead of `origin/main` (`71033c4`). Not pushed (Ryan pushes).
- Untracked: this summary and `docs/session-summaries/session-summary-2026-10-21-typesafe-jev-clip-search.md` (from an earlier session).
- Worktrees: only the main checkout.
- The dev server on :5180 is running the B26 code.
- `TH_ENGINE_DIR/films/out/` holds this session's sentence renders and test exports. `_test_pc.plan.json` was overwritten by a plan-only run.

## Unfinished Work

- **B27:** supercut/songify hits from the engine, person-aware, optional cast. Start from `.baton/2026-10-21-b27-b28-engine-hits-and-renders.md`.
- **B28:** "Engine renders" list for `films/out` with play and Export for Resolve.
- **Desktop items** (in its inbox):
  - exporter same-lane overlaps;
  - plan-only export failure and Plan overwriting a rendered film's plan;
  - `--plan` not writing `.cuts.json` as the contract says;
  - a songify pitch field;
  - the phrase-file misattribution.
- **Ryan:** `git push origin main`; optionally re-render `_test_pc` so its export works again.
