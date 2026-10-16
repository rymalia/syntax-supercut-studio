---
session_id: 679d0da2-91dc-4665-8cd4-48a7f0d5a284
date: 2026-10-16
time: "1:59 AM PDT – 6:13 AM PDT"
project: syntax-supercut-studio
---

# Session Summary: post-ingest merges, /people tweaks, B12 (/sentence on the engine), B18 (local transcription)

## Overview

This session grabbed the `post-ingest-merges-b12` baton and worked through all of it:
- refreshed the Library for the 172 new clips (c180–c351);
- merged B6 and B21;
- applied the user's speaker-review verdicts (`wordbank.py`, then `build_buckets.py`).

It then shipped four user-requested `/people` changes, plus B12 (`/sentence` rebuilt on the engine) and B18 (local parakeet transcription). That finished every plan in `docs/plans/`, and the baton was retired.

## Key Decisions Made

| Decision | Rationale |
|----------|-----------|
| **Rebase b6-wip / b21-wip in their worktrees, then `--ff-only`** | `main` had moved to `ba38dd5`. Switching branches in the main checkout is off-limits while the dev server runs there. |
| **Read the user's "fix B2" as the two B6 review findings** | B2 is Desktop's task (stable cluster ids). The two B6 findings were the only open question in front of the user. |
| **The "hide named" toggle lives on `/people` only; name search lives in `PersonGrid`** | `/film` shares `PersonGrid` and shouldn't hide anything, but name search helps both pages. |
| **Hidden clusters are never left ticked; picking a group turns hiding off** | Otherwise a save could rename tiles the user can't see. Codex found three routes to that (group pick, 409 reload, toggle-on); a single `$effect` covers all of them. |
| **B12: every plan default, as the user chose** | One line with no auto-split; BucketPicker removed; seed deferred to Desktop; debug replaced by Captions and Draft; optional cast; old pipeline deleted. |
| **B12 sentence film names limited to `[a-z0-9-]`** | A real render failed on `there's`: the engine strips the quote when it writes the `.ass` captions file, but not when it reads it. |
| **B12 writes a short-lived QA copy to `films/<name>.json`; a QA failure doesn't fail the job** | `qa_film2.py` only reads films from `films/`, and the video already exists by then. The copy is removed only if this call created it, and `/api/films` hides that name shape. |
| **B18: the app passes `--model` from `SYNTAX_PARAKEET_MODEL` (default v3)** | The user's `~/.zshenv` exports `PARAKEET_MODEL=...v2` (English-only). The user wants non-English kept local, which needs v3. `.zshenv` was left untouched. |
| **B18: token grouping mirrors the engine's `analyze.py` `load_words`** | So that app-made and engine-made transcripts of the same clip agree. Codex's grouping glued `for$20,000` together. |
| **B18: silent clips are empty transcripts; raw parakeet JSON is not kept** | These were the baton's suggested answers, applied when the user asked to finish all plans. Both are recorded in the plan doc. |
| **Dropped Codex's "missing `transcribe` subcommand" finding** | It was wrong: real runs with the exact arguments succeeded (5/5 files, plus a 40-minute file). |
| **Kept the weighted-mean word confidence (engine uses the minimum)** | The plan specifies the weighted mean, and nothing reads the field. |

## Changes Made

| Change | Detail |
|--------|--------|
| **Library refresh** | `build_buckets.py` (351 clips, 702 transcripts), then a thumbs job: 344 generated, 0 failed. |
| **B6 + B21 merged** | `08bf45a` (activity log) and `1c213b6` (engine process-group kill). Rebased onto `ba38dd5`, worktrees `../ssc-b6` and `../ssc-b21` removed. |
| **Docs `e15d0b2`** | Board B6/B21 app halves done, B22 added, B21 changelog bullet, Desktop inbox (ingest follow-up results, B6 log format, B21 engine half). |
| **B6 follow-up `2e24ba0`** | Library and clip deletes are logged. Strict ISO-8601 timestamp check (rejects `"0"`, Feb 30, no timezone). A Library delete lists only files actually removed. The contract now requires a Z or an offset. |
| **B22 `b7da550`** | `/people` "Hide named clusters" toggle (localStorage, unnamed count). `PersonGrid` search matches names, with `_` matching a space. |
| **Collapsible groups `d349499`** | `PersonGrid` group buttons sit in a `<details>` headed "Groups · N" (or "N of M" while searching), remembered in localStorage. |
| **Speaker review applied** | `wordbank.py` (351 clips, 311,567 words, 220,502 on screen), then `build_buckets.py`. |
| **B18 plan update `89f869b`** | Recorded the user's answer: non-English stays local. |
| **B12 `470f456`** | `pipelines/sentence.ts` rebuilt as an engine adapter (check → render → qa); new `/sentence` controls; cast picker in a `<dialog>`; JobPanel cannot-build view; job media mapping; `/api/films` filter; activity results. Implemented by Codex in `../ssc-b12`, then fixed here. Board start commit `89dd4bb`. |
| **B18 `b877065`** | `transcribe.ts`: local parakeet by default, per-file xAI fallback, atomic writes, engine-identical grouping, NaN-tolerant parsing, explicit model. `engine.ts`: shared `runDetachedProcess`, `runEngine` on top of it. Library Engine column, JobPanel engine line, `/transcribe` copy. Implemented by Codex in `../ssc-b18`, then fixed here. Board start commit `4bde32a`. |
| **CLAUDE.md `c754d07`** | New env vars, parakeet dependency, and the `sentence`/`runDetachedProcess` notes. |
| **Baton** | `.baton/2026-10-16-post-ingest-merges-b12.md` and `.baton/2026-10-16-artifacts/` deleted after the work landed. |

## Testing / Research Performed

- **`npm run check`:** 0 errors, 0 warnings after every change, on main and in each worktree.
- **Codex review passes (`gpt-5.6-luna`, high):**
  - B6: 1
  - B22 and its fixes: 3, the last SHIP
  - B12: 3, the last SHIP
  - B18: 3, the last SHIP

  Findings were checked against the code before acting. One was dropped as false; one was kept by design (both are listed under Key Decisions).
- **B6:** the timestamp validator was tested with a `tsx` script against valid, invalid and offset forms.
- **B22 and the collapsible groups, in the browser (:5180):**
  - name search (`noah`, `trevor noah`, `trevor_noah`);
  - the toggle (4027 → 3717 tiles) and localStorage;
  - group-pick unhiding and selection pruning;
  - both themes, and no console errors.
- **B12, against the real engine on a throwaway :5199 server:**
  - API: 400s for a bad `cast`, a bad `draft` and an empty sentence.
  - Cannot-build: shows the engine's per-word reasons.
  - Renders: an auto-cast draft, an explicit-cast final with QA, an auto final, and a long sentence (2 takes, one person). All served 206 range responses.
  - Cast effect: with `tom_hanks` as cast, "the" went from 7,246 to 60 takes by the cast.
  - Cancel mid-render: the job is `cancelled`; no engine processes, film copies or temp dirs left.
  - Both themes checked in the browser.
- **B18, on :5199 with a scratch bucket (4 clips plus a silent one):**
  - transcribe-all: 5/5 local in 6 s, readable logs.
  - transcribe-one: works, and records the `model` field.
  - Cancel of a 40-minute file: no parakeet process, partial transcript, temp file or temp dir left, and no fallback attempted.
  - Full 40-minute run: 22.2 s (about 109× real time).
  - Missing binary: per-file fallback that stops at a clear missing-key error.
  - Library Engine column (including `unknown`), JobPanel engine line and `/transcribe` copy, in both themes.
  - Engine sentence render and cancel re-checked through the refactored `runEngine`.
- **B18 grouping against the engine:** every raw transcript in `TH_ENGINE_DIR/transcripts/` was compared with `words/`. 350 of 351 clips match exactly: 0 text and 0 timing mismatches. The one difference, `c283`, is the engine dropping Cyrillic words.
- **Not run:** the plan's xAI comparison. No `XAI_API_KEY` is available (shell, local `.env` and `SYNTAX_REPO_DIR` all checked).

## Summary Statistics

- Commits on `main` this session: 10 new (`e15d0b2`, `2e24ba0`, `b7da550`, `d349499`, `89dd4bb`, `89f869b`, `470f456`, `4bde32a`, `b877065`, `c754d07`), plus 2 branch commits rebased and fast-forwarded (`08bf45a`, `1c213b6`).
- `main` is 16 commits ahead of `origin/main`; none are pushed.
- Board tasks completed: B12, B18, B22. B6 and B21 app halves merged.
- Codex runs: 2 implementations (B12, B18) and 10 review passes.
- Worktrees created and removed: 2 (`ssc-b12`, `ssc-b18`); 2 more removed (`ssc-b6`, `ssc-b21`).

## Discoveries / Handoff Notes

- **`~/.zshenv` exports `PARAKEET_MODEL=mlx-community/parakeet-tdt-0.6b-v2`** (English-only), and the engine ingest inherits it. The app now ignores it. Whether the ingest should move to v3 is for Desktop and the user; it's in Desktop's inbox.
- **Engine `analyze.py` `norm()` is ASCII-only**, so non-Latin words merge into their neighbours (`c283`: 33 raw words become 8). Noted for Desktop.
- **Parakeet writes bare `NaN`** (a sentence confidence in `c242.json`), which JS `JSON.parse` rejects.
- **Engine `render` breaks on an apostrophe in the film name**, and **`qa` only takes `--name`**. Both are noted for Desktop; a `qa --film` option would remove the QA copy.
- **The machine sleeping stretched `wordbank.py` to 1h42m wall time** for 4.5 minutes of CPU. Background processes survived `/exit`, but their completion notices didn't reach the resumed session; `kill -0` watchers stood in.
- **Read-only Codex reviews miss runtime bugs.** B12's apostrophe and QA failures were found only by running the engine, and B18's grouping bug only by comparing against the engine.
- **My test script's `post()` called `urlopen` twice**, so each B12 case ran as two concurrent jobs. Both succeeded, which also showed the unique film names hold up under concurrency. The doubled activity entries are from that, not an app bug.
- **The user is already naming the new c180–c351 clusters** (activity log: `colbert` → `c186/3`), which settles the "wait for B2" question.

## Current State

- `main` at `c754d07`, clean working tree, 16 commits ahead of `origin/main`.
- Dev servers on :5180 and :5190 are running and serve `/`, `/transcribe` and `/sentence` (checked after the B18 merge).
- No worktrees besides the main checkout. The branch `desktop-inbox-2` exists, predates this session, and was left alone.
- The scratch test bucket and test videos are under the session scratchpad only.
- Test renders from B12 (`sentence-*.mp4` and `.plan.json`) remain in `TH_ENGINE_DIR/films/out/`.

## Unfinished Work

None of this session's tasks or plans remain open. Items left for other people:
- **The user:** push `main` (`git push origin main`).
- **Desktop (inbox items written this session):**
  - B6 engine half (`engine_cli.py` appending `actor: "desktop"`);
  - B21 engine half (forward SIGTERM in `stream()`);
  - `qa --film`;
  - the apostrophe render bug;
  - the ASCII-only `norm()`;
  - deciding the ingest's parakeet model with the user.
- **Optional:** the B18 xAI timing comparison, if an `XAI_API_KEY` becomes available. The method is in `docs/plans/b18-local-parakeet.md` section 4.
