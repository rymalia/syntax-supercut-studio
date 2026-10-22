# B26: faster supercut and songify renders

Requested by Ryan 2026-10-21 (findings #2, #3 and #5 of the Resolve-export session).

## Problem

`src/lib/server/pipelines/supercut.ts` and `songify.ts` render each segment to H.264/AAC one at a
time, then join them with the ffmpeg **concat filter**, which decodes and re-encodes every frame and
sample a second time. Both pipelines carry their own copy of the encode settings, segment loop,
concat step and work-dir handling.

## Change

1. **Shared render module** `src/lib/server/render.ts`, used by both pipelines:
   - the segment encode settings (one place);
   - `renderSegments(tasks, { concurrency, signal, onLog })`: runs segment renders with a bounded
     pool, keeps output order by index, and on the first failure or abort stops starting new work,
     cancels the running ones and rethrows (a `CancelledError` stays a `CancelledError`);
   - `concatSegments(paths, outFile, workDir, onLog, signal)`: the join.
2. **No second video encode.** Segments carry H.264 video (same settings as today's final:
   libx264 veryfast crf 20, yuv420p, 30 fps CFR, 1280×720) and **PCM audio** (`pcm_s16le`, 48 kHz
   stereo) in a `.mov` or `.mkv` intermediate. The join uses the **concat demuxer** with
   `-c:v copy` and encodes the audio once to AAC 192k, with `-movflags +faststart`.
   - Why PCM: AAC segments carry encoder priming and padding at every join, which a stream copy
     would keep as gaps or drift. PCM joins sample-exactly, and one AAC encode of the whole
     timeline is cheap.
   - Each segment's audio must be exactly as long as its video: N frames at 30 fps is N/30 s, so
     pad or trim the audio to that many samples. Otherwise the concat demuxer leaves gaps or
     overlaps and A/V sync drifts over many joins.
3. **Parallel segments.** Concurrency comes from `SYNTAX_RENDER_CONCURRENCY` (default 4,
   minimum 1). Segment order and filenames stay index-based, so the output order is unchanged.
4. Both pipelines keep their results, logs, cut lists and filenames. Randomness (`Math.random` in
   `shuffle`, `planSegments` and songify's single-clip pick) must be called in the **same order**
   as today, so a seeded A/B harness gets identical edits from old and new code.

Out of scope: VideoToolbox encodes (B17), output resolution, songify's pitch-analysis loop.

## Verification (Ryan asked for more than one listen)

A harness (`scratchpad`, not committed) renders the same edits with the old code (a worktree at
`main`) and the new code, with `Math.random` replaced by the same seeded PRNG, and compares:

| check | pass |
| --- | --- |
| decode errors (`ffmpeg -v error -f null`) | none |
| same edit: duration, video frame count | new within 1 frame per segment of old |
| end-of-file A/V gap: audio duration − video duration | |new| ≤ 1 frame, and not worse than old |
| per-join A/V sync: audio offset at each join vs the old render (cross-correlation) | every join within ±2 ms of the median offset (a constant AAC priming offset is fine) |
| per-join video alignment: SSIM of new vs old frames around each join | no join where SSIM dips below the run's typical level by more than 0.05 |
| gaps: silence (< −60 dB, ≥ 5 ms) starting within 20 ms of a join | none that the old render doesn't also have |
| clicks: peak sample-to-sample jump within ±5 ms of a join, relative to the old | none over 2× the old at the same join |
| overall audio: cross-correlation of the whole track new vs old | peak at one constant lag |
| speed: wall time | reported for concurrency 1 and default |

Corpora: tiled supercut (~15 segments); solo supercut long enough to show drift (100+ segments);
a regex supercut; songify with real pitch shifts; mixed source codecs (VP9/AV1) and rates.

Then Ryan listens to A/B pairs picked by the harness: the joins with the largest measured
differences, not random ones.

## Revisions after Codex plan review (2026-10-21, REVISE → applied)

- **Exact segment length.** Each segment has an explicit frame count `N` (planned duration × 30,
  rounded, minimum 1). Video is encoded with `-frames:v N`, padded by cloning the last frame if the
  source runs short. Audio ends with
  `aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_len=N*1600,atrim=end_sample=N*1600,asetpts=PTS-STARTPTS`,
  so it is exactly `N × 1600` samples. `-t` is not relied on.
- **Container and join.** Intermediates are **MKV** (H.264 + `pcm_s16le` 48 kHz stereo). The join
  uses an `ffconcat version 1.0` list with an explicit `duration N/30` per file, then
  `-f concat -safe 0 -i list -map 0:v:0 -map 0:a:0 -c:v copy -c:a aac -b:a 192k -ar 48000 -ac 2 -avoid_negative_ts make_zero -movflags +faststart`.
  No `-r`/`-fps_mode` at the join.
- **Pool failure model.** `renderSegments` uses an internal AbortController linked to the caller's
  signal. Workers check it before claiming each index. On the first failure it aborts the rest,
  **awaits every running task** (so `finally` can't delete the work dir under a live ffmpeg), and
  rethrows that first failure (an external abort rethrows `CancelledError`). Log lines are prefixed
  with the segment index.
- **Songify pitch (separate commit, after the A/B).** `asetrate` assumes 48 kHz input, so a 44.1 kHz
  source (about 1 in 60 in `talking-heads`) is shifted about 1.5 semitones sharp. Fix by resampling to
  48 kHz first, and compute `atempo` from the rounded rate's actual ratio.
- **More verification.**
  - Per segment: sample count equals `N × 1600`, the first packet is a keyframe, codec parameters match.
  - Output: video DTS/PTS increase at every join.
  - Cancellation and injected-failure runs leave no ffmpeg processes or work dirs.
  - A **synthetic absolute test**: generated sources whose frames carry their frame number and
    whose audio encodes the source time, run through supercut. It measures true A/V offset at
    every join, independent of the old render.

## As built (2026-10-21)

- Intermediates are **MOV** (H.264 at a 1/15360 timescale + `pcm_s16le`), not MKV: MKV's 1 ms timebase
  rounded frame times (0.067, 0.134 s …) and the first build's output started at 0.067 s video /
  0.046 s audio. The join keeps timestamps unshifted, so both streams start at 0 with exact 1/30 s frames.
- The concat list holds relative basenames in the work dir (no quoting, so `'` in a target is fine).
- Cut list `rec` advances by the rendered duration (`N/30`), matching the mp4.
- Results (A/B harness, 5 real-media edits; scratchpad scripts `ab/ab.sh`, `ab/absolute.py`,
  `ab/synth/`):
  - Speed at concurrency 4: tiled 15 segments 4.8 → 1.8 s; solo 120 segments 32.8 → 8.3 s;
    regex 40 segments 7.0 → 2.4 s; tiled 60 segments 19.9 → 5.3 s; songify 2.9 → 1.0 s.
  - Absolute check against the sources (solo and tiled supercuts): output frame count = ΣN,
    every segment's video at frame shift 0, audio-minus-video offset 0.00 ms (max 0.02) on all
    segments with a reliable audio match.
  - Old vs new comparison is not like for like: the old concat filter extended each segment to its
    AAC audio length, adding frames (120-segment edit: 1610 vs 1576 frames).
  - Synthetic sources (30/29.97/25/23.976/60 fps; H.264, VP9, AV1; 48 and 44.1 kHz): both start at 0,
    no gaps. Per-source median offsets are near 0 for 30 and 60 fps sources in the new render
    (old: +9 and +19 ms). Other rates spread by about half a source frame in both.
  - Cancel mid-render: `CancelledError`, no work dir, no ffmpeg left. A corrupt source: the original
    ffmpeg error, siblings stopped and awaited, no leftovers.
