# Agent board

Shared task board for the two agents working on this project. Claim a task by setting **Owner** and **Status** in one commit; Ryan reprioritizes by editing rows. Status: todo / doing / review / done. Owners: desktop / code / ryan.

Each agent reads this file and its inbox (`docs/agents/inbox/<agent>.md`) at the start of every turn, and never edits files another owner has in `doing` without an inbox note.

| ID | Task | Owner | Status | Blocked by | Notes |
| --- | --- | --- | --- | --- | --- |
| B1 | `/people` "name this cluster" writes `people.json` | code | todo | | format in inbox/code.md |
| B2 | Stable cluster ids in `identities.py` | desktop | todo | | re-run all 179 clips (~1 h GPU) |
| B3 | `engine_cli.py ingest --dry-run` (lists new sources, no work) | desktop | todo | | |
| B4 | "Check for new sources" button + count on `/ingest` | code | todo | B3 | |
| B5 | `thumbs` job kind; `ingest_all.sh` already POSTs it | code | doing | | hook landed desktop-side, soft-fails |
| B6 | `activity.jsonl` written by `jobs.ts` and `engine_cli.py`; last-20 panel on Library | code | todo | | line format: `{ts, actor, action, target, result}` |
| B7 | `notes` fields on films and people, editable in UI | code | todo | | |
| B8 | Per-word attributes (`onscreen`, `person`, `event`) in transcripts + `hits.ts` filters; retire onscreen bucket | code | todo | B9 | |
| B9 | `build_buckets.py` emits per-word fields | desktop | todo | | 0.1 day |
| B10 | Speaker review page per ingest batch (`review/<batch>/`) | desktop | done | | shipped in this branch; `/review` route in app is B11 |
| B11 | `/review` route reading `review/<batch>/items.json`, writing `decisions.json` | code | todo | B10 | replaces the standalone page |
| B12 | Retire or re-route `/sentence` through the engine renderer | code | todo | | |
| B13 | 30-minute labelled non-verbal event test set | ryan+desktop | todo | | pick 4 clips |
| B14 | Detector stage (AudioSet tagger) in ingest | desktop | todo | B13 | |
| B15 | Typing stage: Qwen3-ASR-Enhanced on MPS, fallback laughter-Whisper | desktop | todo | B14 | MPS viability test first |
| B16 | Events as tokens through phrase bank, buckets, solver, renderer | desktop | todo | B15 | |
| B17 | VideoToolbox encodes for app renders (measure vs x264 first) | code | todo | | proposed by code |
| B18 | Local parakeet-mlx as default transcription in app, xAI fallback | code | todo | | proposed by code |
| B19 | Remote Control test for live agent messaging | ryan | todo | | 5 min |
