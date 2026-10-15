#!/usr/bin/env python3
"""Talking-head supercut engine, v2 (phrase-first).  Assembles a film from a script using only on-screen-speaker words.

  python supercut2.py films/<name>.json [--plan-only] [--draft]

Differences from supercut.py (v1), all driven by the 2026-10-15 review:
  * every line is spoken by ONE person (a person = one clip, or a cluster of clips from people.json);
    a character (dialogue "speaker") is bound to one person for the whole film;  with no cast given, the engine
    picks the person who can say the whole part best
  * a snippet is >= 2 words and >= MIN_SNIP s, max 2 takes per line (3 over 8 words); single-word lines must be
    a complete utterance in the source (a pause follows)
  * takes are rejected when too quiet, when the face is too small / turned away, or (payoff lines) when they
    failed the ear check; co-articulated tails and non-final words at the end of a line are penalised
  * audio is assembled in numpy at 48 kHz: per-snippet loudness, 40 ms equal-power cross-fades, a continuous bed
    (room tone from the narrator's own clip, or a music file), never digital silence
  * holds after a line keep the take running (video) instead of a freeze frame
  * captions in a solid band at the top, clear of burned-in watermarks;  per-clip pane crops (split-screen sources)
  * VideoToolbox (GPU) encoding

Film JSON (superset of v1):
  {"title": "...", "subtitle": "...", "pause": 0.5, "bed": "roomtone" | "/path/music.wav", "bed_db": -48,
   "cast": {"BOSS": ["ditka"], "HIM": ["buckley", "c07"]}   # dialogue: character -> persons/clips (or a plain list for monologues)
   "avoid": ["c02", "c65"], "captions": true, "caption_pos": "top",
   "lines": [{"speaker": "BOSS", "text": "...", "pause": 0.6, "cast": [...], "only": true, "avoid": [...], "caption": "..."}, ...]}
"""
import json, os, sys, math, re, subprocess, wave, hashlib
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.expanduser("~/Downloads/talking-heads-videos")
FF = "/opt/homebrew/bin/ffmpeg"; FP = "/opt/homebrew/bin/ffprobe"
OUT = os.path.join(HERE, "films", "out"); CACHE = os.path.join(HERE, "films", "cache")
CLIPS = dict(l.rstrip("\n").split("\t")[:2] for l in open(os.path.join(HERE, "clips.tsv")) if l.strip())
REVIEW = os.path.join(HERE, "review", "decisions.json")

# ---- tunables (see review §2.2–2.4) ----
RUN_COST = 6.0          # per take; makes a third take almost never worth it
MIN_SNIP = 0.45         # s, for multi-word snippets
MIN_SINGLE = 0.35       # s, a one-word line
MIN_WORDS = 2
FINAL_GAP = 0.20        # s of silence after a word for it to count as utterance-final
COART_GAP = 0.06        # next source word starts within this -> co-articulated tail
LEVEL_FLOOR_DB = -8.0   # word level vs the clip's speech level
MIN_FACE_H = 0.11       # face box height (frame fraction) before push-in
MAX_YAW = 45.0
XF = 0.020              # s of cross-fade context on each side of a cut
TARGET_RMS_DB = -20.0   # per-snippet speech level (mono, dBFS)
BED_DB = -48.0          # room-tone bed level; music default -32
PAYOFF_LINES = 2        # last N lines: no fallback takes
ASR_LAG = 0.10          # parakeet word boundaries sit about this much late (measured on c08: "questions|like")
MIN_PERSON_WORDS = 40   # a face with fewer on-screen words is not a casting candidate on its own

def norm(w): return re.sub(r"[^a-z0-9']", "", w.lower().replace("’", "'")).strip("'")

_W = {}
def words(cid):
    if cid not in _W: _W[cid] = json.load(open(os.path.join(HERE, "words", cid + ".json")))["words"]
    return _W[cid]

def excluded():
    ex = set()
    if os.path.exists(REVIEW):
        for d in json.load(open(REVIEW)).get("decisions", []):
            if d.get("verdict") in ("voiceover", "mixed"):
                for i in range(d["i0"], d["i1"] + 1): ex.add((d["clip"], i))
    return ex

BANK = json.load(open(os.path.join(HERE, "wordbank.json")))
EX = excluded()
_BADP = os.path.join(HERE, "films", "bad_runs.json")
BAD = {tuple(x) for x in json.load(open(_BADP))} if os.path.exists(_BADP) else set()
PEOPLE = json.load(open(os.path.join(HERE, "people.json"))) if os.path.exists(os.path.join(HERE, "people.json")) else {}
# a person id is "<clip>/<face cluster>" from identities/<clip>.json (facenet clusters of the ASD tracks), or the bare clip id
# when no identity pass exists;  people.json names groups of them: {"buckley": ["c36/0", "c37/0", "c38/1"], "ditka": ["c08"]}
_ID = {}
def ident(cid):
    if cid not in _ID:
        p = os.path.join(HERE, "identities", cid + ".json")
        if os.path.exists(p):
            j = json.load(open(p))
            _ID[cid] = ({int(k): v for k, v in j["track_cluster"].items()}, {int(k): v for k, v in j.get("segments", {}).items()})
        else: _ID[cid] = None
    return _ID[cid]
def person_of(cid, track, t=None):
    """person id for a face track at time t ("<clip>/<cluster>"); tracks are split at shot changes"""
    m = ident(cid)
    if m is None or track not in m[0]: return cid
    tc, segs = m
    if t is not None and track in segs:
        for a, b, l in segs[track]:
            if a - 0.15 <= t <= b + 0.15: return f"{cid}/{l}"
    return f"{cid}/{tc[track]}"
def person(cid, track=None, t=None): return person_of(cid, track, t)
def ids_of(x):
    """a people.json name, a person id or a clip id -> set of ids it stands for"""
    return set(PEOPLE[x]) if x in PEOPLE else {x}
def allowed_word(cid, wi, allowed):
    w = words(cid)[wi]; return cid in allowed or person_of(cid, w.get("track"), w["start"]) in allowed
_PC = None
def person_counts():
    """on-screen word count per person id (lazy, all clips)"""
    global _PC
    if _PC is None:
        _PC = {}
        for c in CLIPS:
            if not os.path.exists(os.path.join(HERE, "words", c + ".json")): continue
            for w in words(c):
                if w["onscreen"]: p = person_of(c, w.get("track"), w["start"]); _PC[p] = _PC.get(p, 0) + 1
    return _PC
CLIPCROP = json.load(open(os.path.join(HERE, "clipcrop.json"))) if os.path.exists(os.path.join(HERE, "clipcrop.json")) else {}

# ---------- per-clip audio features ----------
_ENV = {}
def envelope(cid):
    if cid not in _ENV:
        with wave.open(os.path.join(HERE, "audio", cid + ".wav")) as w:
            x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
        n = len(x) // 160
        _ENV[cid] = np.sqrt((x[:n * 160].reshape(n, 160) ** 2).mean(1) + 1e-12)
    return _ENV[cid]

_PCM = {}
def pcm16k(cid):
    if cid not in _PCM:
        with wave.open(os.path.join(HERE, "audio", cid + ".wav")) as w:
            _PCM[cid] = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
    return _PCM[cid]

def word_db(cid, i):
    w = words(cid)[i]; e = envelope(cid)
    a, b = int(w["start"] * 100), max(int(w["end"] * 100), int(w["start"] * 100) + 1)
    return float(20 * np.log10(e[a:b].mean() + 1e-9))

_SPEECH = {}
def speech_db(cid):
    if cid not in _SPEECH:
        v = [word_db(cid, w["i"]) for w in words(cid) if w["onscreen"]] or [word_db(cid, w["i"]) for w in words(cid)]
        _SPEECH[cid] = float(np.median(v)) if v else -30.0
    return _SPEECH[cid]

_F0 = {}
def f0_of(cid, i0, i1):
    """median f0 (Hz) of words i0..i1 by normalised autocorrelation, 16 kHz; None if unvoiced/too short"""
    key = (cid, i0, i1)
    if key in _F0: return _F0[key]
    ws = words(cid); x = pcm16k(cid)[int(ws[i0]["start"] * 16000):int(ws[i1]["end"] * 16000)]
    vals = []
    for s in range(0, len(x) - 480, 160):
        fr = x[s:s + 480] - x[s:s + 480].mean()
        if np.sqrt((fr ** 2).mean()) < 0.01: continue
        ac = np.correlate(fr, fr, "full")[479:]; ac /= ac[0] + 1e-9
        lo, hi = 40, 400                       # 400 Hz .. 40 Hz
        k = lo + int(np.argmax(ac[lo:hi]))
        if ac[k] > 0.55: vals.append(16000 / k)
    r = float(np.median(vals)) if len(vals) >= 3 else None
    _F0[key] = r; return r

_TR = {}
def track_info(cid, track):
    if cid not in _TR:
        p = os.path.join(HERE, "asd", "out", cid + ".json")
        _TR[cid] = json.load(open(p))["tracks"] if os.path.exists(p) else []
    return _TR[cid][track] if track is not None and track < len(_TR[cid]) else None

_YAW = {}
def yaw_ok(cid, w):
    """median |yaw| of the detected faces during the word (Vision gives yaw in radians-ish units; faces.jsonl col 6)"""
    if cid not in _YAW:
        p = os.path.join(HERE, "faces", cid + ".jsonl"); fr = []
        if os.path.exists(p):
            for l in open(p):
                d = json.loads(l); fr.append((d["t"], [f for f in d["f"]]))
        _YAW[cid] = fr
    fr = _YAW[cid]
    if not fr: return True
    ys = []
    for t, faces in fr:
        if w["start"] - 0.1 <= t <= w["end"] + 0.1:
            big = [f for f in faces if f[3] >= MIN_FACE_H * 0.8]
            if big: ys.append(min(abs(f[6]) for f in big))
    if not ys: return True
    return math.degrees(float(np.median(ys))) <= MAX_YAW if np.median(ys) < 3.2 else float(np.median(ys)) <= MAX_YAW

_SHOTS = {}
SHOT_THR = 0.22         # scene-change score for the take guard (identities.py splits tracks at a tighter 0.12)
def shot_changes(cid, thr=SHOT_THR):
    """times of shot changes in the clip (ffmpeg scene detection on the 10 fps proxy), cached in shots/<cid>_<thr>.json"""
    key = (cid, thr)
    if key not in _SHOTS:
        d = os.path.join(HERE, "shots"); os.makedirs(d, exist_ok=True); p = os.path.join(d, f"{cid}_{thr:.2f}.json")
        if os.path.exists(p): _SHOTS[key] = json.load(open(p))
        else:
            r = subprocess.run([FF, "-nostdin", "-hide_banner", "-i", os.path.join(HERE, "proxy", cid + ".mp4"), "-vf", f"select='gt(scene,{thr})',showinfo", "-f", "null", "-"], capture_output=True, text=True)
            ts = [float(m) for m in re.findall(r"pts_time:([\d.]+)", r.stderr)]
            json.dump(ts, open(p, "w")); _SHOTS[key] = ts
    return _SHOTS[key]

def shot_stable(cid, t0, t1):
    """no shot change inside [t0, t1] (small margin for the 10 fps proxy)"""
    return not any(t0 <= t <= t1 for t in shot_changes(cid))

# ---------- take admissibility ----------
def ok(cid, i):
    ws = words(cid)
    return 0 <= i < len(ws) and ws[i]["onscreen"] and (cid, i) not in EX

END_CARD_S = 8.0        # no takes from the last seconds of a source: YouTube end cards / outros
def admissible(cid, i):
    """hard filters beyond on-screen: loud enough, face big enough, not under the end card"""
    w = words(cid)[i]
    if w["end"] > len(envelope(cid)) / 100 - END_CARD_S: return False
    if word_db(cid, i) < speech_db(cid) + LEVEL_FLOOR_DB: return False
    if w.get("face_h", 1.0) < MIN_FACE_H: return False
    return True

def gap_after(cid, i):
    ws = words(cid)
    return (ws[i + 1]["start"] - ws[i]["end"]) if i + 1 < len(ws) else 9.0

def is_final(cid, i):
    ws = words(cid)
    return gap_after(cid, i) >= FINAL_GAP or (i + 1 < len(ws) and ws[i + 1].get("seg") != ws[i].get("seg"))

# ---------- solver ----------
def solve_person(toks, allowed, used, payoff, line_final_punct, max_runs):
    """DP over tokens for one person (a set of person/clip ids).  State: (token index, runs used).  Returns (cost, runs) or (INF, None)."""
    n = len(toks); INF = 1e9
    best = [[INF] * (max_runs + 1) for _ in range(n + 1)]; back = [[None] * (max_runs + 1) for _ in range(n + 1)]
    best[0][0] = 0.0
    for i in range(n):
        for r in range(max_runs):
            if best[i][r] >= INF: continue
            prev_f0 = back[i][r][5] if back[i][r] else None
            for cid, wi in BANK.get(toks[i], []):
                if not allowed_word(cid, wi, allowed) or not ok(cid, wi) or not admissible(cid, wi): continue
                ws = words(cid); j, k = i, wi; pen = 0.0
                while j < n and k < len(ws) and ok(cid, k) and admissible(cid, k) and (k == wi or allowed_word(cid, k, allowed)) and ws[k]["n"] == toks[j] and (k == wi or ws[k].get("seg") == ws[wi].get("seg")):
                    w = ws[k]
                    pen += (0.3 if w["asd"] < 2.0 else 0) + (0.3 if w["conf"] < 0.6 else 0)
                    if used and (cid, k) in used: pen += 0.8
                    j += 1; k += 1
                    nw = j - i; dur = ws[k - 1]["end"] - ws[wi]["start"]
                    single = (n == 1)
                    if not single and (nw < MIN_WORDS or dur < MIN_SNIP):
                        # one exception: a line-final single word that is a complete utterance in the source
                        if not (j == n and nw == 1 and dur >= MIN_SINGLE and is_final(cid, k - 1)): continue
                    if single and (dur < MIN_SINGLE or not is_final(cid, k - 1)): continue
                    if not shot_stable(cid, ws[wi]["start"] - ASR_LAG + 0.20, ws[k - 1]["end"] - ASR_LAG - 0.15): continue   # cuts in the first/last 150 ms: picture starts at the cut / freezes at it
                    c = RUN_COST + pen
                    if (cid, wi, k - 1) in BAD:
                        if payoff: continue
                        c += 6.0
                    if j == n:
                        if not is_final(cid, k - 1): c += 3.0          # line ends on a word that ran on in the source
                    elif gap_after(cid, k - 1) < COART_GAP and (k < len(ws) and ws[k]["n"] != toks[j]):
                        c += 1.5                                          # co-articulated tail
                    f0 = f0_of(cid, wi, k - 1)
                    if prev_f0 and f0 and not (0.8 <= f0 / prev_f0 <= 1.25): c += 1.0
                    if best[i][r] + c < best[j][r + 1]:
                        best[j][r + 1] = best[i][r] + c; back[j][r + 1] = (i, r, cid, wi, k - 1, f0)
    rbest = min(range(max_runs + 1), key=lambda r: best[n][r])
    if best[n][rbest] >= INF: return INF, None
    runs = []; j, r = n, rbest
    while j > 0:
        i, r0, cid, a, b, _ = back[j][r]; runs.append({"clip": cid, "i0": a, "i1": b}); j, r = i, r0
    return best[n][rbest], runs[::-1]

def toks_of(text): return [norm(t) for t in text.split() if norm(t)]

def max_runs_for(n): return 2 if n <= 8 else 3

def persons_for(film, line):
    """candidate persons for a line -> {person name: set of ids}.  line cast > film cast[speaker] > film cast (list) > everyone
    with >= MIN_PERSON_WORDS on-screen words (people.json names are candidates too)"""
    avoid = set(film.get("avoid", [])) | set(line.get("avoid", []))
    def avoided(pid): return pid in avoid or pid.split("/")[0] in avoid
    cast = line.get("cast")
    fc = film.get("cast")
    if cast is None and fc is not None:
        cast = fc.get(line.get("speaker"), fc.get("*")) if isinstance(fc, dict) else fc
    per = {}
    if cast:
        for x in cast:
            ids = {i for i in ids_of(x) if not avoided(i)}
            if ids: per[x] = ids
    else:
        for pid, n in person_counts().items():
            if n >= MIN_PERSON_WORDS and not avoided(pid): per[pid] = {pid}
        for name, ids in PEOPLE.items():
            ids = {i for i in ids if not avoided(i)}
            if ids: per[name] = ids
    return per

def why_not(film, line, toks):
    """diagnostics for an unbuildable line: per word, how many takes exist for the cast and what rejected them"""
    allowed = set().union(*persons_for(film, line).values()) if persons_for(film, line) else set()
    out = []
    for tkn in toks:
        n = cast = onscr = adm = 0
        for cid, wi in BANK.get(tkn, []):
            n += 1
            if not allowed_word(cid, wi, allowed): continue
            cast += 1
            if not ok(cid, wi): continue
            onscr += 1
            if admissible(cid, wi): adm += 1
        out.append(f"  '{tkn}': {n} takes in the bank, {cast} by the cast, {onscr} on-screen, {adm} loud/large enough")
    out.append(f"  (rules: snippets >= {MIN_WORDS} words and >= {MIN_SNIP}s; a one-word line >= {MIN_SINGLE}s and followed by a pause; <= {max_runs_for(len(toks))} takes)")
    return "\n".join(out)

def plan(film, verbose=True):
    lines = film["lines"]; N = len(lines)
    # group lines by speaker (None = monologue); choose one person per speaker that can say all their lines
    groups = {}
    for li, line in enumerate(lines): groups.setdefault(line.get("speaker"), []).append(li)
    chosen = {}; sol = {}; failures = []
    for sp, lis in groups.items():
        cands = {}
        for li in lis:
            for p, cl in persons_for(film, lines[li]).items(): cands.setdefault(p, set()).update(cl)
        totals = {}
        for p, cl in cands.items():
            tot = 0.0; runs_by = {}
            for li in lis:
                t = toks_of(lines[li]["text"])
                c, runs = solve_person(t, cl, None, li >= N - PAYOFF_LINES, lines[li]["text"].rstrip()[-1:], max_runs_for(len(t)))
                if runs is None: tot = 1e9; break
                tot += c; runs_by[li] = runs
            if tot < 1e9: totals[p] = (tot, runs_by)
        if totals:
            p = min(totals, key=lambda q: totals[q][0]); chosen[sp] = p; sol.update(totals[p][1])
            if verbose: print(f"  speaker {sp or '(narrator)'} -> {p}  (cost {totals[p][0]:.1f}; {len(totals)} candidates could say it all)")
        else:
            # nobody can say every line: per line, best person (and say so)
            if verbose: print(f"  WARNING: no single person can say all of {sp or '(narrator)'}'s lines; casting per line")
            for li in lis:
                t = toks_of(lines[li]["text"]); bestc, bestr = 1e9, None
                for p, cl in persons_for(film, lines[li]).items():
                    c, runs = solve_person(t, cl, None, li >= N - PAYOFF_LINES, "", max_runs_for(len(t)))
                    if runs and c < bestc: bestc, bestr = c, runs
                if bestr is None:
                    failures.append(f"cannot build line {li}: {lines[li]['text']!r}\n{why_not(film, lines[li], t)}"); continue
                sol[li] = bestr
    if failures: raise SystemExit("\n".join(failures))
    # re-solve with the 'used' penalty so takes aren't reused, in order
    snippets, used = [], set()
    for li, line in enumerate(lines):
        t = toks_of(line["text"]); p = chosen.get(line.get("speaker"))
        cl = persons_for(film, line).get(p) if p else None
        runs = sol[li]
        if cl:
            c, r2 = solve_person(t, cl, used, li >= N - PAYOFF_LINES, "", max_runs_for(len(t)))
            if r2: runs = r2
        for ri, r in enumerate(runs):
            ws = words(r["clip"])
            for k in range(r["i0"], r["i1"] + 1): used.add((r["clip"], k))
            t_in, t_out = cut_points(r["clip"], r["i0"], r["i1"])
            nf = max(4, round((t_out - t_in) * 30)); t_out = round(t_in + nf / 30, 4)
            # a shot change just as the first word begins: start the picture at the cut (audio keeps its onset; <= 4 frames of lip-sync lead)
            vin = t_in; vend = None
            for tc in shot_changes(r["clip"]):
                if t_in - 0.02 <= tc <= ws[r["i0"]]["start"] - ASR_LAG + 0.20: vin = max(vin, round(tc + 0.02, 3))
                if ws[r["i1"]]["end"] - ASR_LAG - 0.15 <= tc <= t_out + 0.02: vend = min(vend or tc, tc)
            last = ri == len(runs) - 1
            hold = line.get("pause", film.get("pause", 0.45)) if last else line.get("gap", 0.0)
            hold = round(hold * 30) / 30
            lvl = float(np.mean([word_db(r["clip"], k) for k in range(r["i0"], r["i1"] + 1)]))
            s = {"line": li, "clip": r["clip"], "person": person_of(r["clip"], ws[r["i0"]].get("track"), ws[r["i0"]]["start"]), "i0": r["i0"], "i1": r["i1"], "in": t_in, "out": t_out, "hold": hold, "vin": vin, "vend": vend,
                 "said": " ".join(ws[k]["w"] for k in range(r["i0"], r["i1"] + 1)),
                 "asd": round(min(ws[k]["asd"] for k in range(r["i0"], r["i1"] + 1)), 2),
                 "track": ws[r["i0"]].get("track"), "lvl": round(lvl, 1), "gain": round(max(min(TARGET_RMS_DB - lvl, 18), -15), 1),
                 "f0": f0_of(r["clip"], r["i0"], r["i1"]), "xf_head": XF, "xf_tail": XF,
                 "fallback": (r["clip"], r["i0"], r["i1"]) in BAD}
            # cross-fade context must not reach into neighbouring words
            if r["i0"] > 0: s["xf_head"] = round(max(0.004, min(XF, t_in - (ws[r["i0"] - 1]["end"] - ASR_LAG))), 3)
            if r["i1"] + 1 < len(ws): s["xf_tail"] = round(max(0.004, min(XF, (ws[r["i1"] + 1]["start"] - ASR_LAG) - 0.03 - t_out)), 3)
            snippets.append(s)
    return snippets

def cut_points(cid, i0, i1):
    """in = onset - 40 ms, out = end + 30 ms, never into the neighbouring words; ASR_LAG-corrected"""
    ws = words(cid); a, b = ws[i0], ws[i1]
    st, en = a["start"] - ASR_LAG, b["end"] - ASR_LAG
    prev_end = (ws[i0 - 1]["end"] - ASR_LAG) if i0 > 0 else max(0.0, st - 0.5)
    next_start = (ws[i1 + 1]["start"] - ASR_LAG) if i1 + 1 < len(ws) else en + 0.5
    # when the neighbouring word is right up against ours, cut slightly inside our word instead of taking its onset/tail
    t_in = st - 0.04 if st - prev_end >= 0.08 else st + 0.01
    t_out = en + 0.03 if next_start - en >= 0.08 else en - 0.02
    t_in = max(t_in, 0.0)
    return round(t_in, 3), round(max(t_out, t_in + 0.12), 3)

# ---------- video ----------
_SI = {}
def src_info(cid):
    if cid not in _SI:
        r = subprocess.run([FP, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,sample_aspect_ratio:format=duration", "-of", "json", os.path.join(SRC, CLIPS[cid])], capture_output=True, text=True)
        j = json.loads(r.stdout); s = j["streams"][0]
        sar = s.get("sample_aspect_ratio", "1:1"); sn, sd = (sar.split(":") + ["1"])[:2]
        sar = (float(sn) / float(sd)) if sn.isdigit() and sd.isdigit() and float(sd) > 0 else 1.0
        _SI[cid] = {"w": int(s["width"]) * sar, "h": int(s["height"]), "dur": float(j["format"]["duration"])}
    return _SI[cid]

def pane(cid, s=None):
    """clipcrop.json: {"c08": [x, y, w, h]} | {"c08": {"pane": [...], "punch": false}} | {"c08": {"auto_split": true}}
    auto_split: look for a vertical divider near the middle of the frame at the snippet's midpoint; if found, keep the
    half that holds the speaking face (split-screen sources that are only split some of the time)"""
    v = CLIPCROP.get(cid)
    if isinstance(v, dict) and v.get("auto_split"):
        return detect_split(cid, s) if s else None
    return v["pane"] if isinstance(v, dict) else v
def pane_punch(cid):
    v = CLIPCROP.get(cid); return v.get("punch", True) if isinstance(v, dict) else True

_SPLIT = {}
def detect_split(cid, s):
    key = (cid, s["in"])
    if key in _SPLIT: return _SPLIT[key]
    t = s["in"] + (s["out"] - s["in"]) / 2
    r = subprocess.run([FF, "-nostdin", "-v", "error", "-ss", f"{t:.3f}", "-i", os.path.join(HERE, "proxy", cid + ".mp4"), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True)
    pr = subprocess.run([FP, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", os.path.join(HERE, "proxy", cid + ".mp4")], capture_output=True, text=True)
    res = None
    try:
        pw, ph = [int(x) for x in pr.stdout.strip().split(",")[:2]]
        img = np.frombuffer(r.stdout, np.uint8)[:pw * ph].reshape(ph, pw).astype(np.float32)
        lo, hi = int(0.44 * pw), int(0.56 * pw)
        ext = np.maximum((img < 40).mean(0), (img > 215).mean(0))      # fraction of rows where the column is black or white
        cols = img.mean(0); g = np.abs(np.diff(cols))
        cand = [x for x in range(lo, hi) if ext[x] > 0.85 and ext[x] > np.median(ext) + 0.3 and max(g[max(x - 3, 0):x + 3]) > 50]
        if cand:
            x = cand[len(cand) // 2] / pw
            tr = track_info(cid, s.get("track")); fx = tr["box"][0] + tr["box"][2] / 2 if tr else 0.25
            res = [0.0, 0.0, round(x - 0.004, 4), 1.0] if fx < x else [round(x + 0.004, 4), 0.0, round(1 - x - 0.004, 4), 1.0]
    except Exception: res = None
    _SPLIT[key] = res; return res

def punch_filter(s):
    """clip pane crop + 16:9 push-in on the speaking face (zoom <= 1.6; <= 1.4 for sub-720p sources)"""
    cid = s["clip"]; info = src_info(cid); tr = track_info(cid, s.get("track"))
    f = ""
    pn = pane(cid, s); px, py, pw, ph = pn or (0, 0, 1, 1)
    if pn: f += f"crop=trunc(iw*{pw:.4f}/2)*2:trunc(ih*{ph:.4f}/2)*2:trunc(iw*{px:.4f}):trunc(ih*{py:.4f}),"
    W, H = info["w"] * pw, info["h"] * ph
    if not tr or not pane_punch(cid) or pn: return f      # inside a detected pane the track box is not trustworthy
    x, y, w, h = tr["box"]
    x, y, w, h = (x - px) / pw, (y - py) / ph, w / pw, h / ph              # face box in pane coords
    zmax = 2.0 if info["h"] >= 720 else 1.5
    z = min(max(0.40 / max(h, 1e-3), 1.0), zmax)
    ch = H / z; cw = ch * 16 / 9
    if cw > W: cw = W; ch = cw * 9 / 16
    if ch > H: ch = H; cw = ch * 16 / 9
    if z < 1.08 and abs(W / H - 16 / 9) < 0.02: return f
    cx, cy = (x + w / 2) * W, (y + h / 2 + 0.12 * h) * H
    x0 = min(max(cx - cw / 2, 0), W - cw); y0 = min(max(cy - ch / 2, 0), H - ch)
    return f + f"crop=trunc({cw:.1f}/2)*2:trunc({ch:.1f}/2)*2:trunc({x0:.1f}):trunc({y0:.1f}),"

VF = ("[0:v]scale=trunc(iw*sar/2)*2:ih,setsar=1,{punch}fps=30,split[a][b];"
      "[a]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,gblur=sigma=40,eq=brightness=-0.12[bg];"
      "[b]scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos[fg];"
      "[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p,setsar=1,tpad=stop_mode=clone:stop_duration={pad:.3f}[v]")

def venc(draft):
    return ["-c:v", "h264_videotoolbox", "-allow_sw", "1", "-b:v", "6M" if draft else "20M", "-pix_fmt", "yuv420p", "-r", "30"]

def render_video(s, draft=False, do_punch=True):
    """video-only snippet: the take plus its hold, the take keeps running (no freeze) while the source lasts"""
    key = hashlib.md5(json.dumps([s["clip"], s["in"], s.get("vin"), s.get("vend"), s["out"], s["hold"], draft, do_punch, s.get("track"), pane(s["clip"], s), "v2.7"]).encode()).hexdigest()[:12]
    dst = os.path.join(CACHE, f"{s['clip']}_{key}.mov")
    if os.path.exists(dst): return dst
    dur = s["out"] - s["in"]; hold = s["hold"]; nfr = round((dur + hold) * 30)
    # living hold only while the source is silent; if the person keeps talking in the source, freeze the last frame instead
    ws = words(s["clip"]); nxt = (ws[s["i1"] + 1]["start"] - ASR_LAG) if s["i1"] + 1 < len(ws) else s["out"] + 9
    live = nxt - s["out"] >= hold + 0.1 and not s.get("vend")
    vin = s.get("vin", s["in"]); vlen = (dur + hold + 0.1) if live else dur
    if s.get("vend"): vlen = max(0.1, s["vend"] - 0.04 - vin)     # a cut right at the end of the take: freeze just before it
    vf = VF.format(punch=punch_filter(s) if do_punch else "", pad=hold + dur + 0.3)
    cmd = [FF, "-nostdin", "-v", "error", "-y", "-ss", f"{vin:.3f}", "-t", f"{vlen:.3f}", "-i", os.path.join(SRC, CLIPS[s["clip"]]),
           "-filter_complex", vf, "-map", "[v]", "-an", "-frames:v", str(nfr)] + venc(draft) + [dst]
    subprocess.run(cmd, check=True)
    return dst

def black(dur):
    dst = os.path.join(CACHE, f"black2_{dur:.2f}.mov")
    if not os.path.exists(dst):
        subprocess.run([FF, "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=black:s=1920x1080:r=30:d={dur}", "-frames:v", str(round(dur * 30))] + venc(False) + [dst], check=True)
    return dst

# ---------- audio ----------
SR = 48000
def src_audio(cid, t0, t1):
    """mono float32 at 48 kHz from the original file"""
    r = subprocess.run([FF, "-nostdin", "-v", "error", "-ss", f"{max(t0, 0):.4f}", "-t", f"{t1 - max(t0, 0):.4f}", "-i", os.path.join(SRC, CLIPS[cid]),
                        "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"], capture_output=True)
    return np.frombuffer(r.stdout, np.float32).copy()

def cos_fade(n): return np.sin(np.linspace(0, np.pi / 2, n, dtype=np.float32)) ** 2 if n > 0 else np.zeros(0, np.float32)

def room_tone(cid, length):
    """quietest 1.5 s of the clip, looped with 250 ms cross-fades"""
    e = envelope(cid); k = 150
    if len(e) <= k: t0 = 0.0
    else:
        m = np.convolve(e, np.ones(k) / k, "valid"); t0 = int(np.argmin(m)) / 100
    x = src_audio(cid, t0, t0 + 1.5)
    x -= x.mean()
    xf = int(0.25 * SR); f = cos_fade(xf); out = np.zeros(int(length * SR) + len(x), np.float32); pos = 0
    seg = x.copy(); seg[:xf] *= f; seg[-xf:] *= f[::-1]
    while pos < len(out) - len(seg):
        out[pos:pos + len(seg)] += seg; pos += len(seg) - xf
    return out[:int(length * SR)]

def music_bed(path, length):
    x = src_audio_path(path, length + 1)
    if len(x) < length * SR: x = np.tile(x, int(math.ceil(length * SR / max(len(x), 1))))
    x = x[:int(length * SR)].copy(); n = min(int(2.0 * SR), len(x)); x[-n:] *= cos_fade(n)[::-1]; x[:int(0.5 * SR)] *= cos_fade(int(0.5 * SR))
    return x

def src_audio_path(path, length):
    r = subprocess.run([FF, "-nostdin", "-v", "error", "-t", f"{length:.2f}", "-i", path, "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"], capture_output=True)
    return np.frombuffer(r.stdout, np.float32).copy()

def set_rms(x, db):
    r = float(np.sqrt((x ** 2).mean()) + 1e-9); return x * (10 ** (db / 20) / r)

def build_audio(film, snippets, starts, total, path):
    mix = np.zeros(int(round(total * SR)) + SR, np.float32)
    for s, st in zip(snippets, starts):
        g = 10 ** (s["gain"] / 20); dur = s["out"] - s["in"]
        xh, xt = s["xf_head"], s["xf_tail"]
        tail_extra = 0.0
        last_in_line = s is snippets[-1] or snippets[snippets.index(s) + 1]["line"] != s["line"]
        if last_in_line:
            ws = words(s["clip"]); nxt = (ws[s["i1"] + 1]["start"] - ASR_LAG) if s["i1"] + 1 < len(ws) else s["out"] + 1
            gap = nxt - s["out"]
            tail_extra = max(0.0, min(0.12, gap - 0.25, s["hold"])) if gap >= 0.35 else 0.0   # let the room decay into the hold, never into the next word
        x = src_audio(s["clip"], s["in"] - xh, s["out"] + xt + tail_extra) * g
        nh, nt = int(2 * xh * SR), int(2 * xt * SR)
        if nh: x[:nh] *= cos_fade(nh)
        if tail_extra > 0:
            nd = int((tail_extra + xt) * SR); x[-nd:] *= cos_fade(nd)[::-1]
        elif nt: x[-nt:] *= cos_fade(nt)[::-1]
        p = int(round((st - xh) * SR)); x = x[:len(mix) - p]
        mix[p:p + len(x)] += x
    dry = np.clip(mix[:int(round(total * SR))], -1, 1)
    with wave.open(path.replace(".wav", "_dry.wav"), "w") as w:    # dialogue stem without the bed, for the QA ear
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((dry * 32767).astype(np.int16).tobytes())
    bed = film.get("bed", "roomtone"); bed_db = film.get("bed_db", BED_DB if bed == "roomtone" else -32.0)
    if bed and bed != "none":
        if bed == "roomtone":
            from collections import Counter
            cid = Counter(s["clip"] for s in snippets).most_common(1)[0][0]
            b = room_tone(cid, total)
        else:
            b = music_bed(os.path.expanduser(bed), total)
        b = set_rms(b, bed_db)
        n = min(len(b), len(mix)); fade = int(0.4 * SR); b[:fade] *= cos_fade(fade)
        mix[:n] += b[:n]
    mix = np.clip(mix[:int(round(total * SR))], -1, 1)
    st = np.stack([mix, mix], 1)
    with wave.open(path, "w") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((st * 32767).astype(np.int16).tobytes())

# ---------- captions ----------
def ass_time(t):
    h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"
def ass_escape(s): return s.replace("{", "(").replace("}", ")")

def build_ass(film, snippets, starts, title_d, credit_t, credit_d, credits):
    top = film.get("caption_pos", "top") == "top"
    cap = (f"Style: Cap,Helvetica Neue,54,&H00FFFFFF,&H00FFFFFF,&H00000000,&H78000000,1,0,0,0,100,100,0,0,3,0,0,{8 if top else 2},120,120,{40 if top else 60},1")
    hdr = f"""[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
{cap}
Style: Title,Helvetica Neue,96,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,2,0,1,0,0,5,100,100,0,1
Style: Sub,Helvetica Neue,44,&H00B0B0B0,&H00B0B0B0,&H00000000,&H00000000,0,1,0,0,100,100,1,0,1,0,0,5,100,100,0,1
Style: Cred,Helvetica Neue,30,&H00C8C8C8,&H00C8C8C8,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,120,120,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    ev = [f"Dialogue: 0,{ass_time(0.2)},{ass_time(title_d - 0.2)},Title,,0,0,0,,{{\\fad(300,300)\\pos(960,500)}}{ass_escape(film['title'])}"]
    if film.get("subtitle"):
        ev.append(f"Dialogue: 0,{ass_time(0.5)},{ass_time(title_d - 0.2)},Sub,,0,0,0,,{{\\fad(300,300)\\pos(960,600)}}{ass_escape(film['subtitle'])}")
    if film.get("captions", True):
        lines = {}
        for s, st in zip(snippets, starts):
            a, b = st, st + s["out"] - s["in"] + s["hold"]
            L = lines.setdefault(s["line"], [a, b]); L[0] = min(L[0], a); L[1] = max(L[1], b)
        for li, (a, b) in sorted(lines.items()):
            txt = ass_escape(film["lines"][li].get("caption", film["lines"][li]["text"]))
            sp = film["lines"][li].get("speaker")
            if sp and film.get("speaker_labels", True): txt = "{\\c&H9FE8FF&}" + ass_escape(sp) + ":{\\c&HFFFFFF&} " + txt
            ev.append(f"Dialogue: 0,{ass_time(a)},{ass_time(b - 0.03)},Cap,,0,0,0,,{txt}")
    body = "\\N".join(["{\\fs40\\b1}Words borrowed from{\\b0\\fs30}", ""] + [ass_escape(c) for c in credits])
    ev.append(f"Dialogue: 0,{ass_time(credit_t + 0.2)},{ass_time(credit_t + credit_d - 0.2)},Cred,,0,0,0,,{{\\fad(300,300)\\pos(960,540)}}{body}")
    return hdr + "\n".join(ev) + "\n"

def pretty(name):
    n = re.sub(r"\.mp4$", "", name); return n.replace("｜", "|").replace("＂", '"').replace("：", ":").replace("？", "?").replace("⧸", "/")

# ---------- render ----------
def render(film, snippets, name, draft=False):
    os.makedirs(CACHE, exist_ok=True); os.makedirs(OUT, exist_ok=True)
    title_d = film.get("title_dur", 3.0)
    parts = [black(title_d)]; starts, t = [], title_d
    for s in snippets:
        parts.append(render_video(s, draft, film.get("punch", True))); starts.append(t); t += s["out"] - s["in"] + s["hold"]
    credits = []
    for s in snippets:
        p = pretty(CLIPS[s["clip"]])
        if p not in credits: credits.append(p)
    credit_d = round(max(4.0, 1.5 + 0.12 * len(credits)) * 30) / 30
    parts.append(black(0.6)); credit_t = t + 0.6; parts.append(black(round(credit_d, 2)))
    total = credit_t + credit_d
    lst = os.path.join(CACHE, name + ".v2.txt"); open(lst, "w").write("".join(f"file '{p}'\n" for p in parts))
    joined = os.path.join(CACHE, name + "_v2_joined.mov")
    subprocess.run([FF, "-nostdin", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", joined], check=True)
    mixp = os.path.join(CACHE, name + "_v2_mix.wav"); build_audio(film, snippets, starts, total, mixp)
    ass = os.path.join(CACHE, name + ".v2.ass"); open(ass, "w").write(build_ass(film, snippets, starts, title_d, credit_t, credit_d, credits))
    dst = os.path.join(OUT, name + (".draft" if draft else "") + ".mp4")
    subprocess.run([FF, "-nostdin", "-v", "error", "-y", "-i", joined, "-i", mixp, "-map", "0:v", "-map", "1:a", "-vf", f"subtitles={ass}",
                    "-c:v", "h264_videotoolbox", "-allow_sw", "1", "-b:v", "5M" if draft else "12M", "-pix_fmt", "yuv420p",
                    "-af", "alimiter=limit=0.89", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", dst], check=True)
    return dst, starts

def report(snippets):
    durs = [s["out"] - s["in"] for s in snippets]; nw = [len(s["said"].split()) for s in snippets]
    lines = len({s["line"] for s in snippets})
    print(f"  {len(snippets)} snippets / {lines} lines = {len(snippets) / lines:.2f} takes per line; median snippet {np.median(durs):.2f}s; "
          f"min {min(durs):.2f}s; single-word snippets {sum(n == 1 for n in nw)}; fallback takes {sum(s['fallback'] for s in snippets)}; "
          f"persons {sorted({s['person'] for s in snippets})}")

if __name__ == "__main__":
    a = sys.argv[1:]; path = a[0]; name = os.path.splitext(os.path.basename(path))[0]
    film = json.load(open(path))
    snippets = plan(film)
    os.makedirs(OUT, exist_ok=True)
    for s in snippets: s["clip_name"] = CLIPS[s["clip"]]
    print(f"{name}: {len(snippets)} snippets from {len({s['clip'] for s in snippets})} clips")
    for s in snippets:
        print(f"  L{s['line']:02d} {s['clip']:5} {s['in']:8.2f}-{s['out']:8.2f} asd {s['asd']:5.2f} lvl {s['lvl']:6.1f} g {s['gain']:+5.1f}  {s['said']}{'  [fallback]' if s['fallback'] else ''}")
    report(snippets)
    if "--plan-only" in a:
        json.dump(snippets, open(os.path.join(OUT, name + ".plan.json"), "w"), indent=1); sys.exit()
    dst, starts = render(film, snippets, name, "--draft" in a)
    for s, st in zip(snippets, starts): s["t"] = round(st, 3)
    json.dump(snippets, open(os.path.join(OUT, name + ".plan.json"), "w"), indent=1)
    print("rendered", dst)
