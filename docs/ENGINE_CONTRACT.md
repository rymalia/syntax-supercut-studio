# Talking-heads engine ↔ Supercut Studio contract

The engine lives outside this repo at `~/ResolveScripts/talking_heads/` (Python; numpy, torch/MPS, parakeet-mlx, whisper.cpp).
The app talks to it only through `engine_cli.py`. Configure the location with `TH_ENGINE_DIR` (default
`~/ResolveScripts/talking_heads`); the interpreter is `<TH_ENGINE_DIR>/asd/.venv/bin/python`.

```
<python> <TH_ENGINE_DIR>/engine_cli.py <command> [options]
```

## Stream protocol
stdout, one record per line, in order:
- `LOG <text>` — progress / log line → forward to the job's `onLog`.
- `RESULT <json>` — exactly once, the last line. `{"ok": true, ...}` or `{"ok": false, "error": "..."}`.
Exit code 0 on success, 1 on failure. stderr is noise (library warnings); keep the last ~40 lines for error display.
Long commands (`render`, `ingest`, `qa`) must honour the job `AbortSignal`: kill the child process (SIGTERM) → mark job cancelled.
On SIGTERM `engine_cli.py` stops its children (when it leads its own process group, as the app spawns it, it signals the whole
group, so ffmpeg and ingest workers stop too), prints `RESULT {"ok": false, "error": "cancelled"}` and exits 143.

## Commands

| command | args | RESULT (ok) |
|---|---|---|
| `people` | — | `{people: [{id, clip, clip_name, seconds, words, thumb, thumb_index}], names: {<name>: [ids]}, thumb_tile: 160, thumb_per_row: 8}` — `thumb` is a path relative to `TH_ENGINE_DIR` (a strip of 160×160 tiles, 8 per row; the tile for this person is at `thumb_index`, i.e. x = (idx % 8)·160, y = floor(idx / 8)·160). `names` is `people.json` (named groups of ids). |
| `grep --q "<phrase>" [--limit N]` | sub-phrase search | `{query, count, hits: [{person, clip, clip_name, start, end, asd, final, words, text}]}` — `text` is the whole run containing the phrase. |
| `check --film <path>` | film JSON path | `{name, lines: [{line, speaker, text, ok, takes?: [{clip, person, in, out, said, asd, fallback}], why?}], film: {ok, snippets?, lines?, takes_per_line?, persons?, why?}}` — per-line buildability on its own plus the whole-film solve (which also binds one person per speaker). |
| `plan --film <path> [--sheet]` | | `{name, plan, snippets: [...], lines, takes_per_line, persons, speech_seconds, sheet?}` — `plan`/`sheet` are absolute paths under `<TH_ENGINE_DIR>/films/out/`. A plan-only run writes `<name>.planned.json`; `<name>.plan.json` is only ever written by `render` (it carries each take's timeline position `t`), so planning never invalidates a rendered film's export. |
| `render --film <path> [--draft]` | | `{name, outFile, plan, snippets, lines, takes_per_line, persons}` — `outFile` is the absolute mp4 path under `<TH_ENGINE_DIR>/films/out/`. LOG lines `progress i/n ...` while snippets render. |
| `qa (--name <name> \| --film <path>) [--no-sheet]` | after render; `--film` reads the film JSON from that path (name = its basename), so a temp film needs no copy in `films/` | the QA record: `{name, cold, heard, total, ghosts, gate, missed, line_match, line_total, report: [..], acoustic: {...}, sheets: [paths]}`. |
| `ingest` | — | `{clips, new_identities, buckets, review_batch}` where `buckets` is whether the Library bucket refresh succeeded and `review_batch` is the successful `<first>-<last>` speaker-review batch or `null` — long (minutes to an hour); streams LOG. Processes any media in `~/Downloads/talking-heads-videos` not yet in `clips.tsv`, then refreshes buckets and builds a review batch for clips added in this run (both post-ingest steps are tolerated if they fail). |
| `export (--plan <name> \| --cuts <path>) [--out <dir>]` | an engine render's `films/out/<name>.plan.json`, or a cut list (below) | `{fcpxml, srt?, fps, frames, clips, sources}`: absolute paths of an FCPXML 1.10 timeline that references the **original source files** (for DaVinci Resolve's File › Import › Timeline, or Final Cut) and an `.srt` of the captions when there are any. `--out` defaults to `films/out/`. With `--plan` the converted cut list is also written as `<out>/<name>.cuts.json` (RESULT `cuts`); a plan-only `<name>.planned.json` exports too (positions derived as `render` would lay them out). Back-to-back picture items on one track are trimmed to end where the next begins (frame snapping used to overlap them by 1–2 frames); overlapping audio (engine cross-fades) moves to the next audio track instead (a checkerboard), with later tracks such as music shifted up. |
| `stats` | — | `{people: [{person, words, runs4, longest, clip_name}]}` ranked by admissible on-screen words. |

## Film JSON (what the `/film` editor saves to `<TH_ENGINE_DIR>/films/<slug>.json`)
```json
{"title": "The Review", "subtitle": "an annual evaluation", "pause": 0.5,
 "bed": "roomtone" | "/abs/path/music.mp3", "bed_db": -33,
 "cast": {"JORDAN": ["c93/1"], "CONAN": ["c93/2"]},        // dialogue: speaker -> person ids or people.json names
 "cast": ["c33/0"],                                          // monologue form (either form; "*" key also works)
 "avoid": ["c02"], "captions": true, "caption_pos": "top", "speaker_labels": true,
 "lines": [{"speaker": "JORDAN", "text": "I feel that there's been an alteration.", "caption": "optional override",
            "pause": 0.6, "cast": ["c93/1"], "only": true, "avoid": ["c02"]}]}
```
Rules the engine enforces (the UI should explain them when `check` says a line can't be built): every take ≥ 2 words and ≥ 0.45 s
(a one-word line must be a complete utterance in the source), ≤ 2 takes per line (3 over 8 words), one person per line,
one person per speaker for the whole film, takes must be on-screen, loud enough, face large enough, no shot change inside.

## Media the UI needs to serve from `TH_ENGINE_DIR`
- `identities/<clip>.jpg` thumbnails strips; `films/out/<name>.mp4|.plan.jpg|.sheet*.jpg`; `proxy/<clip>.mp4` (640 px, 10 fps) for previews.
Add a second media root for these (read-only, same path-traversal guard as buckets).

## Montage (their supercut mode) on our data
Transcripts for the engine's clips are mirrored into the buckets `talking-heads` (all words) and `talking-heads-onscreen`
(on-screen words only, with `|` separator tokens where words were removed). Existing `supercut`/`sentence` jobs keep working on them.

## Activity log

The shared append-only activity log is `<TH_ENGINE_DIR>/activity.jsonl`. Each write is one JSON object on one line:
`{"ts":"<ISO-8601 with Z or offset>","actor":"app|desktop|code","action":"...","target":"...","result":"..."}`.
The app writes `actor: "app"`; `engine_cli.py` appends `actor: "desktop"` lines for `plan`, `render`, `qa`, `export` and
`ingest` runs the app did not start (its parent isn't node, and `TH_ACTOR` isn't `app`), so app jobs are never logged twice;
`result` is a short summary (output file, `heard n/m`, `cancelled`, `error: ...`). Other code may use `actor: "code"`.
Writers append without rewriting the file, and readers skip malformed lines.

## Cut list v1 (edit decisions for `export`)

What an edit is made of, so it can be rebuilt in an editor from the sources. The app's supercut writes one per render as
`<render>.cuts.json` beside the mp4; the engine derives one from a plan. Times are seconds, paths absolute (resolve
bucket symlinks to their targets), the order of `clips` doesn't matter.

```json
{"version": 1, "name": "i-dont-know-supercut-talking-heads-20261021-153000", "origin": "supercut",
 "fps": null, "width": 1920, "height": 1080,
 "clips": [
   {"media": "av", "track": 1, "rec": 0.0, "src": "/Users/rymalia/Downloads/talking-heads-videos/....mp4",
    "in": 12.30, "out": 12.94, "speed": 1.0, "rect": null, "crop": null,
    "gain_db": 0, "fade_in": 0, "fade_out": 0, "freeze": 0, "clip": "c04", "name": "I don't know"}],
 "captions": [{"start": 0.0, "end": 0.64, "text": "I don't know"}],
 "markers": [{"t": 0.0, "name": "hit 1/103", "note": "c04 12.30"}]}
```

- `media`: `av` (picture + its own audio), `v` (picture only), `a` (audio only). `track`: V1/A1 = 1. V1 is the main storyline;
  every other item is attached to the V1 item (or gap) under its start.
- `rec`: timeline position. `in`/`out`: source range. `speed`: 1.25 plays 1.25 s of source per second; the item lasts
  `(out-in)/speed + freeze`. `freeze`: seconds of held last frame.
- `rect` `[x,y,w,h]`: where the picture sits, as fractions of the frame; the source window is fitted inside (tiles).
  `crop` `[x,y,w,h]`: the source window, as fractions of the source (push-in, split-screen pane). Both null = full frame, fit.
- `gain_db`, `fade_in`, `fade_out`: audio. `fps` null = the most-used source rate (duration-weighted); else `"23.976"`, `"25"`,
  `"29.97"`, `"30"`, ... .
- The exporter snaps to frames: source in floors to a source frame, durations ceil to a timeline frame (no clipped words).

How it lands in DaVinci Resolve 21 (free), verified 2026-10-21 by importing into a scratch project and reading every item
back through the scripting API plus stills compared with the engine's render:
- Source ranges are frame-exact; VP9 and AV1 sources import (no transcode); paths with `'` and full-width `｜` relink.
- Picture is on V2 upward (V1 stays empty: the FCPXML spine is one gap that every item hangs off, the one form Resolve and
  FCP read the same way). Audio: A1 = dialogue, then music.
- Zoom/pan/crop (push-in, tiles) match the engine's framing; per-take gain lands as AudioVolume; speed changes and freezes
  (a freeze = the last frame at 2% speed) are exact. Captions come as an `.srt` for File › Import › Subtitle.
- Resolve ignores `srcEnable`, honours a `timeMap` only on `asset-clip`, and reads a `<video>` child's offset as absolute, so
  the emitter uses asset-clips everywhere (picture-only via a `hasAudio="0"` twin asset) and `<audio>` for audio-only.

Supercut mapping: a solo hit = one `av` item at `[hit.start, hit.end]`. A tile of n hits = n `av` items at the same `rec`,
tracks 1..n, `rect` = the tile cell from `gridFor(n)` (centred like the render's `pad`), `speed` = the render's per-hit
speed, all lasting the tile duration.
