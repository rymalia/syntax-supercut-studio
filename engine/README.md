# Talking-heads engine (snapshot)

Versioned copy of the Python engine that `docs/ENGINE_CONTRACT.md` describes. The **live** copy — with its data
(clips.tsv, audio/, transcripts/, faces/, asd/, words/, identities/, phrases/, films/) — lives outside this repo at
`~/ResolveScripts/talking_heads/` (`TH_ENGINE_DIR`). Copy files from here to there to deploy a change; the app only ever
calls `engine_cli.py` in the live directory.

| file | role |
|---|---|
| `engine_cli.py` | JSON command-line face the app drives (people, grep, check, plan, render, qa, ingest, stats) |
| `supercut2.py` | the v2 engine: person-bound casting, phrase-run solver, lag-corrected cuts, cross-fades, loudness, bed, push-in, captions, VideoToolbox |
| `verify2.py` | Whisper ear check per take / per line, blacklists takes that aren't heard |
| `qa_film2.py` | cold full-film transcription gate + per-line diff + acoustic report + contact sheet |
| `analyze.py`, `wordbank.py` | parakeet words × Vision faces × Light-ASD/LR-ASD → on-screen word bank |
| `asd_run.py` | active-speaker scoring per face track (runs on MPS) |
| `identities.py` | facenet embeddings per track, split at shot changes, clustered per clip → castable people |
| `phrasebank.py` | per-person inventory of on-camera phrase runs; `--grep` |
| `ingest_all.sh` | one-command incremental ingest: `ingest_new.sh` → `identities.py` (new ids) → `phrasebank.py` → `build_buckets.py` |
| `ingest_new.sh`, `build2.sh` | incremental ingest of new source clips; ear-check → render → QA for a film |
| `build_buckets.py` | writes the app's `talking-heads` (all words) and `talking-heads-onscreen` (on-screen words, `\|` gap tokens) buckets from `words/`; idempotent |
| `people.json`, `clipcrop.json` | named groups of person ids; per-clip pane rules (split-screen sources) |
| `faces.swift` | Apple Vision face/landmark pass (compiled to `faces_bin`) |

Requirements on the Mac: ffmpeg (Homebrew, with libass and VideoToolbox), parakeet-mlx, whisper.cpp (`whisper-server` on :8178),
the `asd/.venv` (numpy, scipy, torch with MPS, opencv, facenet-pytorch), Light-ASD and LR-ASD checkouts with weights.
