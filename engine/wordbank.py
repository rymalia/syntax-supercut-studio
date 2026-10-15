#!/usr/bin/env python3
"""Join parakeet words with Light-ASD speaker scores -> on-screen-speaker transcripts + global word bank.

  python3 wordbank.py
Outputs (all in talking_heads/):
  words/<id>.json          every word: w, n, start, end, conf, asd (best speaking-face score), track, onscreen
  onscreen/<id>.md         readable transcript of only the qualifying portions, segment + word timestamps
  onscreen_words.csv       one row per qualifying word (clip, segment, word, start, end, conf, asd)
  wordbank.json            normalized word -> [[clip, word index], ...]  (qualifying words only)
  summary.md               per-clip coverage table
"""
import json, os, csv, math
import numpy as np
import analyze as A
HERE = A.HERE
THR = 1.0          # mean Light-ASD/LR-ASD logit; > 0 is the models' own cut, 1.0 is calibrated on Ryan's review
                   # (keeps 85% of segments he marked speaking, drops 62% of those he marked voice-over)
STRICT = {"c02": 2.0, "c03": 2.0, "c15": 2.0, "c20": 2.0, "c25": 2.0}   # half or more of the reviewed segments were voice-over
REVIEW = os.path.join(HERE, "review", "decisions.json")
DEC = json.load(open(REVIEW))["decisions"] if os.path.exists(REVIEW) else []
FILL_THR = -1.0    # a word between two on-screen words of the same face is kept if it scores above this
SEG_GAP = 0.8

def fmt(t): return f"{int(t // 60):02d}:{t % 60:05.2f}"

def score_words(cid, words):
    path = os.path.join(HERE, "asd", "out", cid + ".json")
    T = json.load(open(path))["tracks"] if os.path.exists(path) else []
    lr = os.path.join(HERE, "asd", "out_lr", cid + ".json")
    if os.path.exists(lr):   # ensemble with LR-ASD (same tracks, same crops)
        T2 = json.load(open(lr))["tracks"]
        if len(T2) == len(T) and all(a["f0"] == b["f0"] for a, b in zip(T, T2)):
            for a, b in zip(T, T2):
                n = min(len(a["scores"]), len(b["scores"]))
                a["scores"] = [(x + y) / 2 for x, y in zip(a["scores"][:n], b["scores"][:n])]
    for w in words:
        a, b = int(math.floor(w["start"] * 25)), int(math.ceil(w["end"] * 25))
        best, bt, bh = -99.0, None, 0.0
        for ti, tr in enumerate(T):
            s = np.array(tr["scores"]); lo, hi = max(a - tr["f0"], 0), min(b - tr["f0"], len(s))
            if hi - lo < max(1, (b - a) // 2): continue
            # smooth like the Light-ASD demo (±2 frames)
            seg = s[max(lo - 2, 0):min(hi + 2, len(s))]
            m = float(seg.mean())
            if m > best: best, bt, bh = m, ti, tr["h"]
        w["asd"], w["track"], w["face_h"] = round(best, 2), bt, bh
        w["onscreen"] = best > STRICT.get(cid, THR)
    # the human review wins over the model, both ways
    for d in DEC:
        if d["clip"] != cid: continue
        for i in range(d["i0"], min(d["i1"] + 1, len(words))):
            words[i]["onscreen"] = d["verdict"] == "speaking"; words[i]["reviewed"] = d["verdict"]
    for i in range(1, len(words) - 1):
        p, w, n = words[i - 1], words[i], words[i + 1]
        if not w["onscreen"] and "reviewed" not in w and p["onscreen"] and n["onscreen"] and p["track"] == n["track"] == w["track"] \
           and w["asd"] > FILL_THR and n["start"] - p["end"] < 1.5:
            w["onscreen"] = True; w["filled"] = True
    return words

def main():
    bank, rows, summary = {}, [], []
    os.makedirs(os.path.join(HERE, "words"), exist_ok=True); os.makedirs(os.path.join(HERE, "onscreen"), exist_ok=True)
    for cid, name in A.clips():
        if not os.path.exists(os.path.join(HERE, "transcripts", cid + ".json")): continue
        if not os.path.exists(os.path.join(HERE, "asd", "out", cid + ".json")): continue
        words, J = A.load_words(cid)
        score_words(cid, words)
        segs, cur = [], None
        for w in words:
            if w["onscreen"] and cur and w["start"] - words[cur["words"][-1]]["end"] < SEG_GAP and w["track"] == cur["track"]:
                cur["words"].append(w["i"])
            elif w["onscreen"]:
                cur = {"track": w["track"], "words": [w["i"]]}; segs.append(cur)
            else:
                cur = None
        for k, s in enumerate(segs):
            s["start"], s["end"] = words[s["words"][0]]["start"], words[s["words"][-1]]["end"]
            s["text"] = " ".join(words[i]["w"] for i in s["words"])
            for i in s["words"]: words[i]["seg"] = k
        json.dump({"id": cid, "name": name, "words": words, "segments": segs}, open(os.path.join(HERE, "words", cid + ".json"), "w"))
        on = [w for w in words if w["onscreen"]]
        for w in on:
            bank.setdefault(w["n"], []).append([cid, w["i"]])
            rows.append([cid, name, w["seg"], w["i"], w["w"], w["n"], w["start"], w["end"], round(w["conf"], 3), w["asd"]])
        with open(os.path.join(HERE, "onscreen", cid + ".md"), "w") as f:
            f.write(f"# {cid} — {name}\n\n{len(on)} of {len(words)} words spoken by an on-screen face, in {len(segs)} segments.\n\n")
            for k, s in enumerate(segs):
                f.write(f"## Segment {k}  [{fmt(s['start'])} – {fmt(s['end'])}]  face track {s['track']}\n\n{s['text']}\n\n")
                f.write(" ".join(f"{words[i]['w']}<sub>{words[i]['start']:.2f}</sub>" for i in s["words"]) + "\n\n")
        summary.append((cid, name, len(words), len(on), len(segs), sum(s["end"] - s["start"] for s in segs)))
    with open(os.path.join(HERE, "onscreen_words.csv"), "w", newline="") as f:
        c = csv.writer(f); c.writerow(["clip", "clip_name", "segment", "word_index", "word", "norm", "start", "end", "conf", "asd"]); c.writerows(rows)
    json.dump(bank, open(os.path.join(HERE, "wordbank.json"), "w"))
    with open(os.path.join(HERE, "summary.md"), "w") as f:
        f.write("| clip | name | words | on-screen | segments | on-screen secs |\n|---|---|---|---|---|---|\n")
        for r in summary: f.write(f"| {r[0]} | {r[1]} | {r[2]} | {r[3]} | {r[4]} | {r[5]:.0f} |\n")
    print(len(summary), "clips;", sum(r[2] for r in summary), "words;", sum(r[3] for r in summary), "on-screen;", len(bank), "distinct")

if __name__ == "__main__":
    main()
