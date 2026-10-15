#!/usr/bin/env python3
"""Who is each ASD face track?  facenet (VGGFace2) embeddings per track, clustered within a clip.

  asd/.venv/bin/python identities.py [c01 c02 ...]      (default: every clip with asd/out/<id>.json)
Writes identities/<id>.json  {"track_cluster": {track: cluster}, "clusters": {cluster: {"tracks": n, "frames": n}}}
and identities/<id>.jpg, a strip of one face thumbnail per cluster (labelled), so a person can be named by eye.
"""
import os, sys, json, math, subprocess
import numpy as np, torch, cv2
from scipy.cluster.hierarchy import linkage, fcluster
from scipy.spatial.distance import pdist
HERE = os.path.dirname(os.path.abspath(__file__)); OUTD = os.path.join(HERE, "identities"); os.makedirs(OUTD, exist_ok=True)
from facenet_pytorch import InceptionResnetV1
DEV = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
NET = InceptionResnetV1(pretrained="vggface2").eval().to(DEV)
MIN_H = 0.07; MIN_LEN = 10; W = 640
THR = float(os.environ.get("ID_THR", "0.45")); LINK = os.environ.get("ID_LINK", "average")   # cosine distance for "same person"

def iou(a, b):
    ix = max(0, min(a[0]+a[2], b[0]+b[2]) - max(a[0], b[0])); iy = max(0, min(a[1]+a[3], b[1]+b[3]) - max(a[1], b[1]))
    i = ix * iy; return i / (a[2]*a[3] + b[2]*b[3] - i + 1e-9)

def tracks_for(cid):   # identical to asd_run.tracks_for
    frames = sorted((json.loads(l) for l in open(os.path.join(HERE, "faces", cid + ".jsonl"))), key=lambda f: f["t"])
    tracks = []
    for fi, fr in enumerate(frames):
        for face in fr["f"]:
            if face[3] < MIN_H * 0.8: continue
            best, bi = 0.3, None
            for ti, tr in enumerate(tracks):
                if fi - tr["pts"][-1][0] > 3 or tr["pts"][-1][0] == fi: continue
                v = iou(face[:4], tr["pts"][-1][2])
                if v > best: best, bi = v, ti
            if bi is None: tracks.append({"pts": []}); bi = len(tracks) - 1
            tracks[bi]["pts"].append((fi, fr["t"], face[:4]))
    out = []
    for tr in tracks:
        if len(tr["pts"]) < MIN_LEN: continue
        if np.median([p[2][3] for p in tr["pts"]]) < MIN_H: continue
        ts = np.array([p[1] for p in tr["pts"]])
        tr["f0"] = int(math.ceil(ts[0] * 25)); tr["box"] = [float(np.median([p[2][k] for p in tr["pts"]])) for k in range(4)]
        out.append(tr)
    return out

def shot_changes(cid):
    d = os.path.join(HERE, "shots"); os.makedirs(d, exist_ok=True); p = os.path.join(d, cid + ".json")
    if os.path.exists(p): return json.load(open(p))
    import re
    r = subprocess.run(["/opt/homebrew/bin/ffmpeg", "-nostdin", "-hide_banner", "-i", os.path.join(HERE, "proxy", cid + ".mp4"), "-vf", "select='gt(scene,0.12)',showinfo", "-f", "null", "-"], capture_output=True, text=True)
    ts = [float(m) for m in re.findall(r"pts_time:([\d.]+)", r.stderr)]
    json.dump(ts, open(p, "w")); return ts

def run(cid):
    dst = os.path.join(OUTD, cid + ".json")
    if os.path.exists(dst) and "--force" not in sys.argv: return
    res = json.load(open(os.path.join(HERE, "asd", "out", cid + ".json")))["tracks"]
    cand = tracks_for(cid)
    # match each scored track to a raw track by f0 + median box
    match = []
    for r in res:
        best = min(cand, key=lambda t: abs(t["f0"] - r["f0"]) * 10 + sum(abs(a - b) for a, b in zip(t["box"], r["box"])))
        match.append(best)
    # split every track at shot changes (a track can survive a cut between two people framed alike)
    cuts = shot_changes(cid)
    pieces = []     # (track index, [pts])
    for ti, tr in enumerate(match):
        cur = []; ci = 0
        for p_ in tr["pts"]:
            while ci < len(cuts) and cuts[ci] <= p_[1]:
                if cur: pieces.append((ti, cur)); cur = []
                ci += 1
            cur.append(p_)
        if cur: pieces.append((ti, cur))
    want = {}   # proxy frame index (10 fps) -> [(piece index, box)]
    for pi, (ti, pts) in enumerate(pieces):
        n = len(pts)
        for q in ((0.15, 0.3, 0.5, 0.7, 0.85) if n >= 10 else (0.5,)):
            fi, t, box = pts[min(int(q * n), n - 1)]
            want.setdefault(int(round(t * 10)), []).append((pi, box))
    proxy = os.path.join(HERE, "proxy", cid + ".mp4")
    pr = subprocess.run(["/opt/homebrew/bin/ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", proxy], capture_output=True, text=True)
    pw, ph = [int(x) for x in pr.stdout.strip().split(",")[:2]]
    p = subprocess.Popen(["/opt/homebrew/bin/ffmpeg", "-nostdin", "-v", "error", "-i", proxy, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
    size = pw * ph * 3; fi = 0; crops = {}; thumbs = {}
    while True:
        buf = p.stdout.read(size)
        if len(buf) < size: break
        if fi in want:
            img = np.frombuffer(buf, np.uint8).reshape(ph, pw, 3)
            for ti, (x, y, w, h) in want[fi]:
                cx, cy, s = (x + w / 2) * pw, (y + h / 2) * ph, max(w * pw, h * ph) * 1.3
                x0, y0, x1, y1 = int(max(cx - s / 2, 0)), int(max(cy - s / 2, 0)), int(min(cx + s / 2, pw)), int(min(cy + s / 2, ph))
                face = img[y0:y1, x0:x1]
                if face.size == 0: continue
                face = cv2.resize(face, (160, 160)); crops.setdefault(ti, []).append(face)
                thumbs.setdefault(ti, face)
        fi += 1
    p.wait()
    emb = {}
    with torch.no_grad():
        for ti, fs in crops.items():
            x = torch.tensor(np.stack(fs)).permute(0, 3, 1, 2).float().to(DEV); x = (x - 127.5) / 128.0
            e = NET(x).cpu().numpy(); e /= np.linalg.norm(e, axis=1, keepdims=True); m = e.mean(0); emb[ti] = m / np.linalg.norm(m)
    tis = sorted(emb)
    if len(tis) >= 2:
        Z = linkage(np.stack([emb[t] for t in tis]), LINK, metric="cosine")
        lab = fcluster(Z, THR, "distance")
    else:
        lab = [1] * len(tis)
    pc = {int(t): int(l) - 1 for t, l in zip(tis, lab)}          # piece -> cluster
    segs = {}; clusters = {}; tc = {}
    for pi, l in pc.items():
        ti, pts = pieces[pi]
        segs.setdefault(ti, []).append([round(pts[0][1], 2), round(pts[-1][1] + 0.1, 2), l])
        c = clusters.setdefault(l, {"tracks": 0, "frames": 0, "pieces": 0}); c["pieces"] += 1; c["frames"] += int(round(len(pts) * 2.5))
    for ti, sg in segs.items():
        best = {}
        for a, b, l in sg: best[l] = best.get(l, 0) + (b - a)
        tc[ti] = max(best, key=best.get); clusters[tc[ti]]["tracks"] += 1
    order = sorted(clusters, key=lambda l: -clusters[l]["frames"])
    strip = []
    for l in order:
        pi = max((p for p in pc if pc[p] == l), key=lambda p: len(pieces[p][1]))
        im = cv2.cvtColor(thumbs[pi], cv2.COLOR_RGB2BGR).copy()
        cv2.putText(im, f"{cid}/{l}", (4, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 255), 2)
        cv2.putText(im, f"{clusters[l]['frames'] // 25}s", (4, 150), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 2)
        strip.append(im)
    if strip:
        per = 8; rows = []
        for i in range(0, len(strip), per):
            row = strip[i:i + per]
            while len(row) < per: row.append(np.zeros((160, 160, 3), np.uint8))
            rows.append(np.concatenate(row, 1))
        cv2.imwrite(os.path.join(OUTD, cid + ".jpg"), np.concatenate(rows, 0))
    json.dump({"id": cid, "track_cluster": tc, "segments": {str(t): v for t, v in segs.items()}, "clusters": {str(l): clusters[l] for l in order},
               "emb": {str(p): [round(float(v), 4) for v in emb[p]] for p in tis}}, open(dst, "w"))
    print(cid, len(res), "tracks ->", len(clusters), "people", flush=True)

if __name__ == "__main__":
    ids = [a for a in sys.argv[1:] if not a.startswith("--")] or [f[:-5] for f in sorted(os.listdir(os.path.join(HERE, "asd", "out"))) if f.endswith(".json")]
    for cid in ids:
        try: run(cid)
        except Exception as e: print("FAILED", cid, e, flush=True)
