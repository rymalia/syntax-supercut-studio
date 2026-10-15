#!/usr/bin/env python3
"""Per clip: parakeet words + Vision face tracks -> which words are spoken while the talking head is on screen.

  python3 analyze.py [--stats] [ids...]
Writes words/<id>.json  (all words with on-screen flags + scores) and prints per-clip coverage.
"""
import json, os, sys, re, statistics as st
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
FPS = 10.0
MIN_FACE_H = 0.09       # face box height / frame height: smaller = crowd/background face
ACT_T = 0.012           # mouth-activity threshold (std of inner-lip opening / face height over ±0.6 s)
WIN = 6                 # frames each side for the activity window
COVER = 0.5             # share of a word's frames that must show an active visible face

def clips():
    return [l.rstrip("\n").split("\t") for l in open(os.path.join(HERE, "clips.tsv"))]

def norm(w):
    return re.sub(r"[^a-z0-9']", "", w.lower().replace("’", "'")).strip("'")

def load_words(cid):
    J = json.load(open(os.path.join(HERE, "transcripts", cid + ".json")))
    words = []
    for si, s in enumerate(J["sentences"]):
        for t in s["tokens"]:
            txt = t["text"]
            if txt.startswith(" ") or not words or words[-1]["s_i"] != si:
                words.append({"w": txt.strip(), "start": t["start"], "end": t["end"], "conf": t.get("confidence", 1.0), "s_i": si})
            else:
                w = words[-1]; w["w"] += txt; w["end"] = max(w["end"], t["end"]); w["conf"] = min(w["conf"], t.get("confidence", 1.0))
    out = []
    for w in words:
        n = norm(w["w"])
        if not n:            # stray punctuation token
            if out: out[-1]["w"] += w["w"]
            continue
        w["n"] = n; out.append(w)
    for i, w in enumerate(out): w["i"] = i
    return out, J

def iou(a, b):
    ax1, ay1, ax2, ay2 = a[0], a[1], a[0] + a[2], a[1] + a[3]
    bx1, by1, bx2, by2 = b[0], b[1], b[0] + b[2], b[1] + b[3]
    iw, ih = max(0, min(ax2, bx2) - max(ax1, bx1)), max(0, min(ay2, by2) - max(ay1, by1))
    inter = iw * ih
    return inter / (a[2] * a[3] + b[2] * b[3] - inter + 1e-9)

def load_faces(cid):
    frames = [json.loads(l) for l in open(os.path.join(HERE, "faces", cid + ".jsonl"))]
    frames.sort(key=lambda f: f["t"])
    # simple IoU tracker
    tracks = []   # each: {"last": bbox, "lt": frame idx, "pts": [(fi, face)]}
    for fi, fr in enumerate(frames):
        fr["tid"] = []
        for face in fr["f"]:
            best, bi = 0.25, None
            for ti, tr in enumerate(tracks):
                if fi - tr["lt"] > 5: continue
                v = iou(face[:4], tr["last"])
                if v > best: best, bi = v, ti
            if bi is None:
                tracks.append({"last": face[:4], "lt": fi, "pts": []}); bi = len(tracks) - 1
            tr = tracks[bi]; tr["last"] = face[:4]; tr["lt"] = fi; tr["pts"].append((fi, face))
            fr["tid"].append(bi)
    n = len(frames)
    # activity per frame: max over visible, big-enough faces of the std of inner-lip opening in its track
    act = np.zeros(n); big = np.zeros(n, bool)
    for tr in tracks:
        fis = np.array([p[0] for p in tr["pts"]]); mi = np.array([p[1][4] for p in tr["pts"]]); hs = np.array([p[1][3] for p in tr["pts"]])
        for k, fi in enumerate(fis):
            if hs[k] < MIN_FACE_H or mi[k] < 0: continue
            big[fi] = True
            sel = (fis >= fi - WIN) & (fis <= fi + WIN) & (mi >= 0)
            if sel.sum() < 5: continue
            a = float(np.std(mi[sel]))
            if a > act[fi]: act[fi] = a
    t = np.array([f["t"] for f in frames])
    return t, act, big, frames

def analyze(cid, name, stats=None):
    words, J = load_words(cid)
    t, act, big, frames = load_faces(cid)
    speaking = np.zeros(len(t), bool)
    for w in words:
        speaking[(t >= w["start"]) & (t <= w["end"])] = True
    if stats is not None:
        stats["speech"] += list(act[speaking & big]); stats["silent"] += list(act[~speaking & big])
    vis = big & (act >= ACT_T)
    for w in words:
        sel = (t >= w["start"] - 0.05) & (t <= w["end"] + 0.05)
        if not sel.any():
            k = int(np.argmin(abs(t - (w["start"] + w["end"]) / 2))); sel = np.zeros(len(t), bool); sel[k] = True
        w["face"] = round(float(big[sel].mean()), 2)
        w["act"] = round(float(act[sel].mean()), 4)
        w["onscreen"] = bool(vis[sel].mean() >= COVER)
    # smooth: a lone off word between on words (gap < 0.4 s) counts as on; lone on words amid off are dropped
    for i in range(1, len(words) - 1):
        a, b, c = words[i - 1], words[i], words[i + 1]
        if a["onscreen"] and c["onscreen"] and not b["onscreen"] and c["start"] - a["end"] < 1.2 and b["face"] >= 0.5:
            b["onscreen"] = True; b["smoothed"] = True
    for i, w in enumerate(words):
        nb = [words[j]["onscreen"] for j in (i - 1, i + 1) if 0 <= j < len(words) and abs(words[j]["start"] - w["start"]) < 1.5]
        if w["onscreen"] and nb and not any(nb) and w["act"] < ACT_T * 1.5:
            w["onscreen"] = False; w["isolated"] = True
    # qualifying segments
    segs, cur = [], None
    for w in words:
        if w["onscreen"] and cur and w["start"] - cur["end"] < 0.8:
            cur["end"] = w["end"]; cur["words"].append(w["i"])
        elif w["onscreen"]:
            cur = {"start": w["start"], "end": w["end"], "words": [w["i"]]}; segs.append(cur)
        else:
            cur = None if not cur or w["start"] - cur["end"] > 0.3 else cur
            if cur is not None and not w["onscreen"]: cur = None
    for s in segs: s["text"] = " ".join(words[i]["w"] for i in s["words"])
    dur = float(frames[-1]["t"]) if frames else 0
    res = {"id": cid, "name": name, "duration": dur, "n_words": len(words), "n_onscreen": sum(w["onscreen"] for w in words),
           "words": words, "segments": segs}
    os.makedirs(os.path.join(HERE, "words"), exist_ok=True)
    json.dump(res, open(os.path.join(HERE, "words", cid + ".json"), "w"), indent=0)
    return res

if __name__ == "__main__":
    a = sys.argv[1:]; want_stats = "--stats" in a; ids = [x for x in a if not x.startswith("--")]
    stats = {"speech": [], "silent": []} if want_stats else None
    for cid, name in clips():
        if ids and cid not in ids: continue
        if not os.path.exists(os.path.join(HERE, "faces", cid + ".jsonl.done")) or not os.path.exists(os.path.join(HERE, "transcripts", cid + ".json")):
            continue
        r = analyze(cid, name, stats)
        print(f"{cid} {r['n_onscreen']:5d}/{r['n_words']:5d} words on-screen  {len(r['segments']):3d} segs  {name[:60]}")
    if stats:
        for k in stats:
            v = np.array(stats[k]); print(k, len(v), "pct10/25/50/75/90:", np.round(np.percentile(v, [10, 25, 50, 75, 90]), 4) if len(v) else "-")
