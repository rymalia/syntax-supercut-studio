---
session_id: 8a6fa627-3784-4054-b483-5d42ee6e4ec1
date: 2026-10-22
time: "2026-10-21 10:26 PM PDT – 2026-10-22 12:29 AM PDT"
project: syntax-supercut-studio
---

# Session Summary: B27 (cast and on-screen filters via the engine) and B28 (engine renders on /clips)

## Overview

This session picked up the baton from the B26 session and shipped both of its items:
- **B28:** `/clips` lists the engine's `films/out` renders with play and Export for Resolve.
- **B27:** supercut and songify can be limited to one person or `people.json` group, and to on-screen speech. A new engine command, `attribute`, reports who speaks each hit.

Desktop landed `attribute` in the live engine during the session, and B27 was then rebased onto it and merged. Ryan pushed `main`.

## Key Decisions Made

| Decision | Rationale |
|----------|-----------|
| **App matches, engine attributes** (not hits from `engine_cli.py grep`) | `grep` returns the whole run's times, not the phrase's word times, and only searches the phrase bank. Its `person` came from the bank, which had the misattribution bug, and it has no regex. Keeping matching in `hits.ts` keeps JS regex semantics; Python `re` differs, e.g. `(?<name>…)` is a syntax error. |
| **Code writes the engine command** | Ryan chose this over waiting on Desktop or relaying the spec himself. |
| **Spans carry each word's exact `[start, end, text]`, matched by time + `norm(text)`** | Codex's plan review found 425 zero-length words; a ±5 ms window would pull c108's off-screen zero-length `of` into the neighbouring hit (confirmed by hand). Bucket transcript times equal `words/<cid>.json` on all 351 clips. |
| **With no filter, an engine failure only warns** | Plain supercuts must never depend on the engine. A cancel still propagates. |
| **`attribute` gets its own `mkdtemp` dir** | Neither pipeline has a work dir at that point: supercut's dry run never makes one, and songify makes it after `collectHits`. |
| **Cast in the output filename is slugified** | Person ids contain `/` (`c85/1` → `c85-1`). |
| **Person and ASD go in marker notes, not new cut list fields** | Cut list v1 is unchanged. Songify's pitch text stays in front. |
| **B28 lives on `/clips` (tab + section), not a new route** | The baton's lean. It reuses `ExportForResolve` with `{plan}`. |
| **B28 offers export only when every snippet's `t` is numeric and the plan isn't newer than the mp4** | A plan from `plan` alone lacks `t`, and a plan rewritten after the render may not describe it. |
| **Did not deploy `attribute` into the live engine while Desktop was editing it** | Desktop rewrote the live `engine_cli.py` at 22:42 (B6/B21 halves, `.planned.json`, `qa --film`), and copying the worktree file over it would have wiped that work. Asked Desktop via the inbox (Ryan approved) to fold the command in. |
| **Held the B27 merge until Desktop's branch landed, then rebased and squashed** | Desktop's handoff branches fast-forward. Merging an `engine/engine_cli.py` change first would have broken that, and the filters can't work until `attribute` is live. |
| **Dropped Codex finding: B28 1 s mtime slack** | Plan-only runs now write `.planned.json`, so `.plan.json` is only rewritten by a render. |
| **Dropped Codex finding: CastPicker error hidden in the dialog** | Not reproduced: the error renders in the field, outside the `<dialog>` (seen in the browser). |
| **Left the `/api/engine-media` double decode alone** | It only breaks filenames with a literal `%`, which the engine never writes, and the route is shared. |
| **Songify pitch into Resolve is backlog** | Ryan: not a current priority. Recorded as B31. |

## Changes Made

| Change | Detail |
|--------|--------|
| **B27 plan** `42e8b02` | `docs/plans/b27-engine-hits.md`, revised after Codex validation (REVISE, 5 majors applied); B27 claimed. |
| **B28** `3396380`, `a65ac80` | `src/routes/clips/+page.server.ts`: `listEngineRenders()` lists every `films/out/*.mp4`, drafts included, with `exportable` and `planNewer`. `+page.svelte`: an "engine renders" tab using a NUL-char sentinel (so a bucket named `engine` stays reachable) and a section with hover preview, player, download, and Export for Resolve or the reason it can't export. |
| **B28 docs** `f4aa309` | Changelog entry; board B28 done. |
| **Desktop inbox** `d18a544` | The `attribute` spec and the ask to fold it in; B28 FYI. |
| **B27** `bceaded` | See the bullets below this table. Implemented by Codex in worktree `../ssc-b27`, then fixed here. |
| **Engine `attribute`** | Written on the B27 branch and landed by Desktop in `dca1e2d` (identical code) on top of its `0a18092`, together with the contract row. |
| **Docs** `ede95a1`, `3fe847c` | Board: B27, B6 and B21 done; new B29 (`/sentence` uses `qa --film`), B30 (`/people` rename warning), B31 (songify pitch into Resolve, backlog). Changelog entry for B27. Desktop's 10-22 inbox items marked `[x]`. |
| **Cleanup** | Worktree `../ssc-b27` and branch `b27-engine-hits` removed. Baton `.baton/2026-10-21-b27-b28-engine-hits-and-renders.md` retired. |

B27 (`bceaded`) changed these files:
- `src/lib/server/engine-hits.ts` (new): `attributeHits` runs the engine, applies the filters, and logs speakers with `people.json` names.
- `hits.ts`: hits carry `clip` and their matched words, without `|` tokens.
- `text.ts`: the `Hit` type gains `clip`, `person`, `asd` and `words`.
- `supercut.ts` and `songify.ts`:
  - accept cast and on-screen options;
  - fail with an error naming the filter when it leaves no hits;
  - add the cast slug to the filename;
  - append person and ASD to marker notes;
  - show the person in the debug overlay.
- `jobs.ts` and `api/jobs/+server.ts`: accept and validate `cast` and `onscreen`.
- `src/lib/CastPicker.svelte` (new), extracted from `/sentence`, with `emptyLabel` and `hint` props.
- `/supercut` and `/songify`: the picker, an "On-screen speaker only" checkbox, and a hint.

## Testing / Research Performed

- **`npm run check`:** 0 errors after every change (main and worktree).
- **Engine data checks:**
  - c85 word 100 is identical in the bucket and in `words/c85.json` (1,499 words in each).
  - c108's zero-length off-screen `of` at 107.36 confirmed.
  - 425 zero-length words across the corpus.
  - The live `engine_cli.py` was confirmed equal to the snapshot at the start of the session, and found changed by Desktop later.
- **Shadow engine:** a scratchpad dir symlinking every live entry, with the live `engine_cli.py` plus `attribute` grafted on. It ran 5,145 spans in 1.46 s (linear scan), then 1.07 s (index), all `known`.
- **Throwaway server on :5199** (worktree, shadow engine):
  - "you know" with no filter: 1,522 hits, the same as `main` on :5180.
  - Cast `tom_hanks`: 4 hits.
  - On-screen only: 1,162 hits, equal to the `talking-heads-onscreen` bucket's 1,162.
  - Regex plus cast plus on-screen, and an empty result: clear errors.
  - Regex `\| you know` on the on-screen bucket: 49 of 49 kept after the `|` fix.
- **Real renders** with the asma_khan cast:
  - A tiled debug supercut: the contact sheet showed her in every frame, from c142/1 and c166/1, and the overlay showed the person.
  - A song: markers keep the pitch text plus person and ASD.
  - Both exported via `/api/export` (45 items from 2 sources, and 7 items from 1 source, at 23.976 fps).
- **Browser** (claude-in-chrome):
  - `/clips` engine tab: 32 tiles, 31 with export; `_test_pc` explains why it can't export; the player loaded (38.77 s).
  - Re-checked after the B28 fixes, against an independent Python count (31 of 32).
  - `/supercut`: picking a group fills the tag; the empty label reads "Every speaker".
  - `/sentence` unchanged.
- **Live after the merge on :5180:**
  - "you know" with no filter: 1,522 hits, no warning.
  - "don't be an idiot" with the `tom_hanks` cast: refused, credited to `c85/1 (philip_seymour_hoffman)`.
  - An 8-clip asma_khan on-screen supercut rendered.
- **Codex runs** (gpt-5.6-luna, high):
  - B27 plan validation: REVISE, applied.
  - B27 implementation (mode 4).
  - B27 diff review pass 1: FIX (2 real, 1 not reproduced).
  - B27 review pass 2: FIX (2 minor, fixed).
  - B28 review pass 1: FIX (3 applied, 1 dropped, 1 deferred).
  - B28 review pass 2: SHIP.

## Summary Statistics

- Commits on `main` from this session: 8 (`42e8b02`, `3396380`, `a65ac80`, `f4aa309`, `d18a544`, `bceaded`, `ede95a1`, `3fe847c`). Desktop's `0a18092` and `dca1e2d` were fast-forwarded in by Ryan.
- Board: B27 and B28 done; B6 and B21 marked done; B29, B30 and B31 added.
- Codex runs: 7 (1 plan validation, 1 implementation, 5 reviews).
- Test renders left in `videos/talking-heads/supercuts/`: the asma_khan tiled debug supercut, a song, the live 8-clip supercut, and their cut lists and exports.

## Discoveries / Handoff Notes

- **Desktop works concurrently in the live engine.** Before copying anything into `TH_ENGINE_DIR`, re-run `cmp` against `engine/`. A check done an hour earlier is stale.
- **Shadow engine for testing.** Symlink every live entry except `engine_cli.py`:
  - `HERE` comes from `abspath`, not `realpath`, so data resolves through the links.
  - `people.json` must be a regular-file copy: the app refuses a symlink ("people.json is not a regular file").
  - Delete the `__pycache__` link so bytecode doesn't land in the live dir.
- **`|` tokens:** `talking-heads-onscreen` transcripts insert them, and regex hits can include them. Anything sent to the engine must drop them.
- **`person_of` returns the bare clip id** for null tracks (about 43,000 words) and for clips with no identities. A cast naming a clip id therefore admits off-screen words, which is why the on-screen filter is separate.
- **The phrase-bank misattribution is fixed by Desktop**, so `grep`'s person is now right. `grep`'s other limits (whole runs, bank only, no regex) remain.
- **`_test_pc`:** its `.plan.json` is still the plan-only one written after its mp4. The engine can now export it by deriving `t`, but `/clips` won't offer it; a re-render fixes it.
- **Codex in workspace-write mode can't see the gitignored `videos/`** in a worktree, so it took word times from `words/*.json` instead.
- **A command backgrounded with `&`** instead of `run_in_background` gives no completion notification; check its log by hand.

## Current State

- `main` at `3fe847c`, pushed by Ryan up to `ede95a1` (`3fe847c` and this summary are after his push).
- Untracked:
  - `docs/session-summaries/session-summary-2026-10-21-typesafe-jev-clip-search.md` (from an earlier session);
  - this summary.
- Worktrees: only the main checkout. Desktop's `../.ssc-wt-desk` and its branch `desktop-inbox-fixes` are gone after the merge.
- Dev server :5180 runs the B27 code. :5199 was stopped and the browser tab closed.
- `.baton/2026-10-21-ab-harness/` kept (gitignored).
- The shadow engine dir is in this session's scratchpad.

## Unfinished Work

- **B29:** `/sentence` should run `qa --film <tmp>` and drop its short-lived `films/` copy.
- **B30:** `/people` should warn before renaming or removing a name a film's `cast` uses.
- **B31 (backlog):** songify pitch into Resolve via a script run after import.
- **Optional:** re-render `_test_pc` so `/clips` offers its export. Decide whether to keep this session's test renders in `talking-heads/supercuts/`.
- **Push:** `git push origin main` for `3fe847c` and this summary once it's committed.
