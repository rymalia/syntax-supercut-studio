#!/usr/bin/env python3
"""Phrase bank: what each PERSON (clip/face-cluster) says on camera, as maximal runs of admissible words.
This is what scripts are written from (review §2.1): every line should be a found phrase, glue <= 1 word.

  asd/.venv/bin/python phrasebank.py            -> phrases/INDEX.md, phrases/<person>.md, phrases/bank.json
  asd/.venv/bin/python phrasebank.py --grep "what do you"   -> who says it (sub-phrase search across persons)
"""
import os, sys, json, re
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import supercut2 as S
OUTD = os.path.join(HERE, "phrases"); os.makedirs(OUTD, exist_ok=True)

def runs_of(cid):
    ws = S.words(cid); out = []; cur = None
    for w in ws:
        good = S.ok(cid, w["i"]) and S.admissible(cid, w["i"])
        pid = S.person_of(cid, w.get("track"), w["start"]) if good else None   # per word: a track can change person at a shot split
        if good and cur and w["i"] == cur["i1"] + 1 and w.get("seg") == cur["seg"] and pid == cur["pid"] and w["start"] - ws[cur["i1"]]["end"] < 0.6:
            cur["i1"] = w["i"]
        elif good:
            cur = {"clip": cid, "i0": w["i"], "i1": w["i"], "seg": w.get("seg"), "pid": pid}; out.append(cur)
        else:
            cur = None
    for r in out:
        a, b = ws[r["i0"]], ws[r["i1"]]
        r["text"] = " ".join(ws[k]["w"] for k in range(r["i0"], r["i1"] + 1))
        r["start"], r["end"] = a["start"], b["end"]; r["n"] = r["i1"] - r["i0"] + 1
        r["asd"] = round(min(ws[k]["asd"] for k in range(r["i0"], r["i1"] + 1)), 2)
        r["final"] = S.is_final(cid, r["i1"])
    return [r for r in out if r["n"] >= 2]

def fmt(t): return f"{int(t // 60)}:{t % 60:05.2f}"

def main():
    bank = {}; names = {}
    for cid, name in S.CLIPS.items():
        if not os.path.exists(os.path.join(HERE, "words", cid + ".json")): continue
        for r in runs_of(cid): bank.setdefault(r["pid"], []).append(r); names[r["pid"]] = name
    json.dump(bank, open(os.path.join(OUTD, "bank.json"), "w"))
    rows = []
    for pid, rs in bank.items():
        nw = sum(r["n"] for r in rs); long = sum(r["n"] >= 4 for r in rs); longest = max(r["n"] for r in rs)
        rows.append((nw, long, longest, pid))
        with open(os.path.join(OUTD, pid.replace("/", "_") + ".md"), "w") as f:
            f.write(f"# {pid} — {names[pid]}\n\n{nw} admissible on-screen words in {len(rs)} runs; {long} runs of 4+ words; longest {longest}.\n")
            f.write(f"Thumbnail: identities/{pid.split('/')[0]}.jpg\n\n| time | words | min ASD | ends at pause | text |\n|---|---|---|---|---|\n")
            for r in sorted(rs, key=lambda r: r["start"]):
                f.write(f"| {fmt(r['start'])}–{fmt(r['end'])} | {r['n']} | {r['asd']} | {'yes' if r['final'] else ''} | {r['text']} |\n")
    rows.sort(reverse=True)
    with open(os.path.join(OUTD, "INDEX.md"), "w") as f:
        f.write("# Phrase bank — people ranked by admissible on-screen words\n\n| person | words | runs 4+ | longest | clip |\n|---|---|---|---|---|\n")
        for nw, long, longest, pid in rows:
            f.write(f"| [{pid}]({pid.replace('/', '_')}.md) | {nw} | {long} | {longest} | {names[pid][:70]} |\n")
    print(len(bank), "people;", sum(r[0] for r in rows), "words in runs of 2+;", sum(r[1] for r in rows), "runs of 4+")

def grep(q):
    q = [S.norm(x) for x in q.split()]
    bank = json.load(open(os.path.join(OUTD, "bank.json")))
    hits = []
    for pid, rs in bank.items():
        for r in rs:
            t = [S.norm(x) for x in r["text"].split()]
            for i in range(len(t) - len(q) + 1):
                if t[i:i + len(q)] == q: hits.append((pid, r)); break
    for pid, r in sorted(hits, key=lambda h: -h[1]["n"])[:40]:
        print(f"{pid:10} {fmt(r['start'])} asd {r['asd']:4}  {r['text']}")
    print(len(hits), "runs contain it")

if __name__ == "__main__":
    if "--grep" in sys.argv: grep(sys.argv[sys.argv.index("--grep") + 1])
    else: main()
