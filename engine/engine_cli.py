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
  check --film <path>            per-line buildability of a film JSON (no render): takes it would use, or why not
  plan  --film <path> [--sheet]  solve the film and write films/out/<name>.plan.json (+ .plan.jpg contact sheet from proxies)
  render --film <path> [--draft] full render -> films/out/<name>.mp4 (+ plan.json); LOG lines carry progress
  qa    --name <name>            cold-listen + per-line + acoustic report for films/out/<name>.mp4 -> films/out/<name>.qa.json
  ingest                         transcribe/detect/identify any clips in ~/Downloads/talking-heads-videos not yet in clips.tsv,
                                 then rebuild the word bank, identities and phrase bank (long; streams LOG lines)
  stats                          phrase-bank index: people ranked by admissible on-screen words
"""
import json, os, sys, subprocess, argparse, traceback
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
PY = os.path.join(HERE, "asd", ".venv", "bin", "python")
FF = "/opt/homebrew/bin/ffmpeg"

def log(msg):
    print("LOG " + str(msg).replace("\n", " "), flush=True)

def result(obj):
    print("RESULT " + json.dumps(obj), flush=True)

def fail(msg):
    result({"ok": False, "error": msg}); sys.exit(1)

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
    pj = os.path.join(S.OUT, name + ".plan.json"); json.dump(sn, open(pj, "w"), indent=1)
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
    pj = os.path.join(S.OUT, name + ".plan.json"); json.dump(sn, open(pj, "w"), indent=1)
    result({"ok": True, "name": name, "outFile": dst, "plan": pj, "snippets": len(sn), "lines": len(film["lines"]),
            "takes_per_line": round(len(sn) / max(len(film["lines"]), 1), 2), "persons": sorted({s["person"] for s in sn})})

def cmd_qa(a):
    p = subprocess.run([PY, os.path.join(HERE, "qa_film2.py"), a.name] + (["--no-sheet"] if a.no_sheet else []), capture_output=True, text=True, cwd=HERE)
    for l in p.stdout.splitlines(): log(l)
    qj = os.path.join(HERE, "films", "out", a.name + ".qa.json")
    if p.returncode != 0 or not os.path.exists(qj): fail("qa failed: " + p.stderr[-800:])
    j = json.load(open(qj)); j["ok"] = True; j["name"] = a.name
    j["sheets"] = [os.path.join(HERE, "films", "out", f) for f in sorted(os.listdir(os.path.join(HERE, "films", "out"))) if f.startswith(a.name + ".sheet")]
    result(j)

def stream(cmd, cwd=HERE, env=None):
    p = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    for line in p.stdout:
        line = line.rstrip()
        if line: log(line)
    return p.wait()

def cmd_ingest(a):
    log("ingest: audio -> parakeet -> faces -> ASD (MPS) -> word bank")
    rc = stream(["bash", os.path.join(HERE, "ingest_new.sh")])
    if rc != 0: fail(f"ingest_new.sh exited {rc}")
    new = [l.split("\t")[0] for l in open(os.path.join(HERE, "clips.tsv")) if l.strip() and not os.path.exists(os.path.join(HERE, "identities", l.split("\t")[0] + ".json"))]
    if new:
        log(f"identities for {len(new)} clips"); stream([PY, os.path.join(HERE, "identities.py")] + new)
    log("phrase bank"); stream([PY, os.path.join(HERE, "phrasebank.py")])
    n = sum(1 for l in open(os.path.join(HERE, "clips.tsv")) if l.strip())
    result({"ok": True, "clips": n, "new_identities": new})

def cmd_stats(a):
    rows = []
    for l in open(os.path.join(HERE, "phrases", "INDEX.md")):
        if l.startswith("| [") :
            c = [x.strip() for x in l.strip().strip("|").split("|")]
            pid = c[0].split("]")[0][1:]
            rows.append({"person": pid, "words": int(c[1]), "runs4": int(c[2]), "longest": int(c[3]), "clip_name": c[4]})
    result({"ok": True, "people": rows})

def main():
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("people"); sub.add_parser("stats"); sub.add_parser("ingest")
    g = sub.add_parser("grep"); g.add_argument("--q", required=True); g.add_argument("--limit", type=int, default=60)
    for n in ("check", "plan", "render"):
        s = sub.add_parser(n); s.add_argument("--film", required=True)
        if n == "plan": s.add_argument("--sheet", action="store_true")
        if n == "render": s.add_argument("--draft", action="store_true")
    q = sub.add_parser("qa"); q.add_argument("--name", required=True); q.add_argument("--no-sheet", action="store_true")
    a = ap.parse_args()
    try:
        globals()["cmd_" + a.cmd](a)
    except SystemExit:
        raise
    except Exception as e:
        traceback.print_exc(file=sys.stderr); fail(f"{type(e).__name__}: {e}")

if __name__ == "__main__":
    main()
