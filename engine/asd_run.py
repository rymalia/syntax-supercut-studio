#!/usr/bin/env python3
"""Light-ASD active-speaker scores for every face track of a clip.

  .venv/bin/python asd_run.py c01 [c02 ...]
Face boxes come from the Apple Vision pass (faces/<id>.jsonl, 10 fps); they are interpolated to 25 fps,
cropped from the original video exactly like Light-ASD's Columbia demo (crop scale 0.40, 224 -> centre 112),
and scored against MFCC audio.  Writes asd/out/<id>.json:
  {"tracks":[{"f0":first 25fps frame, "scores":[...per 25fps frame...], "h":median face height, "box":[x,y,w,h] median}]}
Score > 0 = this face is speaking (Light-ASD logit).
"""
import os, sys, json, math, subprocess
import numpy as np, torch, cv2
from scipy import signal
from scipy.io import wavfile
import python_speech_features
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
REPO = os.environ.get("ASD_REPO", "Light-ASD"); OUTDIR = "out_lr" if REPO == "LR-ASD" else "out"
sys.path.insert(0, os.path.join(HERE, REPO))
from model.Model import ASD_Model
from loss import lossAV
SRC = os.path.expanduser("~/Downloads/talking-heads-videos")
W = 640           # decode width
MIN_H = 0.07      # ignore faces smaller than this share of frame height
MIN_LEN = 10      # 10-fps samples (1 s) minimum track length

class Net(torch.nn.Module):
    def __init__(self):
        super().__init__(); self.model = ASD_Model(); self.lossAV = lossAV()
net = Net(); st = net.state_dict()
for k, v in torch.load(os.path.join(HERE, REPO, "weight/finetuning_TalkSet.model"), map_location="cpu").items():
    k2 = k.replace("module.", "")
    if k2 in st and st[k2].shape == v.shape: st[k2].copy_(v)
net.eval()
DEV = torch.device(os.environ.get("DEVICE", "mps" if torch.backends.mps.is_available() else "cpu"))
net.to(DEV)

def iou(a, b):
    ix = max(0, min(a[0]+a[2], b[0]+b[2]) - max(a[0], b[0])); iy = max(0, min(a[1]+a[3], b[1]+b[3]) - max(a[1], b[1]))
    i = ix * iy; return i / (a[2]*a[3] + b[2]*b[3] - i + 1e-9)

def tracks_for(cid):
    frames = sorted((json.loads(l) for l in open(os.path.join(ROOT, "faces", cid + ".jsonl"))), key=lambda f: f["t"])
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
        hs = [p[2][3] for p in tr["pts"]]
        if np.median(hs) < MIN_H: continue
        out.append(tr)
    return out

def run(cid, name):
    dst = os.path.join(HERE, OUTDIR, cid + ".json")
    if os.path.exists(dst): return
    tracks = tracks_for(cid)
    # interpolate each track to 25 fps frame indices
    for tr in tracks:
        ts = np.array([p[1] for p in tr["pts"]]); bx = np.array([p[2] for p in tr["pts"]])
        f0, f1 = int(math.ceil(ts[0] * 25)), int(math.floor(ts[-1] * 25))
        fr = np.arange(f0, f1 + 1); tt = fr / 25.0
        b = np.stack([np.interp(tt, ts, bx[:, k]) for k in range(4)], 1)
        tr["f0"], tr["fr"], tr["b"] = f0, fr, b; tr["crops"] = []
    tracks = [t for t in tracks if len(t["fr"]) >= 25]
    p = subprocess.Popen(["/opt/homebrew/bin/ffmpeg", "-nostdin", "-v", "error", "-hwaccel", "videotoolbox", "-i", os.path.join(SRC, name), "-an",
                          "-vf", f"fps=25,scale={W}:-2,format=gray", "-f", "rawvideo", "-"], stdout=subprocess.PIPE)
    probe = subprocess.run(["/opt/homebrew/bin/ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,sample_aspect_ratio", "-of", "json", os.path.join(SRC, name)], capture_output=True, text=True)
    s0 = json.loads(probe.stdout)["streams"][0]; H = int(round(W * s0["height"] / s0["width"] / 2) * 2)
    # pixel box (center/size smoothed like the demo)
    for tr in tracks:
        x, y, w, h = tr["b"][:, 0] * W, tr["b"][:, 1] * H, tr["b"][:, 2] * W, tr["b"][:, 3] * H
        k = 13 if len(x) >= 13 else (len(x) // 2) * 2 - 1
        tr["s"] = signal.medfilt(np.maximum(w, h) / 2 * 1.1, k); tr["cx"] = signal.medfilt(x + w / 2, k); tr["cy"] = signal.medfilt(y + h / 2 - h * 0.05, k)
    by_frame = {}
    for ti, tr in enumerate(tracks):
        for j, f in enumerate(tr["fr"]): by_frame.setdefault(int(f), []).append((ti, j))
    fi = 0; size = W * H
    while True:
        buf = p.stdout.read(size)
        if len(buf) < size: break
        if fi in by_frame:
            img = np.frombuffer(buf, np.uint8).reshape(H, W)
            for ti, j in by_frame[fi]:
                tr = tracks[ti]; cs = 0.40; bs = tr["s"][j]; bsi = int(bs * (1 + 2 * cs))
                pad = np.pad(img, ((bsi, bsi), (bsi, bsi)), "constant", constant_values=110)
                my, mx = tr["cy"][j] + bsi, tr["cx"][j] + bsi
                face = pad[int(my - bs):int(my + bs * (1 + 2 * cs)), int(mx - bs * (1 + cs)):int(mx + bs * (1 + cs))]
                if face.size == 0: face = np.full((224, 224), 110, np.uint8)
                face = cv2.resize(face, (224, 224))[56:168, 56:168]
                tr["crops"].append((fi, face))
        fi += 1
    p.wait()
    sr, audio = wavfile.read(os.path.join(ROOT, "audio", cid + ".wav"))
    mfcc = python_speech_features.mfcc(audio, 16000, numcep=13, winlen=0.025, winstep=0.010)
    res = []
    for tr in tracks:
        if len(tr["crops"]) < 25: continue
        fstart = tr["crops"][0][0]; vid = np.array([c[1] for c in tr["crops"]])
        aud = mfcc[fstart * 4: (fstart + len(vid)) * 4]
        length = min((aud.shape[0] - aud.shape[0] % 4) / 100, vid.shape[0] / 25)
        aud = aud[:int(round(length * 100))]; vid = vid[:int(round(length * 25))]
        if len(vid) < 25: continue
        allS = []
        for dur in (1, 2, 3, 4, 6):
            sc = []
            with torch.no_grad():
                for i in range(int(math.ceil(length / dur))):
                    a = torch.FloatTensor(aud[i*dur*100:(i+1)*dur*100]).unsqueeze(0).to(DEV); v = torch.FloatTensor(vid[i*dur*25:(i+1)*dur*25]).unsqueeze(0).to(DEV)
                    if a.shape[1] < 4 or v.shape[1] < 1: continue
                    # audio frames must be 4x video frames
                    n = min(a.shape[1] // 4, v.shape[1]); a = a[:, :n*4]; v = v[:, :n]
                    out = net.model.forward_audio_visual_backend(net.model.forward_audio_frontend(a), net.model.forward_visual_frontend(v))
                    sc.extend(net.lossAV.forward(out, labels=None))
            allS.append(sc[:len(vid)])
        m = min(len(s) for s in allS); score = np.mean([s[:m] for s in allS], 0)
        res.append({"f0": int(fstart), "scores": [round(float(x), 2) for x in score], "h": round(float(np.median(tr["b"][:, 3])), 3),
                    "box": [round(float(np.median(tr["b"][:, k])), 3) for k in range(4)]})
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    json.dump({"id": cid, "tracks": res}, open(dst, "w"))
    print(cid, len(res), "tracks", flush=True)

if __name__ == "__main__":
    torch.set_num_threads(int(os.environ.get("THREADS", "3")))
    clips = dict(l.rstrip("\n").split("\t")[:2] for l in open(os.path.join(ROOT, "clips.tsv")))
    for cid in sys.argv[1:]:
        if not os.path.exists(os.path.join(ROOT, "faces", cid + ".jsonl.done")): print("skip (faces not ready)", cid); continue
        run(cid, clips[cid])
