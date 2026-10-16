#!/usr/bin/env python3
"""Build/refresh the Supercut Studio buckets from the engine's word files.

  videos/talking-heads/           every parakeet word (symlinked source video)
  videos/talking-heads-onscreen/  only words with onscreen=True; a zero-length "|" token marks each
                                  removed stretch so phrase/regex matches cannot span a gap

Idempotent: rewrites transcripts for every clip in clips.tsv (cheap), leaves supercuts/ alone.
  python3 build_buckets.py [--buckets-dir ~/projects/syntax-supercut-studio/videos] [ids...]
"""
import argparse, json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.expanduser("~/Downloads/talking-heads-videos")

def clips():
    return [l.rstrip("\n").split("\t") for l in open(os.path.join(HERE, "clips.tsv")) if l.strip()]

def transcript(words, onscreen):
    out, skipped, dur = [], False, 0.0
    for w in words:
        dur = max(dur, w["end"])
        if onscreen and not w["onscreen"]:
            skipped = True; continue
        if skipped and out:
            out.append({"text": "|", "start": w["start"], "end": w["start"]})
        skipped = False
        out.append({"text": w["w"], "start": w["start"], "end": w["end"]})
    return {"text": " ".join(x["text"] for x in out), "duration": round(dur, 3), "words": out}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--buckets-dir", default=os.path.expanduser("~/projects/syntax-supercut-studio/videos"))
    ap.add_argument("ids", nargs="*")
    a = ap.parse_args()
    rows = [r for r in clips() if not a.ids or r[0] in a.ids]
    n = 0
    for bucket, onscreen in (("talking-heads", False), ("talking-heads-onscreen", True)):
        root = os.path.join(a.buckets_dir, bucket)
        for d in ("videos", "transcripts", "supercuts"): os.makedirs(os.path.join(root, d), exist_ok=True)
        for cid, name in rows:
            wf = os.path.join(HERE, "words", cid + ".json")
            if not os.path.exists(wf):
                print(f"skip {cid}: no words file", file=sys.stderr); continue
            link = os.path.join(root, "videos", cid + ".mp4"); target = os.path.join(SRC, name)
            if os.path.islink(link) and os.readlink(link) != target: os.remove(link)
            if not os.path.lexists(link): os.symlink(target, link)
            words = json.load(open(wf))["words"]
            t = transcript(words, onscreen)
            with open(os.path.join(root, "transcripts", cid + ".json"), "w") as f: json.dump(t, f)
            n += 1
    print(f"wrote {n} transcripts for {len(rows)} clips into {a.buckets_dir}")

if __name__ == "__main__":
    main()
