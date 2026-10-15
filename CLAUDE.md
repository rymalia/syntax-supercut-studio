# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm install
npm run dev        # Vite dev server on http://localhost:5180
npm run check      # svelte-kit sync + svelte-check (the only static check; no linter)
npm run build && node build   # production build via adapter-node
```

There is no test suite. Verify changes with `npm run check` and by running a job through the UI (or `POST /api/jobs`) against real media.

External runtime deps: `ffmpeg` on `PATH` (all rendering), `aubiopitch` on `PATH` (`/songify`), `XAI_API_KEY` (`/transcribe` STT and `/api/regex-suggest`). Requires Node 22+.

## Environment

- `SYNTAX_BUCKETS_DIR` — bucket root (default `./videos`, gitignored; holds tens of GB of local media).
- `SYNTAX_REPO_DIR` — `src/hooks.server.ts` hydrates any *unset* env vars from `<this>/.env` (default `../syntax-transcripts-2026/.env`) at boot. Local `.env` wins.
- `DRAWTEXT_FONT` — font for debug text overlays; defaults to a macOS-only path (`/System/Library/Fonts/Supplemental/Arial Black.ttf`).

## Architecture

SvelteKit (Svelte 5 runes) single-user local app. All heavy work is server-side under `src/lib/server/`.

**Buckets** (`src/lib/server/paths.ts`): each direct child of `BUCKETS_ROOT` with a `videos/` subdir is a bucket containing `videos/` (source media), `transcripts/` (`<slug>.json` word-level STT), `supercuts/` (renders). A transcript pairs with a video by matching basename (`<slug>.json` ↔ `<slug>.<video-ext>`); transcripts without a matching video are skipped. `resolveBuckets(names)` returns all buckets for empty/null input and throws on unknown names. `bucketForPath` is the path-traversal guard used for media serving — only `videos/` and `supercuts/` are servable.

**Job flow** (the core pattern spanning several files):
1. A page `POST`s `{ kind, ...params, buckets }` to `src/routes/api/jobs/+server.ts`, which validates and calls a `start*` function in `src/lib/server/jobs.ts`.
2. `jobs.ts` stores the job in an in-memory `Map` (lost on restart; outputs persist on disk), creates an `AbortController`, and runs the pipeline in the background with `(onLog, signal)`.
3. Pipelines in `src/lib/server/pipelines/` (`supercut`, `sentence`, `songify`, `transcribe`) stream progress through `onLog` and must honor `signal` — use `runFfmpeg(args, onLog, signal)` and `throwIfAborted(signal)` from `ffmpeg.ts`. A thrown `CancelledError` marks the job `cancelled` rather than `error`.
4. `src/lib/JobPanel.svelte` polls `GET /api/jobs/[id]` (~1s) and cancels via `DELETE`. The GET derives a `mediaUrl` from `result.outFile` when that path lies inside a bucket — so pipelines that produce a video should return an absolute `outFile`.

Adding a new job kind means touching: the pipeline module, the `JobKind`/`Job` union and a `start*` in `jobs.ts`, a `case` in `api/jobs/+server.ts`, and a route page.

**Shared render helpers**:
- `hits.ts` `collectHits` — scans transcripts for a phrase (token-wise match after `text.ts` `normalize`) or a regex (matched against words joined by single spaces, then mapped back to word timings). Used by supercut, sentence, songify.
- `drawtext.ts` — ffmpeg `drawtext` filter for debug overlays; its quoting follows ffmpeg's `av_get_token` rules (see comments; a past bug fix was here).
- `ffmpeg.ts` `atempoChain` — chains `atempo` stages since each is limited to 0.5–2.0.

**Render outputs**: pipelines write to the *first selected* bucket's `supercuts/`, using a `.tmp-<...>-<ts>` work dir inside it that's removed in `finally`. Filenames include a `timestampSuffix()` (avoids overwrite and browser cache staleness) and the bucket name, or `mixed` for multi-bucket renders. Songify's pitch cache is `.pitch-cache.json` beside the bucket root.

**Media serving**: `api/media/[bucket]/[kind]/[name]` supports `Range` requests so `<video>` can seek.

## Style

Design tokens and reusable classes live in `src/app.css`. Palette: `--bg` white, `--ink` near-black, single `--accent: #D0FE03`. Fonts: Unbounded (main), JetBrains Mono (logs/code). Separate sections with whitespace or 1px rules; status indicators are outlined/filled squares, not colored pills. The log panel is the primary inverted surface (black bg, accent text).
