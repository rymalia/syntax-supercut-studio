#!/usr/bin/env python3
"""JSON command-line face of the talking-heads engine, for Supercut Studio (or anything else) to drive.

  asd/.venv/bin/python engine_cli.py <command> [options]

Protocol (stdout, one record per line):
  LOG <text>          progress / log line, in order
  RESULT <json>       exactly once, last line; on failure: RESULT {"ok": false, "error": "..."}
Exit code 0 on success, 1 on failure.  Nothing else is printed on stdout (warnings go to stderr).

Commands
  people                         identity clusters that can be cast: id "<clip>/<cluster>", clip name, seconds on
                                 screen, admissible words, thumbnail strip + index, plus the names in people.json
  grep --q "<phrase>" [--limit N] who says the phrase (sub-phrase search over the phrase bank), with times
  attribute --spans <file> [--cast X ...] annotate transcript word spans with engine attributes
  check --film <path>            per-line buildability of a film JSON (no render): takes it would use, or why not
  plan  --film <path> [--sheet]  solve the film and write films/out/<name>.plan.json (+ .plan.jpg contact sheet from proxies)
  render --film <path> [--draft] full render -> films/out/<name>.mp4 (+ plan.json); LOG lines carry progress
  qa    --name <name>            cold-listen + per-line + acoustic report for films/out/<name>.mp4 -> films/out/<name>.qa.json
  ingest                         transcribe/detect/identify any clips in ~/Downloads/talking-heads-videos not yet in clips.tsv,
                                 then rebuild the word bank, identities and phrase bank (long; streams LOG lines)
  stats                          phrase-bank index: people ranked by admissible on-screen words
"""
import json, os, re, sys, subprocess, argparse, traceback
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
PY = os.path.join(HERE, "asd", ".venv", "bin", "python")
FF = "/opt/homebrew/bin/ffmpeg"

import signal, stat, tempfile
from datetime import datetime, timezone

def log(msg):
    print("LOG " + str(msg).replace("\n", " "), flush=True)

# ---------- activity log (B6, engine half) ----------
# Commands that change something append one line to <engine>/activity.jsonl (format: docs/ENGINE_CONTRACT.md, Activity log).
# The app already logs the jobs it starts, so only runs it did not start are logged here (actor "desktop": chat or shell).
ACT = {"cmd": None, "target": ""}
LOGGED = {"plan", "render", "qa", "export", "ingest"}
def started_by_app():
    try:
        comm = subprocess.run(["ps", "-o", "comm=", "-p", str(os.getppid())], capture_output=True, text=True).stdout.strip()
        return os.path.basename(comm) in ("node", "bun", "deno") or os.environ.get("TH_ACTOR") == "app"
    except Exception:
        return False
def activity(res):
    if ACT["cmd"] not in LOGGED or started_by_app(): return
    p = os.path.join(HERE, "activity.jsonl")
    line = {"ts": datetime.now(timezone.utc).isoformat(), "actor": "desktop", "action": ACT["cmd"], "target": ACT["target"], "result": res}
    try:   # a regular file with one link only: no symlink (O_NOFOLLOW), no FIFO (O_NONBLOCK + S_ISREG), no hard link elsewhere
        fd = os.open(p, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o644)
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1: os.close(fd); return
        with os.fdopen(fd, "a") as f: f.write(json.dumps(line) + "\n")
    except OSError: pass

def result(obj):
    print("RESULT " + json.dumps(obj), flush=True)
    if obj.get("ok"):
        summary = {"export": lambda o: os.path.basename(o.get("fcpxml", "")), "render": lambda o: os.path.basename(o.get("outFile", "")),
                   "qa": lambda o: f'heard {o.get("heard")}/{o.get("total")}', "ingest": lambda o: f'{o.get("clips")} clips',
                   "plan": lambda o: f'{len(o.get("snippets", []))} takes'}.get(ACT["cmd"], lambda o: "ok")
        activity(summary(obj))
    else:
        activity("error: " + str(obj.get("error", ""))[:160])

def fail(msg):
    result({"ok": False, "error": msg}); sys.exit(1)

# ---------- cancellation (B21, engine half) ----------
# The app cancels with SIGTERM to this process group, then SIGKILL after 10 s. Forward SIGTERM to the running child
# (an ingest script, qa, ffmpeg) and give it a few seconds, so a direct signal to this process also stops the work.
CHILD = {"p": None}
def dump_atomic(obj, path):
    """write JSON via a temp file + rename, so a cancel never leaves a truncated plan or cut list"""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-", suffix=".json")
    with os.fdopen(fd, "w") as f: json.dump(obj, f, indent=1)
    os.replace(tmp, path)

TERM = {"seen": False}
def _on_term(signum, frame):
    if TERM["seen"]: return                         # a second SIGTERM (or our own group signal) while stopping: ignore
    TERM["seen"] = True
    if os.getpgrp() == os.getpid():                 # we lead our own group (the app spawns us that way): stop every
        signal.signal(signal.SIGTERM, signal.SIG_IGN)   # child, including ffmpeg started by subprocess.run in supercut2
        try: os.killpg(os.getpid(), signal.SIGTERM)
        except OSError: pass
    p = CHILD["p"]
    if p and p.poll() is None:
        try:
            p.terminate(); p.wait(timeout=5)
        except Exception:
            try: p.kill()
            except Exception: pass
    print("RESULT " + json.dumps({"ok": False, "error": "cancelled"}), flush=True)
    try: activity("cancelled")
    except Exception: pass
    os._exit(143)
signal.signal(signal.SIGTERM, _on_term)

# ---------- commands ----------
def cmd_people(a):
    import supercut2 as S
    names = {}
    for cid, name in S.CLIPS.items():
        p = os.path.join(HERE, "identities", cid + ".json")
        if os.path.exists(p): names[cid] = name
    counts = S.person_counts()
    out = []
    for cid, name in names.items():
        j = json.load(open(os.path.join(HERE, "identities", cid + ".json")))
        for idx, (cl, info) in enumerate(j["clusters"].items()):
            pid = f"{cid}/{cl}"
            out.append({"id": pid, "clip": cid, "clip_name": name, "seconds": round(info["frames"] / 25),
                        "words": counts.get(pid, 0), "thumb": f"identities/{cid}.jpg", "thumb_index": idx})
    out.sort(key=lambda p: -p["words"])
    result({"ok": True, "people": out, "names": S.PEOPLE, "thumb_tile": 160, "thumb_per_row": 8})

def cmd_grep(a):
    import supercut2 as S
    q = [S.norm(x) for x in a.q.split()]
    bank = json.load(open(os.path.join(HERE, "phrases", "bank.json")))
    hits = []
    for pid, rs in bank.items():
        for r in rs:
            t = [S.norm(x) for x in r["text"].split()]
            for i in range(len(t) - len(q) + 1):
                if t[i:i + len(q)] == q:
                    hits.append({"person": pid, "clip": r["clip"], "clip_name": S.CLIPS.get(r["clip"], ""), "start": r["start"], "end": r["end"],
                                 "asd": r["asd"], "final": r["final"], "words": r["n"], "text": r["text"]}); break
    hits.sort(key=lambda h: -h["words"])
    result({"ok": True, "query": a.q, "count": len(hits), "hits": hits[:a.limit]})

def cmd_attribute(a):
    import supercut2 as S
    spans = json.load(open(a.spans)); allowed = set().union(*(S.ids_of(x) for x in (a.cast or [])))
    for x in a.cast or []:
        known = x in S.PEOPLE or x in S.CLIPS
        if not known and "/" in x:
            cid, cluster = x.split("/", 1); ident = S.ident(cid)
            known = cid in S.CLIPS and ident is not None and cluster in {str(v) for v in ident[0].values()}
        if not known: log(f"cast {x} matches no person")
    out = []; index = {}
    for span in spans:
        cid = span.get("clip")
        wanted = span.get("words") or []
        try: source = S.words(cid)
        except (FileNotFoundError, TypeError): source = None
        found = []
        if source is not None:
            if cid not in index:          # (start, end) -> word indices; zero-length words can share a time
                index[cid] = {}
                for i, w in enumerate(source): index[cid].setdefault((w.get("start"), w.get("end")), []).append(i)
            for start, end, text in wanted:
                match = next(((i, source[i]) for i in index[cid].get((start, end), [])
                              if S.norm(source[i].get("n", source[i].get("w", ""))) == S.norm(text)), None)
                if match is None: found = []; break
                found.append(match)
        if not found or len(found) != len(wanted):
            out.append({"known": False}); continue
        words = [w for _, w in found]; persons = []
        for w in words:
            person = S.person_of(cid, w.get("track"), w.get("start"))
            if person not in persons: persons.append(person)
        person = persons[0] if len(set(persons)) == 1 else None
        annotated = {"known": True, "words": [[w["start"], w["end"], w.get("w", w.get("text", ""))] for w in words],
                     "person": person, "persons": persons, "onscreen": all(w.get("onscreen", False) for w in words),
                     "asd": min(w["asd"] for w in words), "face_h": min(w["face_h"] for w in words)}
        if a.cast: annotated["in_cast"] = all(S.allowed_word(cid, i, allowed) for i, _ in found)
        out.append(annotated)
    seen = {p for o in out for p in o.get("persons", [])}
    names = {p: n for n, ids in S.PEOPLE.items() for p in ids if p in seen}
    result({"ok": True, "spans": out, "names": names})

def load_film(path):
    film = json.load(open(path)); name = os.path.splitext(os.path.basename(path))[0]
    return film, name

def cmd_check(a):
    import supercut2 as S
    film, name = load_film(a.film)
    lines = []
    # one person per speaker is decided over all of a speaker's lines; check each line on its own first, then the whole film
    for li, line in enumerate(film["lines"]):
        one = dict(film); one["lines"] = [line]
        try:
            sn = S.plan(one, verbose=False)
            lines.append({"line": li, "speaker": line.get("speaker"), "text": line["text"], "ok": True,
                          "takes": [{"clip": s["clip"], "person": s["person"], "in": s["in"], "out": s["out"], "said": s["said"], "asd": s["asd"], "fallback": s["fallback"]} for s in sn]})
        except SystemExit as e:
            lines.append({"line": li, "speaker": line.get("speaker"), "text": line["text"], "ok": False, "why": str(e)})
    whole = None
    try:
        sn = S.plan(film, verbose=False)
        whole = {"ok": True, "snippets": len(sn), "lines": len(film["lines"]), "takes_per_line": round(len(sn) / max(len(film["lines"]), 1), 2),
                 "persons": sorted({s["person"] for s in sn})}
    except SystemExit as e:
        whole = {"ok": False, "why": str(e)}
    result({"ok": True, "name": name, "lines": lines, "film": whole})

def contact_sheet(snippets, dst):
    """one proxy frame per snippet, labelled, tiled 6 across (fast: 10 fps proxies)"""
    import tempfile, shutil
    tmp = tempfile.mkdtemp(); frames = []
    for k, s in enumerate(snippets):
        t = s.get("vin", s["in"]) + (s["out"] - s["in"]) / 2; f = os.path.join(tmp, f"f{k:03d}.jpg")
        lab = f"{k} L{s['line']} {s['person']} {s['said']}".replace(":", " ").replace("'", "")[:44]
        subprocess.run([FF, "-nostdin", "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", os.path.join(HERE, "proxy", s["clip"] + ".mp4"), "-frames:v", "1", "-vf",
                        f"scale=384:216:force_original_aspect_ratio=decrease,pad=384:216:(ow-iw)/2:(oh-ih)/2,drawtext=fontfile=/System/Library/Fonts/SFNS.ttf:text='{lab}':x=6:y=6:fontsize=15:fontcolor=yellow:box=1:boxcolor=black@0.6", f], check=False)
        if os.path.exists(f): frames.append(f)
    if frames:
        rows = (len(frames) + 5) // 6
        subprocess.run([FF, "-nostdin", "-v", "error", "-y", "-framerate", "1", "-i", os.path.join(tmp, "f%03d.jpg"), "-frames:v", "1", "-vf", f"tile=6x{rows}:padding=4", dst], check=False)
    shutil.rmtree(tmp, ignore_errors=True)
    return dst if os.path.exists(dst) else None

def cmd_plan(a):
    import supercut2 as S
    film, name = load_film(a.film)
    try:
        sn = S.plan(film, verbose=False)
    except SystemExit as e:
        fail(str(e))
    for s in sn: s["clip_name"] = S.CLIPS[s["clip"]]
    os.makedirs(S.OUT, exist_ok=True)
    # plan-only goes to <name>.planned.json: <name>.plan.json belongs to the last render (it carries the timeline "t" export reads)
    pj = os.path.join(S.OUT, name + ".planned.json"); dump_atomic(sn, pj)
    out = {"ok": True, "name": name, "plan": pj, "snippets": sn, "lines": len(film["lines"]), "takes_per_line": round(len(sn) / max(len(film["lines"]), 1), 2),
           "persons": sorted({s["person"] for s in sn}), "speech_seconds": round(sum(s["out"] - s["in"] for s in sn), 2)}
    if a.sheet:
        log("contact sheet from proxies")
        out["sheet"] = contact_sheet(sn, os.path.join(S.OUT, name + ".plan.jpg"))
    result(out)

def cmd_render(a):
    import supercut2 as S
    film, name = load_film(a.film)
    try:
        sn = S.plan(film, verbose=False)
    except SystemExit as e:
        fail(str(e))
    for s in sn: s["clip_name"] = S.CLIPS[s["clip"]]
    log(f"{len(sn)} snippets / {len(film['lines'])} lines; persons {sorted({s['person'] for s in sn})}")
    # render snippet by snippet so progress can be reported, then the final pass
    os.makedirs(S.CACHE, exist_ok=True); os.makedirs(S.OUT, exist_ok=True)
    for i, s in enumerate(sn):
        S.render_video(s, a.draft, film.get("punch", True)); log(f"progress {i + 1}/{len(sn)} snippet {s['clip']} {s['said']}")
    log("mixing audio, captions, final encode")
    dst, starts = S.render(film, sn, name, a.draft)
    for s, st in zip(sn, starts): s["t"] = round(st, 3)
    pj = os.path.join(S.OUT, name + ".plan.json"); dump_atomic(sn, pj)
    result({"ok": True, "name": name, "outFile": dst, "plan": pj, "snippets": len(sn), "lines": len(film["lines"]),
            "takes_per_line": round(len(sn) / max(len(film["lines"]), 1), 2), "persons": sorted({s["person"] for s in sn})})

def cmd_qa(a):
    if a.film:
        a.film = os.path.abspath(a.film)                                    # qa_film2 runs with cwd = the engine dir
        a.name = os.path.splitext(os.path.basename(a.film))[0]              # same name render used for films/out/<name>.*
    if not a.name: fail("qa needs --name or --film")
    p = subprocess.Popen([PY, os.path.join(HERE, "qa_film2.py"), a.name] + (["--film", a.film] if a.film else []) + (["--no-sheet"] if a.no_sheet else []),
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=HERE)
    CHILD["p"] = p
    out, err = p.communicate()
    for l in out.splitlines(): log(l)
    qj = os.path.join(HERE, "films", "out", a.name + ".qa.json")
    if p.returncode != 0 or not os.path.exists(qj): fail("qa failed: " + err[-800:])
    j = json.load(open(qj)); j["ok"] = True; j["name"] = a.name
    j["sheets"] = [os.path.join(HERE, "films", "out", f) for f in sorted(os.listdir(os.path.join(HERE, "films", "out"))) if f.startswith(a.name + ".sheet")]
    result(j)

def stream(cmd, cwd=HERE, env=None):
    p = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    CHILD["p"] = p
    for line in p.stdout:
        line = line.rstrip()
        if line: log(line)
    return p.wait()

def cmd_ingest(a):
    log("ingest: audio -> parakeet -> faces -> ASD (MPS) -> word bank")
    before = {l.split("\t")[0] for l in open(os.path.join(HERE, "clips.tsv")) if l.strip()}
    rc = stream(["bash", os.path.join(HERE, "ingest_new.sh")])
    if rc != 0: fail(f"ingest_new.sh exited {rc}")
    new = [l.split("\t")[0] for l in open(os.path.join(HERE, "clips.tsv")) if l.strip() and not os.path.exists(os.path.join(HERE, "identities", l.split("\t")[0] + ".json"))]
    added = [l.split("\t")[0] for l in open(os.path.join(HERE, "clips.tsv")) if l.strip() and l.split("\t")[0] not in before]
    if new:
        log(f"identities for {len(new)} clips"); stream([PY, os.path.join(HERE, "identities.py")] + new)
    log("phrase bank"); stream([PY, os.path.join(HERE, "phrasebank.py")])
    log("build buckets")
    buckets = stream(["python3", os.path.join(HERE, "build_buckets.py")]) == 0
    if not buckets: log("WARNING: build_buckets.py failed; continuing")
    review_batch = None
    if added:
        batch = f"{added[0]}-{added[-1]}"
        log(f"speaker review batch {batch}")
        if stream(["python3", os.path.join(HERE, "review_build.py"), "20", "--batch", batch, "--only"] + added) == 0:
            review_batch = batch
        else:
            log("WARNING: review_build.py failed; continuing")
    n = sum(1 for l in open(os.path.join(HERE, "clips.tsv")) if l.strip())
    result({"ok": True, "clips": n, "new_identities": new, "buckets": buckets, "review_batch": review_batch})

def cmd_stats(a):
    rows = []
    for l in open(os.path.join(HERE, "phrases", "INDEX.md")):
        if l.startswith("| [") :
            c = [x.strip() for x in l.strip().strip("|").split("|")]
            pid = c[0].split("]")[0][1:]
            rows.append({"person": pid, "words": int(c[1]), "runs4": int(c[2]), "longest": int(c[3]), "clip_name": c[4]})
    result({"ok": True, "people": rows})

def cmd_export(a):
    """cut list (app supercut sidecar) or an engine plan -> FCPXML (+ SRT) referencing the original sources"""
    import export_cuts as X
    if a.plan:
        if not re.fullmatch(r"[a-z0-9_-]+", a.plan): fail("bad plan name")
        if not any(os.path.exists(os.path.join(HERE, "films", "out", a.plan + e)) for e in (".plan.json", ".planned.json")): fail(f"no plan for {a.plan}")
        log(f"export: plan {a.plan}"); cl = X.from_plan(a.plan)
    else:
        log(f"export: cut list {a.cuts}"); cl = json.load(open(a.cuts))
    out = a.out or os.path.join(HERE, "films", "out")
    if a.plan:
        os.makedirs(out, exist_ok=True)
        cp = os.path.join(out, X.safe(cl["name"]) + ".cuts.json"); dump_atomic(cl, cp)
    r = X.build(cl, out)
    if a.plan: r["cuts"] = cp
    log(f"export: {r['clips']} items from {r['sources']} sources at {r['fps']} fps -> {r['fcpxml']}")
    result({"ok": True, **r})

def main():
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("people"); sub.add_parser("stats"); sub.add_parser("ingest")
    g = sub.add_parser("grep"); g.add_argument("--q", required=True); g.add_argument("--limit", type=int, default=60)
    at = sub.add_parser("attribute"); at.add_argument("--spans", required=True); at.add_argument("--cast", action="append")
    for n in ("check", "plan", "render"):
        s = sub.add_parser(n); s.add_argument("--film", required=True)
        if n == "plan": s.add_argument("--sheet", action="store_true")
        if n == "render": s.add_argument("--draft", action="store_true")
    e = sub.add_parser("export"); eg = e.add_mutually_exclusive_group(required=True)
    eg.add_argument("--plan"); eg.add_argument("--cuts"); e.add_argument("--out")
    q = sub.add_parser("qa"); qg = q.add_mutually_exclusive_group(required=True)
    qg.add_argument("--name"); qg.add_argument("--film"); q.add_argument("--no-sheet", action="store_true")
    a = ap.parse_args()
    ACT["cmd"] = a.cmd
    ACT["target"] = getattr(a, "film", None) and os.path.splitext(os.path.basename(a.film))[0] or getattr(a, "plan", None) \
        or getattr(a, "name", None) or (getattr(a, "cuts", None) and os.path.basename(a.cuts)) or ""
    try:
        globals()["cmd_" + a.cmd](a)
    except SystemExit:
        raise
    except Exception as e:
        traceback.print_exc(file=sys.stderr); fail(f"{type(e).__name__}: {e}")

if __name__ == "__main__":
    main()
