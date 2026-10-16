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

## Commands

| command | args | RESULT (ok) |
|---|---|---|
| `people` | — | `{people: [{id, clip, clip_name, seconds, words, thumb, thumb_index}], names: {<name>: [ids]}, thumb_tile: 160, thumb_per_row: 8}` — `thumb` is a path relative to `TH_ENGINE_DIR` (a strip of 160×160 tiles, 8 per row; the tile for this person is at `thumb_index`, i.e. x = (idx % 8)·160, y = floor(idx / 8)·160). `names` is `people.json` (named groups of ids). |
| `grep --q "<phrase>" [--limit N]` | sub-phrase search | `{query, count, hits: [{person, clip, clip_name, start, end, asd, final, words, text}]}` — `text` is the whole run containing the phrase. |
| `check --film <path>` | film JSON path | `{name, lines: [{line, speaker, text, ok, takes?: [{clip, person, in, out, said, asd, fallback}], why?}], film: {ok, snippets?, lines?, takes_per_line?, persons?, why?}}` — per-line buildability on its own plus the whole-film solve (which also binds one person per speaker). |
| `plan --film <path> [--sheet]` | | `{name, plan, snippets: [...], lines, takes_per_line, persons, speech_seconds, sheet?}` — `plan`/`sheet` are absolute paths under `<TH_ENGINE_DIR>/films/out/`. |
| `render --film <path> [--draft]` | | `{name, outFile, plan, snippets, lines, takes_per_line, persons}` — `outFile` is the absolute mp4 path under `<TH_ENGINE_DIR>/films/out/`. LOG lines `progress i/n ...` while snippets render. |
| `qa --name <name> [--no-sheet]` | after render | the QA record: `{name, cold, heard, total, ghosts, gate, missed, line_match, line_total, report: [..], acoustic: {...}, sheets: [paths]}`. |
| `ingest` | — | `{clips, new_identities, buckets, review_batch}` where `buckets` is whether the Library bucket refresh succeeded and `review_batch` is the successful `<first>-<last>` speaker-review batch or `null` — long (minutes to an hour); streams LOG. Processes any media in `~/Downloads/talking-heads-videos` not yet in `clips.tsv`, then refreshes buckets and builds a review batch for clips added in this run (both post-ingest steps are tolerated if they fail). |
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
