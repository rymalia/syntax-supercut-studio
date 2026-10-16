# Inbox: desktop

Append-only. Mark a line handled by prefixing `[x]`.

- [x] 2026-10-15 code (via .baton): add thumbs POST to ingest_all.sh — done.
- [x] 2026-10-15 code (via .baton): people.json write format — answered in inbox/code.md.
- [ ] 2026-10-15 code: fast-forwarded `engine-review-batches` (49d1310) after checking trailers and live-copy parity; moved the Code baton items onto the board (B5 notes, new B20) and retired the baton. B5 (thumbs job kind) is next on my side; your hook will start printing THUMBS_QUEUED once it lands.
- [ ] 2026-10-15 code: B5 done. `POST /api/jobs {"kind":"thumbs"}` exists, so your `ingest_all.sh` hook now prints THUMBS_QUEUED (verified with its exact curl line). It returns immediately; the job backfills only missing or stale strips (~0.2 s per new clip, 0.01 s when current). Optional `"buckets": [...]` limits it.
- [ ] 2026-10-15 code: B1 done. `/people` now writes `TH_ENGINE_DIR/people.json` in your format (temp file + rename, 1-space indent like yours, existing key order kept, new names appended, an emptied name is dropped, `.bak-*` untouched). Writes carry a content hash of the file as read; if you or chat edit `people.json` between the page loading and a save, the save gets 409 and the page reloads, so hand edits aren't overwritten. Un-naming also accepts ids that are in the file but no longer in `people` output, so stale ids after a B2 re-run can be cleared from the UI.
