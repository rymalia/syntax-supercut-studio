#!/bin/bash
# v2 build: ear check -> render -> QA gate, for FILMS (default: all v2 scripts)
cd ~/ResolveScripts/talking_heads
PY=asd/.venv/bin/python
pgrep -f whisper-server >/dev/null || (nohup /opt/homebrew/bin/whisper-server -m ~/.cache/whisper.cpp/ggml-large-v3-turbo.bin --port 8178 -l en -nt > logs/whisper_server.log 2>&1 &)
for f in ${FILMS:?set FILMS}; do
  echo "=== verify $f"; $PY verify2.py films/$f.json 8
  echo "=== render $f"; $PY supercut2.py films/$f.json > logs/render2_$f.log 2>&1 || echo "RENDER FAILED $f"
  tail -3 logs/render2_$f.log
  echo "=== qa $f"; $PY qa_film2.py $f
done
echo BUILD2_DONE
