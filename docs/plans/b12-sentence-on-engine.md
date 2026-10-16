# B12 plan: /sentence on the engine renderer

Drafted 2026-10-16 by Codex (gpt-5.6-luna, read-only). The user decided to keep the /sentence UI and rebuild its backend on the engine; the decisions listed at the end still need the user. Citations are as of `7f7f74f`.

## 1. Sentence semantics and failure UX

- **Fact:** The current page promises independent word matching, and the old pipeline chooses a separate hit per token, tolerating missing words and mixing speakers/videos ([`+page.svelte:50`](.../src/routes/sentence/+page.svelte:50), [`sentence.ts:176`](.../src/lib/server/pipelines/sentence.ts:176)).
- **Recommendation:** Represent input as one monologue line:

  ```json
  {
    "title": "Sentence",
    "speaker_labels": false,
    "cast": ["optional-person-or-group"],
    "lines": [{ "speaker": "SENTENCE", "text": "..." }]
  }
  ```

  Do not silently auto-split. The engine permits two takes through eight words and three over eight words, with one person per line and each take constrained to admissible on-screen speech ([`ENGINE_CONTRACT.md:41`](.../docs/ENGINE_CONTRACT.md:41), [`supercut2.py:269`](.../engine/supercut2.py:269)).

- **Gains:** coherent speaker identity, on-screen/loud/face/shot filtering, natural contiguous phrases, engine audio mixing, captions, and QA.
- **Losses:** fewer arbitrary recombinations; uncommon words or incompatible word sequences can fail; fixed-seed reproducibility and word-level debug overlays disappear.
- **Cannot-build UX:** run `check` first. Show `lines[0].why` and `film.why`; the check protocol already returns per-line diagnostics and candidate takes ([`ENGINE_CONTRACT.md:24`](.../docs/ENGINE_CONTRACT.md:24), [`engine_cli.py:78`](.../engine/engine_cli.py:78)). Offer:
  - “Try splitting this into shorter sentences.”
  - “Try another person/group.”
  - “Clear cast restriction and let the engine choose.”

  Treat this as a completed “cannot build” result, not a server error.

## 2. Control mapping

- **BucketPicker:** **Recommendation: remove it from the active controls.** The engine has its own corpus and `engine_cli.py` has no bucket argument; app bucket selection cannot affect `check` or `render`. The current picker’s “none = all” behavior would be misleading ([`BucketPicker.svelte:13`](.../src/lib/BucketPicker.svelte:13), [`+page.svelte:20`](.../src/routes/sentence/+page.svelte:20)). Replace it with a short read-only note: “Uses the talking-heads engine corpus.”
- **Seed:** remove fixed-seed UI. Engine planning reports `takes_per_line`, but exposes no seed or variation option ([`engine_cli.py:121`](.../engine/engine_cli.py:121), [`engine_cli.py:146`](.../engine/engine_cli.py:146)). A variation seed would require a Desktop-owned engine change; flag it, do not implement it in the app.
- **Debug overlay:** remove the old checkbox; it burned each word with ffmpeg text ([`sentence.ts:88`](.../src/lib/server/pipelines/sentence.ts:88)). Add:
  - `Captions` → film JSON `captions`.
  - `Draft render` → `render --draft`.
  - Keep speaker labels off by default for a monologue; the engine supports captions and labels in film JSON ([`ENGINE_CONTRACT.md:37`](.../docs/ENGINE_CONTRACT.md:37)).
- **Optional cast:** add an optional person/group picker using the existing `PersonGrid`. It already accepts `people`, `names`, and `onSelect` ([`PersonGrid.svelte:4`](.../src/routes/film/PersonGrid.svelte:4)); `/film` already loads these from `/api/engine/people` ([`film/+page.svelte:62`](.../src/routes/film/+page.svelte:62)). Default should remain automatic casting.

## 3. Temporary film JSON, outputs, cleanup, playback

- **Fact:** `render --film` accepts any filesystem path; the CLI derives the film name from that path’s basename ([`engine_cli.py:70`](.../engine/engine_cli.py:70)).
- **Recommendation:** Write a unique film JSON into an app temp directory, for example:

  `os.tmpdir()/syntax-sentence-<unique-slug>/sentence-<unique-name>.json`

  Include title, captions, optional cast, and one line. Remove the temp directory in `finally`; do not remove rendered outputs.
- Engine outputs remain under `TH_ENGINE_DIR/films/out/`: the render command writes `<name>.mp4` and `<name>.plan.json` there ([`engine_cli.py:143`](.../engine/engine_cli.py:143), [`engine_cli.py:146`](.../engine/engine_cli.py:146)). Use a unique name so concurrent/repeated sentence jobs do not collide.
- Update job GET media mapping: it currently maps engine output only for `film-render` jobs ([`[id]/+server.ts:31`](.../src/routes/api/jobs/[id]/+server.ts:31)). Include `sentence` too. The existing engine-media route already permits `films/out/` and supports range requests ([`engine.ts:26`](.../src/lib/server/engine.ts:26), [`engine-media/+server.ts:18`](.../src/routes/api/engine-media/[...path]/+server.ts:18)).
- `JobPanel` will then play/download the result without a new player implementation ([`JobPanel.svelte:153`](.../src/lib/JobPanel.svelte:153)).

## 4. Job flow, cancellation, and old pipeline

- **Recommendation:** Keep the existing `sentence` job kind, but replace its implementation with an engine adapter. This keeps `/api/jobs` and the page URL contract stable while hiding the deeper workflow behind one interface.
- Flow:

  1. Write temporary film JSON.
  2. `check --film <temp-path>`.
  3. If `film.ok` is false, return structured diagnostics and stop.
  4. Otherwise run `render --film <temp-path>`, optionally with `--draft`.
  5. Run `qa --name <derived-name>` for final renders; skip QA for drafts because draft output naming differs from the normal QA target.
  6. Return `outFile`, plan path, check result, and QA result.
  7. Always remove the temporary JSON.

- Do not reuse `film-plan`/`film-render` directly: those jobs require a persisted slug and call `filmPath(slug)` ([`jobs.ts:196`](.../src/lib/server/jobs.ts:196)). A sentence-specific wrapper is the clean seam for inline film JSON.
- Pass the job `AbortSignal` into every `runEngine` call. `runEngine` kills the engine CLI child on abort, and `jobs.ts` converts cancellation into `cancelled` status ([`engine.ts:34`](.../src/lib/server/engine.ts:34), [`jobs.ts:118`](.../src/lib/server/jobs.ts:118)). Flag the existing process-tree limitation to Desktop under B21; do not modify engine files in this task.
- **Recommendation:** Delete the old word-stitching pipeline after verification. Do not ship an implicit fallback because it would silently restore the behavior B12 is retiring. If retained, make it an explicit, separately labelled legacy mode.
- Record the user-visible change in `CHANGELOG.md`; update B12’s board status only when implementation begins/completes.

## 5. Files, order, and verification

Files to touch:

- `src/lib/server/pipelines/sentence.ts` — replace local ffmpeg word stitching with the deep engine adapter.
- `src/lib/server/jobs.ts` — update sentence params/result types and keep `startSentence`.
- `src/routes/api/jobs/+server.ts` — validate cast, captions, speaker-label, and draft fields; stop passing buckets/seed/debug.
- `src/routes/api/jobs/[id]/+server.ts` — map sentence engine outputs to `/api/engine-media`.
- `src/routes/sentence/+page.svelte` — retain layout and `JobPanel`; replace obsolete controls, add cast picker, diagnostics, split/person suggestions.
- `src/lib/JobPanel.svelte` — only if needed to expose structured sentence results to the page.
- `CHANGELOG.md` — document B12.
- No `engine/` or live-engine changes.

Implementation order:

1. Define the sentence film/result types and temp-file lifecycle.
2. Implement `check → render → QA`, cancellation, and cleanup.
3. Update job/API/media plumbing.
4. Rebuild sentence controls and cannot-build display.
5. Remove the old pipeline and update changelog/board.
6. Verify with `npm run check`, then run UI jobs after ingest completes.

Post-ingest verification cases:

- Success, automatic cast: `I feel that there's been an alteration.` ([`the_review.json:18`](.../engine/films/the_review.json:18)).
- Success with explicit cast: `It's always the fear of a thing.` with `c72/0` ([`life_advice.json:11`](.../engine/films/life_advice.json:11)).
- Long-line/take-limit case: `I guarantee you eat pork chops because when you were a child, there was one pork chop too few on the table.` ([`the_review.json:50`](.../engine/films/the_review.json:50)).
- Cannot-build case: `The zqv blorple is under the moonbase.` Confirm that the page shows the engine’s per-word `why`, then exposes split and cast-change suggestions.
- Repeat a successful sentence with and without an explicit cast; confirm the cast restriction changes the check result and that the final video, plan, QA, cancellation, and cleanup all behave correctly.

### Decisions to confirm

- One monologue line by default — **recommended: yes**.
- Remove BucketPicker rather than leave a misleading no-op — **recommended: remove**.
- Optional cast picker — **recommended: add, default unrestricted**.
- QA drafts — **recommended: skip QA for drafts**.
- Legacy word-stitch fallback — **recommended: delete after verification**.
- Engine variation seed — **recommended: defer to a separate Desktop engine task**.
