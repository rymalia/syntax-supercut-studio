---
session_id: 80dbc1a5-ddc1-4b0c-9e17-6a7fa6291656
date: 2026-10-16
time: "2026-10-15 08:42 PM PDT – 2026-10-16 01:59 AM PDT"
project: syntax-supercut-studio
---

# Session Summary: /people naming, /review, ingest fixes, B21/B6, overnight 172-clip ingest

## Overview

This session picked up the B1 baton and shipped four things to `main`:
- **B1:** naming person clusters on `/people`.
- **B11:** the in-app `/review` route.
- **An ingest fix:** the app's ingest now also rebuilds the Library buckets and the review batch.
- **A `/review` race fix.**

Alongside that, it delegated two more tasks to Codex in separate worktrees, both finished on branches but not merged:
- **B21:** cancelling a job or stopping the server stops all engine work.
- **B6:** the activity log.

The user's 172-clip ingest (c180–c351) ran through the whole session. It finished at 01:12. The review batch was then built and the fixed `engine_cli.py` deployed. The session ended with a baton for the merges, the Library refresh and B12.

## Key Decisions Made

| Decision | Rationale |
|----------|-----------|
| **B1 writes `people.json` with a content-hash version; a stale save gets 409** | Desktop and chat edit the file by hand. Optimistic concurrency stops silent overwrites without a lock they'd have to honor. The hash is re-checked just before the rename, as Codex suggested. |
| **B1 un-naming accepts ids found only in `people.json`** | The user chose to keep this, so stale ids left by an identities re-run (B2) can be cleared from the UI. |
| **B1 keeps insertion order and the engine's 1-space format; an emptied name is dropped** | Desktop's format and acceptance criteria. Digit-only names, which JS reorders, were left alone at the user's choice. |
| **B11 records only touched segments, copying i0/i1/text from `items.json`** | Matches the semantics of Desktop's standalone page and what `wordbank.py` consumes, so the file can't drift from the batch. |
| **Fix the ingest gap in `engine_cli.py` (Desktop's file), not in `jobs.ts`** | The user authorized it. The app talks to the engine only through `engine_cli.py`, so the fix belongs there. It went to the live engine only after the running ingest exited, and only if the live file still matched the old snapshot. |
| **Codex implements in separate worktrees; nothing merges into the main checkout while a job runs** | The user asked to delegate. A merge reloads the dev server's `jobs.ts` and orphans running jobs. |
| **B21: on server shutdown, stop engine work too** | The user's choice after a plain explanation. Ingests are mostly resumable, while an engine left running after a restart risks two ingests overlapping on the same files. |
| **B21: prepend signal listeners; re-raise only when nothing else listens; detached SIGKILL reaper** | Vite uses `process.once('SIGTERM')`, which hides from `listenerCount`. The reaper covers SIGTERM-ignoring workers after the server is gone. |
| **B6 log at `TH_ENGINE_DIR/activity.jsonl`, opened with `O_NOFOLLOW \| O_NONBLOCK`; Library shows 5 entries with a toggle** | Roadmap spec. Codex found symlink and FIFO edge cases. A 20-row table pushed the Library below the fold. |
| **B12: keep the `/sentence` UI and rebuild it on the engine renderer** | The user's decision (they like the UI). The design plan was delegated to Codex first, because engine semantics differ: one person per line, ≤2–3 takes. |

## Changes Made

| Change | Detail |
|--------|--------|
| **B1 (`2f163b2`)** | `src/lib/server/people.ts`, `POST /api/engine/people/names`, `names_version` on `GET /api/engine/people`. `PersonGrid.svelte` gained the `selected`/`onToggle`/`onGroup` props and name labels. `/people` got a naming bar. Board, inbox, changelog. |
| **B11 (`369634d`)** | `src/lib/server/review.ts`, `GET /api/review`, `GET`/`PUT /api/review/[batch]`, the `/review` page, a nav link (tighter nav gap, wordmark `nowrap`), and the `engineMediaPath` allowlist for `review/**/clips`. The save-revision fix is included. |
| **Ingest fix (`7276811`)** | `engine/engine_cli.py` `cmd_ingest` runs `build_buckets.py`, then `review_build.py` for the ids added in that run. RESULT adds `buckets` and `review_batch`. Contract, `/ingest` copy, changelog, B21 board row, `.gitignore` `__pycache__/`. Implemented by Codex. A stray `.pyc` was amended out before any push. |
| **Review race fix (`7f7f74f`)** | `/review` batch buttons are disabled while a save runs. |
| **Live engine** | The fixed `engine_cli.py` was deployed at 01:12:39 by a guarded script. `review/c180-c351/` was built: 10 clips, 30 segments. |
| **B21 (branch `b21-wip`, `7da9658`, not merged)** | `src/lib/server/engine.ts`: detached spawn, process-group SIGTERM, a 250 ms sweep with SIGKILL at 10 s, failed-spawn guard, a globalThis registry, a shutdown hook and a reaper. |
| **B6 (branch `b6-wip`, `0c8d06b`, not merged)** | `activity.ts`, job and edit logging, `GET /api/activity`, the Library panel, the contract's Activity log section, a changelog bullet. |
| **Plans (uncommitted)** | `docs/plans/b18-local-parakeet.md` and `docs/plans/b12-sentence-on-engine.md`, Codex read-only plans. |
| **Memory** | `server-edits-orphan-running-jobs`. |
| **Baton** | `.baton/2026-10-16-post-ingest-merges-b12.md`, plus `.baton/2026-10-16-artifacts/` (watcher scripts, old and new `engine_cli`). The B1 baton was retired. |

## Testing / Research Performed

- **`npm run check`:** 0 errors after every change, on main and in both worktrees.
- **B1:**
  - API: 400 for a bad name, an unknown id, empty ids, a missing version and bad JSON; 409 for a stale version.
  - Live write round-trip: order kept, other entries untouched, an emptied name dropped, the engine still parsed the file, `people.json` restored byte for byte.
  - Browser, both themes: named and un-named a test cluster, and `/film`'s picker showed the group.
  - Codex: 2 passes. Fixed the prototype-key names (reproduced in Node), the pre-rename re-check, and mid-save ticks being wiped.
- **B11:**
  - API: 404 for a missing batch, 400 for a bad name, review clips served as 200 `video/mp4`.
  - UI save changed exactly one verdict in `decisions.json` (verified, then restored). Both themes checked.
  - Codex: 2 passes. The first led to the mid-save revision fix; the second found the batch-switch race, which was fixed without a further pass.
- **Ingest fix:**
  - `py_compile` and `npm run check`, rerun by me.
  - Codex review: no defects in the change. It flagged the cancel orphaning that existed before the change, which became B21.
- **B21:**
  - Fake-engine tests: cancel with normal, SIGTERM-ignoring and file-logging SIGTERM-ignoring workers; cancel after a failed spawn; server exit, SIGINT and SIGTERM; a Vite-style graceful SIGTERM; the reaper (workers alive at 1 s, gone at 12 s).
  - A control run without the hook left workers alive.
  - Codex: 3 passes, the last SHIP.
  - Reproduced that `child.kill()` after a failed spawn signals the caller's own process group.
- **B6:**
  - Smoke test, a bad-timestamp filter, symlink refusal for read and write, a real FIFO that doesn't hang.
  - The Library panel on a throwaway :5199 server, in both themes.
  - Codex: 2 passes. Fixed `O_NOFOLLOW`/fstat, timestamp validation and `O_NONBLOCK`.
- **Ingest monitoring:** progress tracked from engine output files. At exit, all 172 clips had `asd/out_lr` and `words` outputs.
- **Research:**
  - Read Vite's signal handling: `once('SIGTERM')`, no SIGINT handler.
  - Read the engine's `review_build.py`, `review_template.html`, `wordbank.py`, `ingest_all.sh`, `ingest_new.sh` and `engine_cli.py`.

## Summary Statistics

- Commits on main this session: 4 (`2f163b2`, `369634d`, `7276811`, `7f7f74f`). Branch commits: 2 (`7da9658`, `0c8d06b`).
- Board tasks: B1 and B11 done. B6 and B21 (app halves) done on branches. B21 created. B18 and B12 planned.
- Codex runs: 3 implementations (the ingest fix, B21, B6), 2 read-only plans (B18, B12), 10 review passes (B1 2, B11 2, ingest fix 1, B21 3, B6 2).
- Ingest: 172 clips (c180–c351), 21:46 to 01:12 PDT.

## Discoveries / Handoff Notes

- **Editing a module that `jobs.ts` imports, while a job runs, orphans the job from the UI**, because Vite's reload empties the job Map. This happened to tonight's ingest. Saved to memory.
- **The user sometimes runs a second dev server on :5190** from the same checkout. Check both ports before merging server code.
- **The Bash tool's shell is zsh, which doesn't word-split `$var` in loops.** This made my "alive" checks report false negatives once. Use bash scripts or `pgrep`.
- **`child.kill()` when `child.pid` is undefined (a failed spawn) signals the caller's process group.**
- **The app's `/ingest` used to skip `build_buckets.py` and `review_build.py`.** It's fixed now. The c180–c351 clips still need a manual `build_buckets.py` and a thumbs job before they appear in the Library.
- **`review_build.py` picks only the 10 riskiest clips** of a batch, not every clip.

## Current State

- `main` is at `7f7f74f`, 3 commits ahead of `origin/main` (`2f163b2`), and not pushed.
- Uncommitted: `docs/plans/` and this summary.
- Worktrees `../ssc-b21` (`b21-wip`) and `../ssc-b6` (`b6-wip`) each hold one unmerged commit, plus an untracked `.scratch/` and a `node_modules` symlink.
- The user's dev servers on :5180 and :5190 are running.
- The ingest is finished, the live `engine_cli.py` matches the repo, and `review/c180-c351/` exists.

### Unfinished Work

All of this is in `.baton/2026-10-16-post-ingest-merges-b12.md`, in order:
1. Library refresh for c180–c351: run `build_buckets.py` in the engine dir, then `POST /api/jobs {"kind":"thumbs"}`.
2. Merge `b6-wip` and `b21-wip` into main (fast-forward, rebasing b21 in its worktree) when no job is running. Then `npm run check` and remove the worktrees.
3. One docs commit on main: board (B6, B21), the B21 changelog bullet, `docs/plans/`, Desktop inbox notes (B6 format, B21's engine half), and this summary.
4. The user reviews the c180–c351 batch on `/review`. Then `wordbank.py` and `build_buckets.py` apply the verdicts.
5. B12: bring the user the decisions in `docs/plans/b12-sentence-on-engine.md`, then delegate the build.
6. Open decisions for the user:
   - The B18 questions.
   - Whether to name the new clusters before Desktop's B2 (stable cluster ids) lands.
