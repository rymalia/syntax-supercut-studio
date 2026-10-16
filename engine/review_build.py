#!/usr/bin/env python3
"""Build a local review page for speaking-vs-voiceover decisions on the trickiest clips.

  python review_build.py [N_CLIPS]
Picks clips where on-screen detection is most at risk: lots of off-screen speech (narration / interviewer)
alongside on-screen segments, plus borderline speaker scores. Every on-screen segment (2+ words) in those clips
gets a short preview (face box drawn on the face the model says is speaking).
Open review/index.html in a browser; choices persist in the page and "Save decisions" downloads decisions.json.
"""
import json, os, sys, subprocess, html, statistics as st
HERE = os.path.dirname(os.path.abspath(__file__)); R = os.path.join(HERE, "review"); FF = "/opt/homebrew/bin/ffmpeg"
SRC = os.path.expanduser("~/Downloads/talking-heads-videos")
# usage: review_build.py [CAP_PER_CLIP] [extra clip ids...]  -- top-risk clips plus any named ones (news packages, docs)
import argparse
ap = argparse.ArgumentParser()
ap.add_argument("cap", nargs="?", type=int, default=20, help="max segments per clip")
ap.add_argument("extra", nargs="*", help="clip ids to include regardless of risk")
ap.add_argument("--batch", help="write into review/<batch>/ instead of review/ (its own index.html, items.json, clips/)")
ap.add_argument("--only", nargs="*", help="rank only these clip ids (an ingest batch)")
ap.add_argument("--n", type=int, default=10, help="top-risk clips to include")
A_ = ap.parse_args()
CAP, EXTRA, N, ONLY = A_.cap, A_.extra, A_.n, set(A_.only or [])
if A_.batch: R = os.path.join(R, A_.batch)
KEY = A_.batch or "review"
clips = [l.rstrip("\n").split("\t") for l in open(os.path.join(HERE, "clips.tsv"))]
rank = []
for cid, name in clips:
    p = os.path.join(HERE, "words", cid + ".json")
    if not os.path.exists(p) or (ONLY and cid not in ONLY): continue
    D = json.load(open(p)); W = D["words"]; segs = [s for s in D["segments"] if len(s["words"]) >= 2]
    if not W or not segs: continue
    off = sum(1 for w in W if not w["onscreen"]) / len(W)
    border = sum(1 for w in W if w["onscreen"] and w["asd"] < 1.5) / max(1, sum(w["onscreen"] for w in W))
    risk = off * 0.6 + border * 0.4
    rank.append((risk, cid, name, D, segs, off, border))
rank.sort(key=lambda r: -r[0])
pick = rank[:N] + [r for r in rank[N:] if r[1] in EXTRA]
os.makedirs(os.path.join(R, "clips"), exist_ok=True)
cards = []
for risk, cid, name, D, segs, off, border in pick:
    T = json.load(open(os.path.join(HERE, "asd", "out", cid + ".json")))["tracks"]
    W = D["words"]; items = []
    # most doubtful first (lowest median speaker score), capped, then shown in time order
    order = sorted(range(len(segs)), key=lambda k: st.median(W[i]["asd"] for i in segs[k]["words"]))[:CAP]
    for k in sorted(order):
        s = segs[k]
        a, b = max(0, s["start"] - 0.4), s["end"] + 0.4
        box = T[s["track"]]["box"] if s["track"] is not None else None
        dst = os.path.join(R, "clips", f"{cid}_s{k:03d}.mp4")
        if not os.path.exists(dst):
            vf = "scale=trunc(iw*sar/2)*2:ih,setsar=1,scale=640:-2"
            if box: vf += f",drawbox=x=iw*{box[0]}:y=ih*{box[1]}:w=iw*{box[2]}:h=ih*{box[3]}:color=yellow@0.8:t=3"
            subprocess.run([FF, "-nostdin", "-v", "error", "-y", "-ss", f"{a:.2f}", "-t", f"{b - a:.2f}", "-i", os.path.join(SRC, name),
                            "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", dst], check=True)
        sc = st.median(W[i]["asd"] for i in s["words"])
        items.append({"clip": cid, "seg": D["segments"].index(s), "i0": s["words"][0], "i1": s["words"][-1], "start": s["start"], "end": s["end"],
                      "text": s["text"], "score": round(sc, 2), "src": f"clips/{cid}_s{k:03d}.mp4"})
    cards.append({"clip": cid, "name": name, "off": round(off, 2), "border": round(border, 2), "items": items})
json.dump(cards, open(os.path.join(R, "items.json"), "w"))
page = open(os.path.join(HERE, "review_template.html")).read().replace("/*DATA*/[]", json.dumps(cards))
page = page.replace('const KEY = "speaker-review-v1";', 'const KEY = "speaker-review-" + ' + json.dumps(KEY) + ';')
open(os.path.join(R, "index.html"), "w").write(page)
print(len(cards), "clips,", sum(len(c["items"]) for c in cards), "segments ->", os.path.join(R, "index.html"))
