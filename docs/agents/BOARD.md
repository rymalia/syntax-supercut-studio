# Agent board

Shared task board for the two agents working on this project. Claim a task by setting **Owner** and **Status** in one commit; Ryan reprioritizes by editing rows. Status: todo / doing / review / done. Owners: desktop / code / ryan.

Each agent reads this file and its inbox (`docs/agents/inbox/<agent>.md`) at the start of every turn, and never edits files another owner has in `doing` without an inbox note.

| ID | Task | Owner | Status | Blocked by | Notes |
| --- | --- | --- | --- | --- | --- |
| B1 | `/people` "name this cluster" writes `people.json` | code | done | | `POST /api/engine/people/names {version, ids, name}` (name null = remove); `GET /api/engine/people` adds `names_version`; 409 on stale version |
| B2 | Stable cluster ids in `identities.py` | desktop | todo | | re-run all 179 clips (~1 h GPU) |
| B3 | `engine_cli.py ingest --dry-run` (lists new sources, no work) | desktop | todo | | |
| B4 | "Check for new sources" button + count on `/ingest` | code | todo | B3 | |
| B5 | `thumbs` job kind; `ingest_all.sh` already POSTs it | code | done | | `POST /api/jobs {kind:"thumbs", buckets?}`; first run warmed all 358 strips in 60 s, re-run 0.01 s; light theme checked |
| B6 | `activity.jsonl` written by `jobs.ts` and `engine_cli.py`; last-20 panel on Library | code+desktop | app half done | | line format: `{ts, actor, action, target, result}` (see contract, Activity log); Library shows 5 with a toggle; engine half (`engine_cli.py` appends `actor: "desktop"`) open |
| B7 | `notes` fields on films and people, editable in UI | code | todo | | |
| B8 | Per-word attributes (`onscreen`, `person`, `event`) in transcripts + `hits.ts` filters; retire onscreen bucket | code | todo | B9 | |
| B9 | `build_buckets.py` emits per-word fields | desktop | todo | | 0.1 day |
| B10 | Speaker review page per ingest batch (`review/<batch>/`) | desktop | done | | shipped in this branch; `/review` route in app is B11 |
| B11 | `/review` route reading `review/<batch>/items.json`, writing `decisions.json` | code | done | | `GET /api/review`, `GET`/`PUT /api/review/<batch>`; clips served via `/api/engine-media/review/...`; decisions apply on the next `wordbank.py` + `build_buckets.py` |
| B12 | Retire or re-route `/sentence` through the engine renderer | code | done | | plan `docs/plans/b12-sentence-on-engine.md`; decisions 2026-10-16: one line, no auto-split; BucketPicker removed; seed deferred to desktop; captions + draft replace debug; optional cast; old pipeline deleted. Shipped: check → render → qa via a temp film JSON; qa needs a short-lived copy in `films/` (see desktop inbox) |
| B13 | 30-minute labelled non-verbal event test set | ryan+desktop | todo | | pick 4 clips |
| B14 | Detector stage (AudioSet tagger) in ingest | desktop | todo | B13 | |
| B15 | Typing stage: Qwen3-ASR-Enhanced on MPS, fallback laughter-Whisper | desktop | todo | B14 | MPS viability test first |
| B16 | Events as tokens through phrase bank, buckets, solver, renderer | desktop | todo | B15 | |
| B17 | VideoToolbox encodes for app renders (measure vs x264 first) | code | todo | | proposed by code |
| B18 | Local parakeet-mlx as default transcription in app, xAI fallback | code | done | | plan `docs/plans/b18-local-parakeet.md`; non-English stays local (v3 is multilingual); silent clips are valid empty transcripts; raw parakeet JSON not kept. Results in the plan; xAI comparison not run (no key) |
| B19 | Remote Control test for live agent messaging | ryan | todo | | 5 min |
| B20 | `-hwaccel videotoolbox` decode for thumbnail strips, then raise strip concurrency | code | todo | | most sources are AV1; M4 Max decodes AV1 in hardware |
| B21 | Cancelling an ingest/render kills the whole engine process tree (app: own process group + group kill; engine: forward SIGTERM in `stream()`) | code+desktop | app half done | | app: detached spawn, group SIGTERM, SIGKILL at 10 s, shutdown hook (`1c213b6`); engine half (forward SIGTERM in `stream()`) open; found by Codex review 2026-10-15; today `ingest_new.sh`, ffmpeg and ASD workers keep running after cancel |
| B22 | `/people` toggle to hide clusters that already have a name, to narrow down the ones left to identify | code | done | | requested by ryan 2026-10-16; toggle remembered in localStorage, unticks hidden clusters; people search also matches names (`_` = space) |
| B23 | Editor export: `engine_cli.py export --plan/--cuts` → FCPXML + SRT on the original sources; cut list v1 in the contract | desktop | done | | verified in Resolve 21 free on The Briefing (48 items) and a supercut-style timeline with a speed-matched 2-up tile; every sentence/film render already exports via `--plan` |
| B24 | Supercut writes `<render>.cuts.json` (cut list v1) beside each render: solo hits and tiles (rect, speed) | code | done | | spec + tile mapping in the contract's Cut list section; renders made before this can't be exported (hits are shuffled and discarded today) |
| B25 | "Export for Resolve" on `/clips` and in JobPanel for supercut + sentence renders: runs `export`, downloads `.fcpxml` (+ `.srt`) | code | done | | sentence: `--plan <name>` from the job's `plan` path works now; Ryan chose a download, not a live push. Shipped: `POST /api/export {bucket, file} | {plan}`; JobPanel also covers `film-render`; the `.fcpxml` downloads on click, `.srt` is a link |
| B26 | Faster supercut/songify renders: shared render module, parallel segments, join without a second video encode | code | done | | plan `docs/plans/b26-render-speedup.md`; verified by an A/B harness against the old pipeline plus a synthetic absolute-sync test |
| B27 | Supercut/songify hits from the engine (person-aware, ASD), optional cast filter | code | doing | | plan `docs/plans/b27-engine-hits.md`: the app matches, a new engine `attribute` command (written by code with Ryan's OK) attributes person/on-screen/cast; alternative to B8 |
| B28 | "Engine renders" list (films/out) with play + Export for Resolve | code | todo | | sentence/film renders are only exportable while their job is in memory |
