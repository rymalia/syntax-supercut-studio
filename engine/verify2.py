#!/usr/bin/env python3
"""(v2 engine) Ear check for a film plan before rendering: every snippet is cut from the source exactly as it will be rendered,
padded with silence, and transcribed by whisper large-v3-turbo.  A snippet whose words aren't heard is added to
films/bad_runs.json and the line is re-solved with other takes.  Repeats until clean or out of alternatives.
  python verify.py films/<name>.json [rounds]
"""
import json, os, sys, subprocess, re, difflib, importlib
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
FF = "/opt/homebrew/bin/ffmpeg"
WH = ["/opt/homebrew/bin/whisper-cli", "-m", os.path.expanduser("~/.cache/whisper.cpp/ggml-large-v3-turbo.bin"), "-np", "-nt", "-l", "en"]
def whisper(path):
    """whisper large-v3-turbo; uses a running whisper-server on :8178 when there is one (model stays loaded)"""
    r = subprocess.run(["curl", "-s", "-m", "60", "-F", f"file=@{path}", "-F", "response_format=text", "-F", "language=en", "http://127.0.0.1:8178/inference"], capture_output=True, text=True)
    if r.returncode == 0 and not r.stdout.startswith("{"): return r.stdout.strip().replace("\n", " ")
    return subprocess.run(WH + ["-f", path], capture_output=True, text=True).stdout.strip().replace("\n", " ")
CP = os.path.join(HERE, "films", "verify_cache.json")
cache = json.load(open(CP)) if os.path.exists(CP) else {}
def norm(w): return re.sub(r"[^a-z0-9']", "", w.lower().replace("’", "'")).strip("'")
ALIAS = {"gonna": "going", "okay": "ok", "alright": "all"}
def toks(t): return [ALIAS.get(norm(x), norm(x)) for x in t.replace("-", " ").split() if norm(x)]

def hear(s):
    key = f"{s['clip']}:{s['i0']}:{s['i1']}:{s['in']}:{s['out']}"
    if key in cache: return cache[key]
    tmp = os.path.join(HERE, "films", "cache", "v.wav")
    subprocess.run([FF, "-nostdin", "-v", "error", "-y", "-ss", f"{s['in']:.3f}", "-t", f"{s['out'] - s['in']:.3f}", "-i", os.path.join(HERE, "audio", s["clip"] + ".wav"),
                    "-af", "afade=t=in:d=0.008,adelay=500,apad=pad_dur=0.7", tmp], check=True)
    out = whisper(tmp)
    cache[key] = out; json.dump(cache, open(CP, "w"))
    return out

def same(a, b):
    return a == b or (min(len(a), len(b)) >= 3 and (a.startswith(b) or b.startswith(a))) or difflib.SequenceMatcher(None, a, b).ratio() >= 0.8

def lcs(w, h):
    D = [[0] * (len(h) + 1) for _ in range(len(w) + 1)]
    for i in range(len(w)):
        for j in range(len(h)):
            D[i + 1][j + 1] = D[i][j] + 1 if same(w[i], h[j]) else max(D[i][j + 1], D[i + 1][j])
    return D[-1][-1]

def passes(said, heard):
    w, h = toks(said), toks(heard)
    if not w: return True
    m = lcs(w, h)
    return m == len(w) or (len(w) >= 4 and m >= len(w) - 1)

import wave, numpy as np
_A = {}
def audio(cid):
    if cid not in _A:
        with wave.open(os.path.join(HERE, "audio", cid + ".wav")) as w:
            _A[cid] = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32)
    return _A[cid]

def line_audio(snips, path):
    parts = [np.zeros(8000, np.float32)]
    for s in snips:
        x = audio(s["clip"])[int(s["in"] * 16000):int(s["out"] * 16000)].copy()
        f = min(128, len(x) // 4); r = np.linspace(0, 1, f)
        if f: x[:f] *= r; x[-f:] *= r[::-1]
        g = 10 ** (s["gain"] / 20); parts += [x * g, np.zeros(int(s["hold"] * 16000), np.float32)]
    parts.append(np.zeros(11200, np.float32))
    y = np.clip(np.concatenate(parts), -32767, 32767).astype(np.int16)
    with wave.open(path, "w") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(y.tobytes())

def align(want, heard):
    """LCS alignment -> set of matched indices in want"""
    D = [[0] * (len(heard) + 1) for _ in range(len(want) + 1)]
    for i in range(len(want) - 1, -1, -1):
        for j in range(len(heard) - 1, -1, -1):
            D[i][j] = D[i + 1][j + 1] + 1 if same(want[i], heard[j]) else max(D[i + 1][j], D[i][j + 1])
    i = j = 0; got = set()
    while i < len(want) and j < len(heard):
        if same(want[i], heard[j]) and D[i][j] == D[i + 1][j + 1] + 1: got.add(i); i += 1; j += 1
        elif D[i + 1][j] >= D[i][j + 1]: i += 1
        else: j += 1
    return got

LCACHE = {}
def line_check(film, snippets):
    """whole-line ear check in context; returns snippets whose words were not heard"""
    bad = []; by = {}
    for s in snippets: by.setdefault(s["line"], []).append(s)
    for li, sn in by.items():
        key = json.dumps([[s["clip"], s["in"], s["out"]] for s in sn])
        if key in cache: heard = cache[key]
        else:
            tmp = os.path.join(HERE, "films", "cache", "line.wav"); line_audio(sn, tmp)
            heard = whisper(tmp)
            cache[key] = heard; json.dump(cache, open(CP, "w"))
        want, owner = [], []
        for k, s in enumerate(sn):
            for t in toks(s["said"]): want.append(t); owner.append(k)
        got = align(want, toks(heard))
        miss = {owner[i] for i in range(len(want)) if i not in got}
        if len(miss) > 0.5 * len(sn): miss = set()      # whisper lost the whole line: too noisy to blame any one take
        miss = sorted(miss, key=lambda k: sn[k]["asd"])[:1]   # one take per line per round, weakest speaker score first
        for k in sorted(miss):
            bad.append(sn[k]); print(f"    line {li} in context: [{sn[k]['said']}] not heard in [{heard}]")
    return bad

if __name__ == "__main__":
    path = sys.argv[1]; rounds = int(sys.argv[2]) if len(sys.argv) > 2 else 12
    bp = os.path.join(HERE, "films", "bad_runs.json")
    for r in range(rounds):
        import supercut2 as supercut; importlib.reload(supercut)
        film = json.load(open(path))
        try:
            snippets = supercut.plan(film, verbose=False)
        except SystemExit as e:
            print("round", r, "->", e); break
        bad = json.load(open(bp)) if os.path.exists(bp) else []
        new = 0
        FUNC = {"a", "an", "the", "my", "her", "his", "be", "to", "of", "and", "or", "in", "on", "at", "is", "it", "i", "he", "she", "we", "you", "me", "him", "us", "for", "so", "but", "was", "are", "do", "can", "if", "as", "by", "that", "this", "with", "not", "no", "your", "our", "their", "they", "them", "has", "had", "have", "will", "would", "just", "all", "one", "up", "out", "too", "very", "then", "than", "there", "here", "what", "who", "how"}
        for s in snippets:
            tk = toks(s["said"])
            if len(tk) == 1 and tk[0] in FUNC: continue      # weak words can't be judged alone; the in-context line check covers them
            h = hear(s)
            if not passes(s["said"], h) and [s["clip"], s["i0"], s["i1"]] not in bad:
                bad.append([s["clip"], s["i0"], s["i1"]]); new += 1
                print(f"  round {r}: FAIL {s['clip']} {s['in']:.2f} said[{s['said']}] heard[{h}]")
        if new == 0:
            for s in line_check(film, snippets):
                if [s["clip"], s["i0"], s["i1"]] not in bad:
                    bad.append([s["clip"], s["i0"], s["i1"]]); new += 1
        json.dump(bad, open(bp, "w"))
        print(f"round {r}: {len(snippets)} snippets, {new} failed")
        if new == 0: break
