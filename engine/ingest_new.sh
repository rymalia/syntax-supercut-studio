#!/bin/bash
# Incremental ingest of clips not yet in clips.tsv: ids continue from the last one. Never renumbers existing clips.
# audio -> parakeet (MLX/GPU) -> proxies + Vision faces -> Light-ASD + LR-ASD (MPS) -> wordbank.py
cd ~/ResolveScripts/talking_heads
SRC=~/Downloads/talking-heads-videos
mkdir -p audio transcripts proxy faces logs
NEW=$(python3 - <<'PY'
import os
rows=[l.rstrip('\n').split('\t') for l in open('clips.tsv') if l.strip()]
have={r[1] for r in rows}; n=max(int(r[0][1:]) for r in rows)
src=os.path.expanduser('~/Downloads/talking-heads-videos')
ids=[]
with open('clips.tsv','a') as f:
    for name in sorted(x for x in os.listdir(src) if x.endswith('.mp4') and x not in have):
        n+=1; cid=f"c{n:02d}"; f.write(f"{cid}\t{name}\n")
ids=[r[0] for r in rows if not os.path.exists(f"asd/out_lr/{r[0]}.json")]
ids+=[f"c{k:02d}" for k in range(max(int(r[0][1:]) for r in rows)+1, n+1)]
print(' '.join(ids))
PY
)
echo "NEW IDS: $NEW"
name_of() { awk -F'\t' -v id="$1" '$1==id{print $2}' clips.tsv; }
# 1. audio
for id in $NEW; do
  [ -f audio/$id.wav ] || /opt/homebrew/bin/ffmpeg -nostdin -v error -y -i "$SRC/$(name_of $id)" -vn -ar 16000 -ac 1 audio/$id.wav &
  while [ $(jobs -r | wc -l) -ge 8 ]; do sleep 1; done
done; wait; echo AUDIO_DONE
# 2. ASR (one model load)
WAVS=""; for id in $NEW; do [ -f transcripts/$id.json ] || WAVS="$WAVS audio/$id.wav"; done
# English-only Parakeet v2, pinned (Ryan 2026-10-22): the engine's word matching is English-only anyway, and the app or a
# non-login shell may not inherit PARAKEET_MODEL from ~/.zshenv. The app's /transcribe stays on v3 (multilingual).
PARAKEET_MODEL_INGEST="mlx-community/parakeet-tdt-0.6b-v2"
[ -n "$WAVS" ] && ~/.local/bin/parakeet-mlx $WAVS --model "$PARAKEET_MODEL_INGEST" --output-format json --output-dir transcripts
echo ASR_DONE
# 3. proxies + faces
one() { id=$1; [ -f faces/$id.jsonl.done ] && return
  /opt/homebrew/bin/ffmpeg -nostdin -v error -y -i "$SRC/$(name_of $id)" -an -vf "fps=10,scale=640:-2" -c:v h264_videotoolbox -b:v 1500k proxy/$id.mp4
  ./faces_bin proxy/$id.mp4 faces/$id.jsonl && touch faces/$id.jsonl.done; echo "faces $id"; }
for id in $NEW; do one $id & while [ $(jobs -r | wc -l) -ge 6 ]; do sleep 1; done; done; wait; echo FACES_DONE
# 4. ASD both models (MPS); 3 workers each so the GPU queue stays busy without thrashing
cd asd
for repo in Light-ASD LR-ASD; do
  for id in $NEW; do
    THREADS=2 ASD_REPO=$repo .venv/bin/python asd_run.py $id > ../logs/asd_${repo}_$id.log 2>&1 &
    while [ $(jobs -r | wc -l) -ge 3 ]; do sleep 2; done
  done; wait
done
cd ..; echo ASD_DONE
asd/.venv/bin/python wordbank.py
echo INGEST_DONE
