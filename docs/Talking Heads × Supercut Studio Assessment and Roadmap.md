# Talking Heads × Supercut Studio: Assessment and Roadmap

Oct 15, 2026 · @Ryan

## Summary

The two systems are complementary and should stay that way: the talking-heads engine is the only part that knows *who* is speaking on screen and how to cut speech so it sounds like conversation; Supercut Studio is the only part a person can drive without Claude. The engine is strong on output quality (7 v2 films, 88–99% of words heard in a cold Whisper listen, 0 level jumps over 6 dB) and weak on operability (a folder of scripts, JSON files edited by hand, one machine, no tests). The fork is strong on operability (library, buckets, streaming jobs, a clips gallery) and weak on editorial quality (its own sentence mode has the exact single-word failure our v1 had).

Three things matter most over the next few weeks:

1. **Close the self-serve loop.** Dropping a file into `talking-heads-videos` should end with it castable in `/film` without Claude touching anything. Today ingest runs, but naming new people and binding them to film characters is still a Claude-and-JSON step.
2. **Give both agents one shared state.** Chat (this session) and the web app already share the engine files; the Claude Code session and this Desktop session do not share anything but git. A small, file-based coordination contract in the repo fixes that today; direct agent-to-agent messaging is not available between a cloud session and a Mac session yet.
3. **Add non-verbal vocalizations as first-class tokens.** Laughs, sighs, breaths and coughs are what make assembled dialogue feel human, and they are also what the current ASR silently drops. The attached paper and the four resources support a two-stage plan: detect and time the events with an audio tagger, then type them with a laughter-aware ASR, and store them in the same word stream the app already searches.

## The talking-heads engine

The engine (`~/ResolveScripts/talking_heads`, snapshot in the fork's `engine/`) turns a folder of clips into person-aware, phrase-level assembled dialogue. Per clip it produces word timings (parakeet-mlx), face tracks (Apple Vision), two active-speaker scores (Light-ASD, LR-ASD on MPS), identity clusters (facenet), and a phrase bank; per film it solves a script against that corpus and renders with cross-fades, loudness matching, push-ins, captions and a music bed, then QA-listens to its own output with Whisper. Corpus today: 140 clips ingested, 39 more in flight (179 total, about 15 h).

**Strengths**

- Editorial quality is the whole point and it shows. v1 (single words) scored 90% cold-listen with 106 ghost words across nine films; v2 (phrase runs, one person per line, ≤2 takes per line) scores 88–99% with 1.0–1.2 takes per line and no level jumps over 6 dB. Your own listen matched: "best output yet."
- It knows who is on screen. Person binding (`people.json`, identity clusters split at shot changes) is what makes a two-character film coherent. Nothing in Supercut Studio has this.
- Every rule is explicit and measurable: ASR lag (100 ms), min run (≥2 words, ≥0.45 s), end-card guard (last 8 s), shot-change guard, face-height floor, level floor. Each came from a diagnosed failure, and each has a QA that catches regressions (cold transcription, acoustic report, contact sheets).
- Everything runs locally on the M4 Max at a cost of zero per hour of video, with GPU where it counts (ASD and facenet on MPS).
- `engine_cli.py` already exposes it as a clean LOG/RESULT process contract, which is how the fork drives it.

**Weaknesses**

- Operability. It is \~20 scripts and a handful of JSON files; `clipcrop.json` and `people.json` are edited by hand; a new batch needs Claude to name clusters by looking at identity strips. There are no unit tests, so every change is verified by rendering films and listening.
- Casting is still manual. `/people` shows clusters, but binding a cluster to a name and keeping ids stable across re-runs has bitten us once already (cluster ids changed, `people.json` had to be remapped).
- Single-machine, single-process. ASD for a 129-minute podcast ties up the GPU for a long stretch; there is no queue, no resumability beyond "files that exist are skipped," and no way to run on a second machine.
- It transcribes words only. Laughs, breaths and sighs fall through parakeet as silence or as ghost words, which is exactly the texture assembled dialogue is missing.
- Lack of transcript diarization: speaker identity comes from faces, so an off-screen speaker is a hole, and the `talking-heads-onscreen` bucket drops 36% of all words for that reason (63,050 of 99,047).

## The syntax-supercut-studio fork

The fork (`~/projects/syntax-supercut-studio`, `main` at `c0a27da`, 11 commits ahead of `origin/main`, tagged `upstream-baseline` at the fork point) is Wes Bos's local SvelteKit app plus our engine bridge, a dark theme, and ffmpeg 9 fixes. Upstream is unmaintained (last activity \~5 months ago), so it evolves independently and `CHANGELOG.md` is the record.

**Strengths**

- Self-serve shape is right: buckets on disk, a Library that shows what is transcribed, a job panel with streaming logs and cancel, a Clips gallery with playback and delete, dry-run estimates. No Claude in the loop for any of it.
- Montage mode (every hit of a phrase or regex, optionally tiled 2–4-up with tempo matching) is a different product from films and it works on our corpus today ("I don't know": 103 hits all-words, 61 on-screen).
- The job model (`jobs.ts` Map + AbortController + `onLog`) was easy to extend: `film-plan`, `film-render` and `ingest` slotted in without touching the existing pipelines. The Briefing's final render came out of the app's job runner.
- Path safety was done properly: `bucketForPath`, `engineMediaPath` checked before and after `realpath`, `PUT /api/films/[slug]` via temp file + rename.
- `npm run check` is green and Codex reviews run clean; CLAUDE.md documents the architecture and theming rules for the next session.

**Weaknesses**

- Its own sentence mode is our v1: one random clip per word, no person awareness, no loudness matching. Whisper hears "That was a chubby mania fireman" for "I want to be a fireman." It should be retired or routed through our renderer.
- Transcription is cloud-only (xAI STT, `XAI_API_KEY`); our buckets are populated by `build_buckets.py` from parakeet output instead, so the Library's "Transcribe" button is the wrong button for this corpus.
- Jobs live in memory: a server restart loses history, and a long ingest shows nothing after a reload. There is no job persistence and no queue, so two renders contend for the GPU.
- The `engine/` folder is a snapshot, not what runs. A change in one place is invisible in the other until someone copies files. That is a trap for two agents working at once.
- No tests, no linter; verification is `npm run check` plus a real job against real media.
- Two buckets for one corpus (`talking-heads`, `talking-heads-onscreen`) is a workaround for the app having no per-word attributes. Filtering on `onscreen`, `person` or (soon) `event` belongs in `hits.ts`, not in duplicated transcripts.

## The self-serve corpus loop

The loop you want is: drop files in `~/Downloads/talking-heads-videos` → they get ingested → they are searchable, castable and renderable in the app. As of today the first two steps are automatic and the last one is half manual.

| Step | Runs today via | Automatic? | Gap |
| --- | --- | --- | --- |
| Detect new sources | `ingest_new.sh` (diff against `clips.tsv`) | Yes, when triggered | Nothing watches the folder; someone starts it (`/ingest` page, `engine_cli.py ingest`, or Claude) |
| Audio, ASR, faces, ASD, word bank | `ingest_new.sh` | Yes | Serial on one GPU; a 2-hour podcast blocks everything behind it; no progress beyond log lines |
| Identity clusters | `identities.py` (in `ingest_all.sh` since today) | Yes | Cluster ids are per-run; a re-run can renumber and break `people.json` |
| App buckets | `build_buckets.py` (new today) | Yes | Two buckets because the app cannot filter per word |
| Name people | Claude looks at `identities/*.jpg` and edits `people.json` | **No** | `/people` shows strips but has no "name this cluster" action |
| Cast a film | `/film` page or film JSON | Partly | Casting needs named people; new clips are invisible to casting until named |
| Montage / regex supercut | `/supercut` | Yes | Works immediately on the refreshed buckets |

So the minimum to close the loop is a `/people` naming action that writes `people.json` (one route, one dialog), plus stable cluster ids (hash of the clip id and the first face track rather than an enumeration). A folder watcher or a "Check for new sources" button on `/ingest` is the second step. Both are app work the Claude Code session can own.

## Two interaction modes, one state

The web app and chat already read and write the same files (`clips.tsv`, `words/`, `people.json`, `films/*.json`, `films/out/`), so they are more integrated than they look: a film I write in chat appears in `/film`, a render you start in the app lands where my QA scripts find it. What is missing is awareness: neither side knows what the other did or why.

Where each mode is better:

- **Web app**: anything repeatable with a small parameter space. Browse the library, run ingest, grep phrases, montage supercuts, pick a film and press Render, watch logs, play results. Zero-latency, no token cost, works when I am not here.
- **Chat**: anything that needs judgment or a new rule. Writing a script that the corpus can actually say, naming people from strips, diagnosing why a take sounds wrong, adding a guard like the end-card rule, QA listening, deciding a film should be dropped.

Three changes make them aware of each other:

1. **An activity log the app writes and I read.** One append-only `TH_ENGINE_DIR/activity.jsonl` with `{ts, actor, action, target, result}` for every job and edit (actor = `app`, `desktop`, `code`). The app shows the last 20 on the Library page; I read it at the start of a turn instead of asking what you did.
2. **Notes on films and people.** A free-text `notes` field in film JSON and in `people.json` entries, editable in `/film` and `/people`. That is where "Ditka mumbles, ear-check gate advisory" or "c93/1 is Jordan, c93/2 is Conan" lives, visible to both modes.
3. **An "Ask Claude" hand-off from the app.** A button on a film, person, or render that copies a prepared prompt (film slug, the failing line, the QA numbers) to the clipboard, or opens this project with it. It keeps the app dumb and makes the chat side start with the right context, which is the expensive part today.

## Coordinating the Desktop agent and the Claude Code agent

There is no direct channel between this session and your Claude Code session today, so coordination has to go through files both can read. I checked: this session's peer list shows no reachable agents, because peer messaging is per machine and this session runs in Anthropic's cloud while Claude Code runs on your Mac. Claude Code may be able to send one-way messages to cloud sessions when it has cloud access; that is untested and would not give me a way to reply.

&#91;embedded content: agents and shared state · 2 agents, 3 stores\]

The Desktop session reaches the Mac through the device bridge; Claude Code is on the Mac. Everything they have in common is on disk, and the engine's live copy is not in the repo.

**What exists today**

- git on `main` (the only state both agents reliably read).
- `CLAUDE.md` in the repo and `~/.claude/CLAUDE.md` for Code; project memory and the Project docs for Desktop. Neither reads the other's rules unless told to.
- Session summaries in `docs/session-summaries/` (Code) and `~/ResolveScripts/docs/session-summaries/` (Desktop), written after the fact.

**Proposed contract (`docs/agents/` in the fork, versioned)**

1. `BOARD.md`: one task table with columns id, title, owner (`desktop` / `code` / `ryan`), status (`todo` / `doing` / `review` / `done`), blocked-by, notes. Either agent claims a task by setting owner and status in one commit. You reprioritize by editing the table.
2. `inbox/desktop.md` and `inbox/code.md`: append-only messages to the other agent ("engine\_cli `check` now returns `vin`/`vend`; regenerate the TS type"). Each agent reads its inbox at the start of every turn and marks lines handled.
3. `activity.jsonl` (shared with the app, see above): who ran what, when, with what result.
4. A session-start rule in both CLAUDE.md files: read `BOARD.md` and your inbox before any work; claim before you start; never edit the other owner's `doing` files without an inbox note.

**Division of labor that fits each agent**

- Code owns the app: Svelte pages, routes, `hits.ts`, jobs, tests, dark-mode rules, `npm run check`, commits and the changelog.
- Desktop owns the engine and the editorial side: ingest, ASD/identity models, phrase solver, renders, QA listening, film scripts, naming people, and the `engine/` snapshot updates.
- Shared boundary: `docs/ENGINE_CONTRACT.md`. Any change to a `RESULT` shape is an inbox message plus a contract edit in the same commit.
- Delegation from Desktop to Code can also be headless: I can run `claude -p "<task>"` in the repo from the Mac shell and read the result, the way Codex is used now. That covers "do this now" without you relaying it.

If you want the channel to be live rather than file-based, the realistic option is running Claude Code with Remote Control on the Mac; then this session's peer list should show it and `SendMessage` works both ways. Worth a five-minute test before building more on files.

## Non-verbal vocalizations

Yes, these resources are useful, but they split into two jobs and none of them does both: **finding** events with timestamps (where does a laugh start and stop) and **typing** them (laugh vs. sigh vs. cough; genuine vs. polite). The ASR-style models type well and time poorly; the acoustic work times well and does not type. The plan below uses each for what it is good at.

| Resource | What it gives | Runs on the M4 Max? | Use here | Verdict |
| --- | --- | --- | --- | --- |
| [Krepsz et al. 2024, *Cognitive Processing*](https://doi.org/10.1007/s10339-023-01168-8) (attached) | Acoustic profile of involuntary vs. voluntary laughs in real 3-party conversation: involuntary laughs are longer (924 vs 520 ms), higher (f0 352 vs 288 Hz, range 12.6 vs 4.1 semitones), noisier (HNR 6.2 vs 11.0 dB), quieter (64.8 vs 70.4 dB). Logistic regression on those features: 66% accuracy, 73% with label propagation. | n/a (features) | The feature list for a "real laugh" filter once laughs are found | Keep; it is the typing rubric |
| [Ho et al., Interspeech 2025](https://ris.utwente.nl/ws/portalfiles/portal/508310826/ho25b_interspeech.pdf) | Whisper large-v2 and Wav2Vec2 fine-tuned with a `<laugh>` token on Switchboard. Laughter F1 79.0 (Switchboard) and 77.9 (Buckeye, cross-corpus); WER rises from 8.5 to 11.9 when the token is added. No code released. | Via the HF model below | Sets the bar: \~0.78 F1 is what a fine-tuned Whisper achieves on unseen conversational audio | Keep as benchmark |
| [Spink 2024 (MSc thesis)](https://essay.utwente.nl/fileshare/file/104322/Spink_MA_EEMCS.pdf) | Same idea with distil-large-v2 and HuBERT. F1 0.90 on Switchboard but under 0.6 on AMI meetings; Whisper's precision (0.95) is its strength. | n/a | Warns that noisy multi-party audio (our panel shows, bar scenes) will underperform; precision over recall is the right trade for editing | Keep for the evaluation design |
| [truongkp/asr-laughter-whisper](https://huggingface.co/truongkp/asr-laughter-whisper) | The Ho et al. model: Whisper large-v2, \~2B params in F32, English, laughter only. Card has no metrics, no license, and a usage snippet that does not run as written. | Yes with transformers on MPS (slow); conversion to MLX or whisper.cpp is possible but unverified | Laughter typing over candidate windows; also a second opinion on `<laugh>` vs. speech | Try, expect friction |
| [mrfakename/Qwen3-ASR-Enhanced-v0.1](https://huggingface.co/mrfakename/Qwen3-ASR-Enhanced-v0.1) | Qwen3-ASR-1.7B fine-tune that writes `[laughs]`, `[sigh]`, coughs, breaths, throat-clearing, crying inline; Apache-2.0; word timestamps through the base model's forced aligner. Alpha, no metrics, tag set called "unstable" by the author, CUDA in the quickstart. | Unknown: `qwen-asr` is a CUDA/vLLM path; MPS needs testing | The broadest tag set; best candidate for typing all event kinds in one pass | Try first for typing |
| [aubio](https://github.com/aubio/aubio) ([docs](https://aubio.org/documentation)) | Onset detection, pitch (f0), MFCC, notes. Already installed for `/songify`. No HNR, jitter or shimmer. | Yes, today | Event boundaries inside a window (onsets) and the f0 features from the paper; pair with `parselmouth` (Praat) for HNR and intensity | Keep; cheap |

Missing from the list is a **detector**: something that scans all 15 hours and says "laugh at 12:31.4–12:32.6, cough at 40:02.1" without transcribing. Any AudioSet-class tagger does this (classes include Laughter, Giggle, Chuckle, Belly laugh, Snicker, Sigh, Breathing, Cough, Sneeze, Throat clearing, Gasp, Scream); PANNs or AST at 0.1–0.5 s frames run fine on the Mac. The ASR models then only see short candidate windows, which is where their precision is high and their cost is low.

**Proposed pipeline (adds one stage to `ingest_new.sh`)**

1. **Detect**: tagger over `audio/<cid>.wav`, keep frames above threshold for the target classes, merge into events ≥ 150 ms, require no parakeet word overlapping more than 50% (speech-laughs are kept as a separate class, the Interspeech paper shows they confuse every model).
2. **Type**: run Qwen3-ASR-Enhanced (or the laughter Whisper) on each event window ± 0.3 s; take its tag; on disagreement with the tagger keep the event with kind `unknown`.
3. **Profile**: aubio + parselmouth per event: duration, f0 mean and range, HNR, intensity, CoG. Store them; a `genuine` flag uses the paper's thresholds (long, high, noisy, quiet) until we have our own labels.
4. **Attribute**: same ASD and face-height admissibility as words, so an event is bound to a person and marked on-screen or off.
5. **Store** as tokens in `words/<cid>.json` with `w: "[laughs]"`, `kind: "event"`, `event: "laugh"`, plus the profile. Everything downstream (phrase bank, `build_buckets.py`, `hits.ts`, `/stats`) then sees `[laughs]` as a searchable word, and a film line can say `BOSS: [laughs] you're fired.`
6. **Render**: events go through the same snippet path (loudness to −20 dBFS, 40 ms cross-fades), with a longer tail allowance since laughs decay.

**Evaluation before trusting it**: hand-label 30 minutes (two Curb clips, one Good Hang segment, one panel show) with Praat-style intervals, then report F1 per class the way the two papers do. Target ≥ 0.75 F1 on laughs with precision ≥ 0.9; everything else is advisory until it clears that.

## Roadmap

Order is by what unblocks the most: the loop first (it removes me from the daily path), shared state second (it makes two agents safe), events third (it needs a labelled test set before it can be judged).

&#91;embedded content: roadmap · 3 phases, 3 gates\]

Each gate is observable in the app, not in a log.

| Task | Owner | Effort | Depends on |
| --- | --- | --- | --- |
| `/people` "name this cluster" writes `people.json` | Code | 0.5 day | engine `people` RESULT already lists clusters |
| Stable cluster ids in `identities.py` | Desktop | 0.5 day | re-run on all 179 clips (\~1 h GPU) |
| "Check for new sources" button + folder count on `/ingest` | Code | 0.25 day | `engine_cli.py ingest` dry-run flag (Desktop, 0.25 day) |
| `docs/agents/BOARD.md`, inboxes, CLAUDE.md session-start rule | Desktop drafts, Code reviews | 0.25 day | none |
| `activity.jsonl` written by `jobs.ts` and `engine_cli.py`; last-20 panel on Library | Code | 0.5 day | agreed line format |
| `notes` on films and people, editable in the UI | Code | 0.5 day | none |
| Per-word attributes in transcripts and filters in `hits.ts` (`onscreen`, `person`, `event`); retire the second bucket | Code | 1 day | `build_buckets.py` emits the extra fields (Desktop, 0.1 day) |
| Retire or re-route `/sentence` through the engine renderer | Code | 1 day | contract: `render` with an ad-hoc single-line film |
| 30-minute labelled event test set | Ryan + Desktop | 0.5 day | pick the four clips |
| Detector stage (AudioSet tagger) in `ingest_new.sh` | Desktop | 1 day | test set |
| Typing stage: Qwen3-ASR-Enhanced on MPS, fallback laughter-Whisper | Desktop | 1–2 days | MPS viability test first (0.25 day) |
| Events as tokens through phrase bank, buckets, solver, renderer | Desktop | 1 day | detector + typing |
| Remote Control test for live agent-to-agent messaging | Ryan | 5 min | none |

Two things I would not do yet: a job queue or second machine (the GPU is idle most of the day; a 2-hour podcast is the exception), and fine-tuning our own laughter model (the public ones set a 0.78 F1 bar; beat it with gating and precision first).
