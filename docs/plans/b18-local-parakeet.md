# B18 plan: local parakeet-mlx transcription with xAI fallback

Drafted 2026-10-16 by Codex (gpt-5.6-luna, read-only) for board task B18; not yet reviewed against measurements. File:line citations are as of `7f7f74f`.

## 1. Shape mapping

**Facts.** The app contract is `{ text, duration, words[] }`; each word needs `text`, `start`, and `end` (`src/lib/server/text.ts:30-40`). xAI currently returns those fields plus optional `language`, `confidence`, and `speaker` (`src/lib/server/pipelines/transcribe.ts:12-25`). Consumers use only word text/timings and duration (`src/lib/server/hits.ts:73-164`, `src/lib/server/pipelines/sentence.ts:29-57`, `src/routes/stats/+page.server.ts:87-116`, `src/routes/+page.server.ts:65-116`).

The sampled parakeet JSON contains top-level `text` and `sentences`; each sentence has `text/start/end/duration/confidence/tokens`, while tokens are subword fragments, punctuation, and sometimes zero-duration pieces (`/Users/rymalia/ResolveScripts/talking_heads/transcripts/c01.json:1-16`, `:26-64`, `:68-136`).

**Plan.** Write this canonical bucket shape:

```json
{
  "text": "...",
  "duration": 126.04,
  "words": [
    { "text": "telephone", "start": 4.16, "end": 4.8, "confidence": 1.0 }
  ],
  "engine": "parakeet-mlx",
  "language": "en"
}
```

Field mapping:

| App field | Mapping |
|---|---|
| `text` | Preserve parakeet’s top-level `text`; do not reconstruct it from grouped words. |
| `duration` | Maximum token/word `end`, rounded to 3 decimals. This matches `build_buckets.py`, which computes duration from maximum source-word end (`engine/build_buckets.py:18-28`). |
| `words[].text` | Group consecutive parakeet tokens into words. A token beginning with whitespace starts a new word; tokens without a leading boundary append to the current word. Attach punctuation to the preceding word. Thus `" tele" + "ph" + "one"` becomes `"telephone"`, and `" don" + "'" + "t"` becomes `"don't"`. |
| `words[].start` | First token’s `start`. |
| `words[].end` | Last token’s `end`. |
| `words[].confidence` | Optional duration-weighted mean of constituent token confidences; arithmetic mean if all token durations are zero. |
| `language` | Configured language label, defaulting to `en`; not claimed as model-detected. |
| `engine` | New persisted metadata: `"parakeet-mlx"` or `"xai"`. |
| `speaker` | Omit for parakeet; preserve it for xAI if returned. |
| `sentences`, token `duration` | Do not write to the app transcript; they are provider-specific. |

`build_buckets.py` is not a direct parakeet-to-app converter: it consumes `engine/words/<id>.json`, reads `words[].w`, optionally filters `onscreen`, inserts zero-length `|` gap markers, and emits the app-like `{text,duration,words}` shape (`engine/build_buckets.py:18-28`, `:41-49`). Reuse its duration and serialization semantics, but implement the parakeet token grouping separately in TypeScript.

## 2. Parakeet invocation and cancellation

**Facts.** Engine ingest extracts 16 kHz mono WAVs, then invokes parakeet once with multiple WAV paths and one output directory (`engine/ingest_new.sh:23-30`). App transcription currently chooses an existing MP3, otherwise source media, and extracts MP3 only above the xAI 500 MB cap (`src/lib/server/pipelines/transcribe.ts:135-179`). `transcribe-all` currently launches up to three independent `transcribeOne` workers (`src/lib/server/pipelines/transcribe.ts:228-229`, `:271-299`).

**Plan.**

- Add a local audio-preparation step using ffmpeg:

  ```text
  -i <source> -vn -ar 16000 -ac 1 -c:a pcm_s16le <job-temp>/<bucket>/<slug>.wav
  ```

  Keep these WAVs in a temporary job directory; do not create permanent bucket audio unless explicitly desired.

- `transcribe-one`: prepare one WAV, invoke:

  ```text
  ~/.local/bin/parakeet-mlx <wav> --output-format json --output-dir <job-temp>/raw
  ```

  Read `<raw>/<slug>.json`, validate it, map it, then atomically write `<bucket>/transcripts/<slug>.json`.

- `transcribe-all`: build the existing missing-file queue, extract all WAVs, invoke parakeet once with every WAV path. The `concurrency` option may bound WAV extraction and xAI fallback work, but must never start multiple parakeet processes; this preserves one model load.

- After the batch exits, validate every expected output. The CLI may complete with missing individual files, so missing/invalid outputs must be handled per file rather than trusting only the process exit code.

- Add a generic `runChildProcess` helper, or extend the existing process helper, with:
  - direct `spawn`, no shell;
  - `detached: true`;
  - stdout/stderr forwarding through `onLog`;
  - `AbortSignal` listener;
  - SIGTERM to the negative process-group PID, followed by SIGKILL after a short grace period;
  - `CancelledError` on cancellation.

  The current ffmpeg helper kills only its direct child (`src/lib/server/ffmpeg.ts:46-81`), while jobs already propagate an `AbortSignal` and classify `CancelledError` as cancelled (`src/lib/server/jobs.ts:118-146`). The parakeet runner must preserve that job behavior and must never trigger xAI fallback after cancellation.

- Log extraction start/end, batch size, parakeet start, each validated output, fallback decisions, and final counts via `onLog`. The existing job panel displays accumulated logs and polls job state (`src/lib/JobPanel.svelte:49-66`, `:170-172`).

- Remove the temporary directory in `finally`. Never expose a partial transcript in the bucket; write to a temp JSON beside the destination and rename only after validation.

The permitted `parakeet-mlx --help` attempt could not initialize in this headless sandbox because MLX reported no Metal device. That should be treated as an environment validation issue, not as evidence that the installed CLI flags differ.

## 3. Selection, fallback, and UI

**Plan.** Introduce configuration:

- `SYNTAX_TRANSCRIBE_ENGINE=parakeet|xai`, default `parakeet`.
- `PARAKEET_MLX_BIN`, default `~/.local/bin/parakeet-mlx`.
- `SYNTAX_TRANSCRIBE_FALLBACK=xai|none`, default `xai`.

Rules:

- Explicit `xai` skips local processing.
- Default `parakeet` attempts local transcription first.
- Fall back per file when the binary is unavailable, cannot start, exits unsuccessfully, produces no output, produces malformed JSON, or produces invalid word timings.
- Do not fall back for cancellation.
- If fallback is selected but `XAI_API_KEY` is missing, fail with the existing key error (`src/lib/server/pipelines/transcribe.ts:27-30`).
- For `transcribe-all`, local batch failure should not discard valid outputs; fall back only for failed files.
- Do not fall back merely because confidence is low until measurement establishes a threshold.

Canonicalize xAI output through the same writer and add `"engine": "xai"` plus `"fallbackFrom": "parakeet-mlx"` and `"fallbackReason"` when applicable. Existing xAI writes the raw response directly to the transcript path (`src/lib/server/pipelines/transcribe.ts:181-203`).

Expose engine metadata in:

- `TranscribeOneResult`: `engine`, `fallbackReason?`.
- `TranscribeAllMissingResult`: counts by engine and per-file failures.
- Library page data: read `json.engine` in `src/routes/+page.server.ts:83-103`, add an engine column/badge in `src/routes/+page.svelte:203-251`.
- Job output: show the engine and fallback reason in `JobPanel.svelte`; the current panel has no transcription-specific result rendering (`src/lib/JobPanel.svelte:115-168`).
- Update the transcribe-page copy, which currently says all uploads go to xAI (`src/routes/transcribe/+page.svelte:93-100`).

Existing transcripts without `engine` should display `unknown/legacy`; the engine cannot be inferred reliably from their current shape.

## 4. Post-ingest measurement plan

Run only after the active ingest finishes.

- Select 5–8 clips spanning short/long, clean/noisy, and single/multiple speakers. Record exact audio duration with ffprobe.
- Prepare identical 16 kHz mono WAV inputs for both engines.
- Measure:
  - cold local wall time, including model load;
  - warm local batch wall time;
  - xAI end-to-end wall time, including upload;
  - provider-only time;
  - real-time factor: `wall_seconds / audio_seconds`;
  - throughput: audio hours per wall-clock hour.
- Run local clips as one batch to measure the intended one-model-load path. Run xAI serially or at a fixed concurrency and record network conditions.
- Preserve raw outputs in benchmark-only directories, not production buckets.
- Compare word timing after normalizing words with the app’s existing normalization (`src/lib/server/text.ts:1-3`):
  - align local and xAI word sequences using edit distance;
  - compute matched-word absolute start and end deltas;
  - report median, p90, and percentage within 100 ms and 250 ms;
  - also report insertions, deletions, and substitutions.
- Treat xAI as a comparator, not ground truth. Manually inspect a few disagreements before setting acceptance thresholds.
- Compare the mapped parakeet output, not raw subword tokens, so the grouping algorithm is included in the measurement.

The current xAI log measures elapsed time around `transcribeFile` (`src/lib/server/pipelines/transcribe.ts:181-190`); the benchmark should separately record extraction, upload, model load, and total job time.

### Results (2026-10-16, implementation on `b18-wip`)

- **Speed (local):** a 40.2-minute file took 22.2 s wall including WAV extraction and model load (RTF 0.0092, ~109x real time); a batch of 5 clips (~5.9 min of audio, one silent) took 6 s.
- **Word grouping:** the app's mapping is checked against the engine's own grouping (`analyze.py` `load_words`) over every raw transcript in `TH_ENGINE_DIR/transcripts/`: 311,567 words in 350 clips, identical text and identical start/end times. The one difference, `c283`, is Russian speech: the engine's ASCII `norm()` drops Cyrillic words, while the app keeps them.
- **xAI comparison: not run.** No `XAI_API_KEY` is available in this environment (not in the shell, a local `.env`, or `SYNTAX_REPO_DIR`). The fallback path was exercised up to the key check: per-file fallback, a clear "XAI_API_KEY ... not set" error per file, no partial transcripts.
- **Model:** the user's shell exports `PARAKEET_MODEL=mlx-community/parakeet-tdt-0.6b-v2` (English-only), which both the app and the engine ingest inherited. The app now passes `--model` from `SYNTAX_PARAKEET_MODEL` (default v3) and records `model` in each transcript.
- **Raw output quirk:** parakeet can write bare `NaN` (seen as a sentence `confidence` in `c242.json`), which `JSON.parse` rejects; the app reads it as `null` instead of falling back.

## 5. Risks and open questions

- **Token grouping risk:** parakeet tokens are subwords and punctuation, not app words; leading-space rules need validation across more than `c01.json`.
- **Timing risk:** parakeet has no top-level duration; max word end matches `build_buckets.py`, but may omit trailing silence.
- **Hardware risk:** parakeet requires a working MLX/Metal environment; startup failure must produce a clear fallback log.
- **Cancellation risk:** killing only the Python parent may leave descendants; use process-group termination and verify cancellation experimentally after ingest.
- **Resource risk:** concurrent local model processes can exhaust unified memory; `transcribe-all` must remain a single local process.
- **Privacy/cost risk:** fallback uploads audio externally; the UI must make that explicit.
- **Feature mismatch:** parakeet output has no speaker diarization, while xAI supports optional speaker fields (`src/lib/server/pipelines/transcribe.ts:12-18`, `:42-46`).
- **Compatibility risk:** legacy transcripts have no engine metadata and should be labeled unknown.
- **Answered 2026-10-16 (ryan):** non-English does not go to xAI; it stays local, since whisper and parakeet both cover many languages. Consequences: the local model must be a multilingual one (parakeet-tdt v3, not the English-only v2; or whisper), and the `language` field should come from the model's detection or the request, not a fixed `en` default.
- **Decided 2026-10-16:** a zero-word, silent clip is a valid local transcript (`words: []`), not a fallback trigger.
- **Decided 2026-10-16:** only the canonical transcript is kept; raw parakeet JSON stays in the job temp dir.
- **Fact 2026-10-16:** the installed CLI defaults to `mlx-community/parakeet-tdt-0.6b-v3` (multilingual). Its JSON has no language field, so local transcripts omit `language` instead of claiming `en`.
