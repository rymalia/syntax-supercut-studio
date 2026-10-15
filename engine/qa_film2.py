#!/usr/bin/env python3
"""QA a rendered film (v2 gate):
  1. cold listen: the whole soundtrack transcribed once by whisper large-v3-turbo with no script or line hints,
     aligned to the script -> words heard, ghost words inserted  (gate: >= 95% heard, <= 2 ghosts)
  2. per-line whisper diff (as before)
  3. acoustic report from the render: level jumps across cuts, quiet snippets, snippet lengths, cuts/second, hold floor
  4. contact sheet (one labelled frame per snippet)
  python qa_film2.py <name> [--no-sheet]
"""
import json, os, sys, subprocess, re, difflib, wave
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); OUT = os.path.join(HERE, "films", "out"); FF = "/opt/homebrew/bin/ffmpeg"
WHC = ["/opt/homebrew/bin/whisper-cli", "-m", os.path.expanduser("~/.cache/whisper.cpp/ggml-large-v3-turbo.bin"), "-np", "-nt", "-l", "en"]
def norm(w): return re.sub(r"[^a-z0-9']", "", w.lower().replace("’", "'")).strip("'")
def toks(t): return [norm(x) for x in t.replace("-", " ").split() if norm(x)]

def whisper(path, beam=True):
    r = subprocess.run(["curl", "-s", "-m", "120", "-F", f"file=@{path}", "-F", "response_format=text", "-F", "language=en", "http://127.0.0.1:8178/inference"], capture_output=True, text=True)
    if r.returncode == 0 and r.stdout.strip() and not r.stdout.startswith("{"): return r.stdout.strip().replace("\n", " ")
    return subprocess.run(WHC + (["-bo", "8", "-bs", "8"] if beam else []) + ["-f", path], capture_output=True, text=True).stdout.strip().replace("\n", " ")

name = sys.argv[1]
mp4 = os.path.join(OUT, name + ".mp4"); plan = json.load(open(os.path.join(OUT, name + ".plan.json")))
film = json.load(open(os.path.join(HERE, "films", name + ".json")))
tmp = os.path.join(HERE, "films", "qa", name); os.makedirs(tmp, exist_ok=True)
wav = os.path.join(tmp, "a.wav")
subprocess.run([FF, "-nostdin", "-v", "error", "-y", "-i", mp4, "-ar", "16000", "-ac", "1", wav], check=True)

# 1. cold listen (on the dry dialogue stem when the engine wrote one, so a music bed can't make whisper hallucinate)
dry = os.path.join(HERE, "films", "cache", name + "_v2_mix_dry.wav"); cold_src = wav
if os.path.exists(dry) and os.path.getmtime(dry) <= os.path.getmtime(mp4) + 600:
    cold_src = os.path.join(tmp, "dry16.wav"); subprocess.run([FF, "-nostdin", "-v", "error", "-y", "-i", dry, "-ar", "16000", "-ac", "1", cold_src], check=True)
cold = whisper(cold_src)
ref = toks(" ".join(l["text"] for l in film["lines"])); hyp = toks(cold)
sm = difflib.SequenceMatcher(a=ref, b=hyp, autojunk=False)
heard = sum(b.size for b in sm.get_matching_blocks())
ghosts = sum(b2 - b1 for op, a1, a2, b1, b2 in sm.get_opcodes() if op in ("insert", "replace"))
missed = [" ".join(ref[a1:a2]) for op, a1, a2, b1, b2 in sm.get_opcodes() if op in ("delete", "replace")]
gate = heard >= 0.95 * len(ref) and ghosts <= 2
print(f"{name}: COLD LISTEN {heard}/{len(ref)} words heard ({100 * heard / max(len(ref), 1):.0f}%), {ghosts} ghost/wrong words -> {'PASS' if gate else 'FAIL'}")
print(f"  heard: {cold}")
if missed: print(f"  missed/mangled: {missed}")

# 2. per-line
lines = {}
for s_ in plan:
    L = lines.setdefault(s_["line"], [s_["t"], 0]); L[1] = s_["t"] + s_["out"] - s_["in"] + s_["hold"]
tot = good = 0; report = []
for li, (a, b) in sorted(lines.items()):
    seg = os.path.join(tmp, f"l{li:02d}.wav")
    subprocess.run([FF, "-nostdin", "-v", "error", "-y", "-ss", f"{max(a - 0.05, 0):.3f}", "-t", f"{b - a + 0.1:.3f}", "-i", wav, "-af", "adelay=400,apad=pad_dur=0.6", seg], check=True)
    ht = whisper(seg, beam=False)
    want = toks(film["lines"][li]["text"]); h = toks(ht)
    m = sum(x.size for x in difflib.SequenceMatcher(None, want, h, autojunk=False).get_matching_blocks())
    tot += len(want); good += m
    report.append(f"{'  ' if m == len(want) else '!!'} L{li:02d} {m}/{len(want)}  script: {film['lines'][li]['text']}\n        heard:  {ht}")
print(f"  per-line word match {good}/{tot} ({100 * good / max(tot, 1):.0f}%)")
print("\n".join(report))

# 3. acoustic
with wave.open(wav) as w: y = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
def db(x): return float(20 * np.log10(np.sqrt((x ** 2).mean()) + 1e-9)) if len(x) else -99.0
lv = []; floors = []
for s in plan:
    a, b = int(s["t"] * 16000), int((s["t"] + s["out"] - s["in"]) * 16000); lv.append(db(y[a:b]))
    if s["hold"] >= 0.3: floors.append(db(y[b + 800: b + int(s["hold"] * 16000) - 800]))
jumps = [abs(p - q) for p, q in zip(lv, lv[1:])]
durs = [s["out"] - s["in"] for s in plan]; speech = sum(durs)
ac = {"snippets": len(plan), "lines": len(lines), "takes_per_line": round(len(plan) / len(lines), 2), "median_snip_s": round(float(np.median(durs)), 2),
      "min_snip_s": round(min(durs), 2), "cuts_per_speech_s": round((len(plan) - len(lines)) / max(speech, 0.1), 2),
      "level_jumps_gt6dB": sum(j > 6 for j in jumps), "level_sd_dB": round(float(np.std(lv)), 1), "quietest_snip_dB": round(min(lv), 1),
      "hold_floor_dB": round(float(np.median(floors)), 1) if floors else None, "single_word": sum(len(s["said"].split()) == 1 for s in plan)}
print("  acoustic:", json.dumps(ac))
json.dump({"cold": cold, "heard": heard, "total": len(ref), "ghosts": ghosts, "gate": gate, "missed": missed, "line_match": good, "line_total": tot, "report": report, "acoustic": ac},
          open(os.path.join(OUT, name + ".qa.json"), "w"), indent=1)

# 4. contact sheet
if "--no-sheet" not in sys.argv:
    for f in os.listdir(tmp):
        if f.startswith("f") and f.endswith(".jpg"): os.remove(os.path.join(tmp, f))
    frames = []
    for k, s in enumerate(plan):
        t = s["t"] + (s["out"] - s["in"]) / 2; f = os.path.join(tmp, f"f{k:03d}.jpg")
        lab = f"{k} {s['clip']} {s['said']}".replace(":", " ").replace("'", "")[:40]
        subprocess.run([FF, "-nostdin", "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", mp4, "-frames:v", "1", "-vf",
                        f"scale=384:216,drawtext=fontfile=/System/Library/Fonts/SFNS.ttf:text='{lab}':x=6:y=6:fontsize=16:fontcolor=yellow:box=1:boxcolor=black@0.6", f], check=True)
        frames.append(f)
    cols = 6
    for page in range(0, len(frames), 36):
        chunk = frames[page:page + 36]; sheet = os.path.join(OUT, f"{name}.sheet{page // 36}.jpg"); rows = (len(chunk) + cols - 1) // cols
        subprocess.run([FF, "-nostdin", "-v", "error", "-y", "-framerate", "1", "-start_number", str(page), "-i", os.path.join(tmp, "f%03d.jpg"),
                        "-frames:v", "1", "-vf", f"tile={cols}x{rows}:padding=4", sheet], check=True)
        print("  sheet", sheet)
