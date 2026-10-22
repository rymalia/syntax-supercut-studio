# Fork changelog

Major changes in this fork relative to the original
[wesbos/syntax-supercut-studio](https://github.com/wesbos/syntax-supercut-studio).
The fork point is tagged `upstream-baseline` (`f7d0c1e`, 2026-05-28); see the
full divergence with:

```sh
git log --oneline upstream-baseline..HEAD
git diff --stat upstream-baseline
```

Changes are not sent upstream. Newest first; group entries by date.

## 2026-10-21

### Added
- **Favicon.** A black film reel (four holes, a strip of film curling off it) on the lime accent square
  (`static/favicon.svg`, plus `favicon.ico` 16/32/48 and a 180 px `apple-touch-icon.png`).
- **Cast and on-screen filters for supercut and songify.** Both pages can keep
  only hits spoken by one person or a `people.json` group (the same picker as
  `/sentence`) and only speech where the speaker is on screen. Phrase and regex
  matching are unchanged; the talking-heads engine's new `attribute` command
  says who speaks each hit, so the job log lists the speakers and the cut list
  markers carry the person. The filters work on the talking-heads buckets.
- **Engine renders on `/clips`.** Sentence and film renders in the engine's
  `films/out` (drafts tagged) are listed under an "engine renders" tab, play in
  the page, and export for Resolve even after a server restart. A render whose
  plan was rewritten after it was made says so instead of offering export.
- **Export for Resolve.** Supercut, sentence and film renders can be opened as
  a DaVinci Resolve (or Final Cut) timeline cut from the original source files.
  Supercut now saves a cut list (`<render>.cuts.json`) beside each mp4, and an
  "Export for Resolve" button on `/clips` and in the job panel runs the engine's
  `export` and downloads the `.fcpxml` plus an `.srt` of the hits. Supercuts
  rendered before this have no cut list and can't be exported. Deleting a clip
  also removes its cut list and exports.
- **Songify exports too.** Songify saves the same cut list, so its renders get
  "Export for Resolve" on `/clips` and in the job panel. Resolve can't take the
  pitch shifts from the timeline file, so each note's shift (in semitones) is in
  its clip name and marker for applying by hand.

### Changed
- **Faster supercut and songify renders.** Segments render four at a time
  (`SYNTAX_RENDER_CONCURRENCY`), and the final join copies the video instead of
  encoding it again, so renders take about a quarter of the time (a 120-clip
  supercut: 33 s → 8 s) with one less generation of compression. Every cut is
  now a whole number of frames with sound exactly in sync; the old join padded
  each cut to its audio, adding duplicated frames and timing slack, so the same
  edit runs slightly shorter. Cut lists follow the rendered timing.

### Fixed
- **Songify pitch rate.** Resampling to 48 kHz before pitch shifting fixes the
  ~1.5-semitone sharpness caused by 44.1 kHz sources; tempo correction now uses
  the actual rounded-rate ratio.

## 2026-10-17

### Added
- **Regex tips on `/supercut`.** A "Regex tips" button in regex mode opens a
  modal of examples for this corpus: why words go in `\b` and options in
  parentheses, optional pieces, contractions, punctuation, what a match pulls
  into the clip, and how to allow words in between without `.*` producing
  hours-long clips. Each example has a "Use" button that fills the regex field.

### Fixed
- **Smart-quote apostrophes in supercut search.** A curly `’` typed into
  `/supercut` (phrase or regex) or `/songify` used to match nothing, because
  transcripts use a straight `'`. Curly and modifier apostrophes now count as
  `'`. The phrase and regex help text now says what punctuation actually
  does: phrase mode ignores punctuation except apostrophes (`don't` ≠ `dont`),
  and a regex match clips every word it touches, even partly.

## 2026-10-16

### Added
- **Local transcription with per-file xAI fallback.** `/transcribe` now uses the
  multilingual local `parakeet-mlx` engine by default, keeps valid silent clips
  as empty transcripts, and uploads only failed files to xAI when fallback is
  enabled. Library rows and job output show the engine and fallback reason.
  Words are grouped exactly as the engine groups them, and the multilingual v3
  model is passed explicitly (`SYNTAX_PARAKEET_MODEL`), so a shell-wide
  `PARAKEET_MODEL` pinning the English-only v2 no longer applies to the app.
- **People: hide named clusters, search by name.** `/people` has a "Hide named
  clusters" toggle (remembered per browser) that leaves only the clusters still to
  identify, with an unnamed count. People search on `/people` and `/film` also
  matches a cluster's name, with `_` matching a space (`billy_boy` is found by
  "billy", "boy" or "billy boy").
  The group buttons above the grid collapse under a "Groups" toggle, also remembered.
- **Ingest tooling in the engine snapshot.** `engine/ingest_all.sh` runs the whole
  incremental ingest (ASR, faces, ASD, identities, phrase bank) and refreshes the
  app buckets with the new `engine/build_buckets.py`; new sources in
  `talking-heads-videos` appear in the Library without a server restart.
  Corpus: 179 clips, 192k words.

### Changed
- **Sentence mashups use the talking-heads engine.** `/sentence` now builds one
  coherent monologue line with optional cast restrictions, captions, and draft
  renders. The old per-word stitching controls and legacy pipeline were removed;
  unbuildable sentences report the engine's diagnostics with suggestions.

### Fixed
- **Cancelling an engine job stops all of its work.** Cancel, and stopping the dev
  server, now signal the engine's whole process group (SIGTERM, then SIGKILL after
  10 s), so `ingest_new.sh`, ffmpeg and ASD workers no longer keep running.
- **Activity log:** Library and clip deletes are now logged; malformed timestamps
  (non-ISO, impossible dates, no timezone) are skipped. A Library delete now lists
  only files that were actually removed.

## 2026-10-15

### Added
- **Shared activity log.** The app records job completions and successful edits in `<TH_ENGINE_DIR>/activity.jsonl` and shows the latest entries on the Library.
- **Ingest refreshes Library and review.** Running `/ingest` now refreshes Library buckets and builds a speaker review batch for newly added clips.
- **Speaker review in the app (`/review`).** Lists the engine's per-ingest review
  batches (`review/<batch>/`), plays each segment's preview with the detected
  face boxed, and records Speaking / Voice-over / Mixed verdicts into the
  batch's `decisions.json` in the shape `wordbank.py` reads. As in the old
  standalone page, only segments you play or mark are recorded. Replaces
  opening `review/<batch>/index.html` and moving a downloaded file into place.
- **Naming people on `/people`.** Tick one or more clusters, type a name (new or
  existing, normalized to `lowercase_underscores`), and save; or remove a name.
  Clicking a group selects its clusters, for renaming. Writes the engine's
  `people.json` atomically, moving each cluster out of any other name; a stale
  page gets 409 and reloads instead of overwriting another edit. `/film` can
  cast the new group immediately. Each tile now shows its cluster's name.
- **Library hover previews.** Hovering a row shows a 4-frame strip (20/40/60/80%
  of the runtime) with the video's title. Strips are generated by ffmpeg on
  first hover and by a `thumbs` job that the engine's `ingest_all.sh` (and the
  app's ingest job) runs after each ingest; cached in `<bucket>/thumbs/`.
- **Original titles in the Library.** Symlinked videos (the talking-heads
  buckets) show the source filename under the slug; the filter matches titles.
- **Talking-heads engine integration.** Bridge to the external Python engine at
  `TH_ENGINE_DIR` via `engine_cli.py` (protocol in `docs/ENGINE_CONTRACT.md`).
  New job kinds `film-plan`, `film-render` (render + QA), and `ingest`.
- **Film, People, and Ingest pages.** `/film` edits film scripts (casting,
  per-line buildability check, plan, draft/final render, phrase grep);
  `/people` browses castable identities; `/ingest` runs incremental ingest.
- **Engine media route** `/api/engine-media/...`, a second read-only media root
  limited to `identities/`, `proxy/`, and `films/out/`.
- **Engine snapshot** in `engine/` (versioned copy; the live engine runs from
  `TH_ENGINE_DIR`), plus seven v2 film scripts. The engine skips takes from a
  source's last 8 s (end-card guard).
- **Dark mode** with a Dark/Light toggle in the top bar; follows the OS setting
  until chosen, applied before first paint. Fonts, layout, and the lime accent
  are unchanged.
- `CLAUDE.md` with commands, architecture, and theming rules.

### Fixed
- **Renders on ffmpeg 9.** Pipelines use `-/filter_complex <file>` and
  `-fps_mode` instead of the removed `-filter_complex_script` and `-vsync`.
  Requires ffmpeg 7+.
- Hero heading highlights overlapped the subtitle; the Library "Transcribed"
  highlight overlapped its label; filled status pips were invisible on a
  hovered (lime) table row.
