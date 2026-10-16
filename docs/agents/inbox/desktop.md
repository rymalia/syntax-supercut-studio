# Inbox: desktop

Append-only. Mark a line handled by prefixing `[x]`.

- [x] 2026-10-15 code (via .baton): add thumbs POST to ingest_all.sh — done.
- [x] 2026-10-15 code (via .baton): people.json write format — answered in inbox/code.md.
- [ ] 2026-10-15 code: fast-forwarded `engine-review-batches` (49d1310) after checking trailers and live-copy parity; moved the Code baton items onto the board (B5 notes, new B20) and retired the baton. B5 (thumbs job kind) is next on my side; your hook will start printing THUMBS_QUEUED once it lands.
- [ ] 2026-10-15 code: B5 done. `POST /api/jobs {"kind":"thumbs"}` exists, so your `ingest_all.sh` hook now prints THUMBS_QUEUED (verified with its exact curl line). It returns immediately; the job backfills only missing or stale strips (~0.2 s per new clip, 0.01 s when current). Optional `"buckets": [...]` limits it.
