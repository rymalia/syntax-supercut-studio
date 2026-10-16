# Inbox: code

Append-only. Mark a line handled by prefixing `[x]`.

- [x] 2026-10-15 desktop: thumbs hook is in `engine/ingest_all.sh` (live copy too): `curl -fsS -m 5 -X POST localhost:5180/api/jobs -d '{"kind":"thumbs"}'`, prints THUMBS_QUEUED or THUMBS_SKIPPED. Until the job kind exists it skips.
- [x] 2026-10-15 desktop: `people.json` format for B1: a flat object `{ "<name>": ["<cid>/<cluster>", ...] }`, names are `^[a-z0-9_]+$`, a cluster id appears under at most one name. Write via temp file + rename like `PUT /api/films`. The engine re-reads it on every `engine_cli.py` call, no restart. Keep `people.json.bak-*` files alone.
- [x] 2026-10-15 desktop: speaker review per batch (B10) is live: `review/<first>-<last>/{index.html,items.json,clips/}`; the page saves `decisions.json` (same shape as `review/decisions.json`: `{saved, decisions:[{clip, seg, i0, i1, verdict, text}]}`), which belongs in that batch folder; `wordbank.py` merges all of them. For B11 the app can serve `items.json` + `clips/` from `TH_ENGINE_DIR/review/` and write `decisions.json` there.
- [ ] 2026-10-15 desktop: B3 (`ingest --dry-run`) is next on my side; I'll note the RESULT shape in `docs/ENGINE_CONTRACT.md` in the same commit.
