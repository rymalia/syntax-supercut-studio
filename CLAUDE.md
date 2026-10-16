# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This is a fork of wesbos/syntax-supercut-studio that is no longer sent upstream. Record major user-visible changes in `CHANGELOG.md` (baseline tag: `upstream-baseline`).

## Agent coordination

Two agents work on this project: Claude Code owns the app (this repo's `src/`), Claude Desktop owns the talking-heads engine (`TH_ENGINE_DIR`, the `engine/` snapshot, ingest scripts, film scripts, people naming). The boundary is `docs/ENGINE_CONTRACT.md`; the plan is `docs/Talking Heads × Supercut Studio Assessment and Roadmap.md`.

- At the start of a session, read `docs/agents/BOARD.md` and `docs/agents/inbox/code.md`. Claim a task by setting Owner and Status in the commit that starts it; mark inbox lines `[x]` when handled; write to `docs/agents/inbox/desktop.md` instead of editing `engine/` or the live engine.
- Desktop hands work over as branches made in throwaway worktrees. Before fast-forwarding one: no attribution trailers in its commits, every changed `engine/` file identical to the live copy in `TH_ENGINE_DIR`, and `git merge --ff-only` succeeds.
- The user's dev server runs from this checkout; avoid `git stash` and branch switching while it runs.

## Commands

```sh
npm install
npm run dev        # Vite dev server on http://localhost:5180
npm run check      # svelte-kit sync + svelte-check (the only static check; no linter)
npm run build && node build   # production build via adapter-node
```

There is no test suite. Verify changes with `npm run check` and by running a job through the UI (or `POST /api/jobs`) against real media.

External runtime deps: `ffmpeg` 7+ on `PATH` (all rendering; pipelines use the `-/filter_complex <file>` and `-fps_mode` forms, which ffmpeg 9 requires), `aubiopitch` on `PATH` (`/songify`), `parakeet-mlx` (`/transcribe`, local by default), `XAI_API_KEY` (`/transcribe` fallback and `/api/regex-suggest`). Requires Node 22+.

## Environment

- `SYNTAX_BUCKETS_DIR` — bucket root (default `./videos`, gitignored; holds tens of GB of local media).
- `SYNTAX_REPO_DIR` — `src/hooks.server.ts` hydrates any *unset* env vars from `<this>/.env` (default `../syntax-transcripts-2026/.env`) at boot. Local `.env` wins.
- `DRAWTEXT_FONT` — font for debug text overlays; defaults to a macOS-only path (`/System/Library/Fonts/Supplemental/Arial Black.ttf`).
- `TH_ENGINE_DIR` — live talking-heads engine directory (default `~/ResolveScripts/talking_heads`). See below.
- `SYNTAX_TRANSCRIBE_ENGINE` — transcription engine: `parakeet` (default) or `xai`.
- `PARAKEET_MLX_BIN` — local parakeet-mlx executable (default `~/.local/bin/parakeet-mlx`).
- `SYNTAX_PARAKEET_MODEL` — model passed to parakeet-mlx as `--model` (default `mlx-community/parakeet-tdt-0.6b-v3`, multilingual). The app ignores a shell-wide `PARAKEET_MODEL`.
- `SYNTAX_TRANSCRIBE_FALLBACK` — local transcription fallback: `xai` (default) or `none`.

## Architecture

SvelteKit (Svelte 5 runes) single-user local app. All heavy work is server-side under `src/lib/server/`.

**Buckets** (`src/lib/server/paths.ts`): each direct child of `BUCKETS_ROOT` with a `videos/` subdir is a bucket containing `videos/` (source media), `transcripts/` (`<slug>.json` word-level STT), `supercuts/` (renders), plus a `thumbs/` cache of Library hover strips (`src/lib/server/thumbs.ts`, served by `/api/thumb/[bucket]/[slug]`; regenerated when older than the video). A transcript pairs with a video by matching basename (`<slug>.json` ↔ `<slug>.<video-ext>`); transcripts without a matching video are skipped. `resolveBuckets(names)` returns all buckets for empty/null input and throws on unknown names. `bucketForPath` is the path-traversal guard used for media serving — only `videos/` and `supercuts/` are servable.

**Job flow** (the core pattern spanning several files):
1. A page `POST`s `{ kind, ...params, buckets }` to `src/routes/api/jobs/+server.ts`, which validates and calls a `start*` function in `src/lib/server/jobs.ts`.
2. `jobs.ts` stores the job in an in-memory `Map` (lost on restart; outputs persist on disk), creates an `AbortController`, and runs the pipeline in the background with `(onLog, signal)`.
3. Pipelines in `src/lib/server/pipelines/` (`supercut`, `sentence`, `songify`, `transcribe`) stream progress through `onLog` and must honor `signal` — use `runFfmpeg(args, onLog, signal)` and `throwIfAborted(signal)` from `ffmpeg.ts`. A thrown `CancelledError` marks the job `cancelled` rather than `error`. `sentence` runs on the engine via `runEngine`; other long-lived child processes (parakeet in `transcribe`) go through `engine.ts` `runDetachedProcess`, which owns process-group kill on cancel and shutdown.
4. `src/lib/JobPanel.svelte` polls `GET /api/jobs/[id]` (~1s) and cancels via `DELETE`. The GET derives a `mediaUrl` from `result.outFile` when that path lies inside a bucket — so pipelines that produce a video should return an absolute `outFile`.

Long-running work (render, ingest) goes through this job flow; quick queries may call a pipeline or the engine synchronously from their own route (e.g. `api/engine/check`, `api/engine/grep`). Adding a new job kind means touching: the pipeline module, the `JobKind`/`Job` union and a `start*` in `jobs.ts`, a `case` in `api/jobs/+server.ts`, and a route page.

**Shared render helpers**:
- `hits.ts` `collectHits` — scans transcripts for a phrase (token-wise match after `text.ts` `normalize`) or a regex (matched against words joined by single spaces, then mapped back to word timings). Used by supercut and songify.
- `drawtext.ts` — ffmpeg `drawtext` filter for debug overlays; its quoting follows ffmpeg's `av_get_token` rules (see comments; a past bug fix was here).
- `ffmpeg.ts` `atempoChain` — chains `atempo` stages since each is limited to 0.5–2.0.

**Render outputs**: pipelines write to the *first selected* bucket's `supercuts/`, using a `.tmp-<...>-<ts>` work dir inside it that's removed in `finally`. Filenames include a `timestampSuffix()` (avoids overwrite and browser cache staleness) and the bucket name, or `mixed` for multi-bucket renders. Songify's pitch cache is `.pitch-cache.json` beside the bucket root.

**Media serving**: `api/media/[bucket]/[kind]/[name]` supports `Range` requests so `<video>` can seek.

## Talking-heads engine integration

A separate Python engine (face/active-speaker analysis, person-bound "film" rendering) lives **outside this repo** at `TH_ENGINE_DIR`. The app talks to it only through `engine_cli.py`; `docs/ENGINE_CONTRACT.md` is the authoritative protocol (commands, RESULT shapes, film JSON, casting rules).

- `src/lib/server/engine.ts` `runEngine(args, onLog, signal)` spawns `<TH_ENGINE_DIR>/asd/.venv/bin/python engine_cli.py ...`. stdout lines are `LOG <text>` (→ `onLog`) and exactly one final `RESULT <json>`; success requires exit 0 and `ok: true`. stderr is noise except its last ~40 lines on failure. Abort sends SIGTERM and rejects with `CancelledError`.
- Job kinds `film-plan`, `film-render` (render then `qa`), `ingest` use the standard job flow. `/api/jobs/[id]` maps a `film-render` or `sentence` `outFile` under `films/out/` to an `/api/engine-media/...` URL.
- Film scripts are `<TH_ENGINE_DIR>/films/<slug>.json`; `filmPath()` enforces slug `^[a-z0-9_-]+$`. `PUT /api/films/[slug]` writes via temp file + `rename` so a symlinked target can't redirect the write outside `films/`.
- `/api/engine-media/[...path]` is a second read-only media root limited by `engineMediaPath()` to `identities/`, `proxy/`, `films/out/` (checked before and after `realpath`), with `Range` support.
- UI: `/film` (script editor, casting, check/plan/render), `/people`, `/ingest`.
- `engine/` in this repo is a **versioned snapshot** of the Python engine, not what runs; deploy a change by copying files into `TH_ENGINE_DIR`. Engine requirements (MPS torch, parakeet-mlx, whisper.cpp, Light-ASD/LR-ASD) are listed in `engine/README.md`.

## Style

Design tokens and reusable classes live in `src/app.css`. Use tokens, never hardcoded colors, so both themes work. Palette: `--bg` white, `--ink` near-black, single `--accent: #D0FE03`. Fonts: Unbounded (main), JetBrains Mono (logs/code). Separate sections with whitespace or 1px rules; status indicators are outlined/filled squares, not colored pills. The log panel is the primary inverted surface (black bg, accent text).

**Theming:** light and dark themes switch on `data-theme` on `<html>`, set pre-paint by the inline script in `src/app.html` (localStorage `theme`, else `prefers-color-scheme`); the toggle in `+layout.svelte` has a CSS-driven label. Rules for new UI:
- Text on an `--accent` background uses `--on-accent` (stays dark in both themes), not `--ink`.
- Log panels and video/thumbnail backgrounds use `--well` (always near-black), not `--ink`.
- An accent-filled container with mixed content can re-declare the light tokens locally (see `tr:hover td`).
- Display headings with a `<mark>` overhang their `line-height: 1` box; leave clearance before following text (see `.hero h1`).
