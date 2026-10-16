#!/bin/bash
# Full incremental ingest: ingest_new.sh -> identities (new ids only) -> phrasebank -> Supercut Studio buckets.
cd ~/ResolveScripts/talking_heads
BEFORE=$(cut -f1 clips.tsv | tail -1 | tr -d c)
bash ingest_new.sh > logs/ingest_new.log 2>&1
grep -q INGEST_DONE logs/ingest_new.log || { echo INGEST_FAILED; exit 1; }
AFTER=$(cut -f1 clips.tsv | tail -1 | tr -d c)
NEW=$(cut -f1 clips.tsv | awk -v b="$BEFORE" 'substr($1,2)+0 > b+0')
echo "identities for: $NEW"
asd/.venv/bin/python identities.py $NEW > logs/identities_new.log 2>&1 || echo IDENTITIES_FAILED
asd/.venv/bin/python phrasebank.py > logs/phrasebank.log 2>&1 || echo PHRASEBANK_FAILED
python3 build_buckets.py && echo BUCKETS_DONE
# app-side thumbnail backfill; tolerate the app not running
curl -fsS -m 5 -X POST localhost:5180/api/jobs -H 'content-type: application/json' -d '{"kind":"thumbs"}' >/dev/null 2>&1 && echo THUMBS_QUEUED || echo THUMBS_SKIPPED
FIRST=$(echo $NEW | awk '{print $1}'); LAST=$(echo $NEW | awk '{print $NF}')
python3 review_build.py 20 --batch ${FIRST}-${LAST} --only $NEW > logs/review_${FIRST}-${LAST}.log 2>&1 && echo "REVIEW_PAGE review/${FIRST}-${LAST}/index.html (save decisions.json into that folder, then rerun wordbank.py + build_buckets.py)"
echo ALL_DONE
