#!/usr/bin/env python3
"""Cut list -> FCPXML (+ SRT) that rebuilds a Supercut Studio / engine edit in DaVinci Resolve (or Final Cut) from the
ORIGINAL source files.

  export_cuts.py --cuts list.json [--out DIR]          # app sidecar (supercut) or any cut list
  export_cuts.py --plan NAME [--out DIR]               # engine film / sentence: films/out/NAME.plan.json

Cut list v1 (times in seconds, paths absolute):
{ "version": 1, "name": "...", "origin": "supercut|engine", "fps": null|"23.976"|"25"|..., "width": 1920, "height": 1080,
  "clips": [ { "media": "av"|"v"|"a", "track": 1, "rec": 0.0, "src": "/abs/file.mp4", "in": 12.3, "out": 13.1,
               "speed": 1.0, "rect": [x,y,w,h] | null,   # where the picture sits, fraction of the frame (fit inside)
               "crop": [x,y,w,h] | null,                 # source window to show, fraction of the source (fills the rect)
               "gain_db": 0, "fade_in": 0, "fade_out": 0, "freeze": 0, "name": "...", "clip": "c04" } ],
  "captions": [ {"start": 0, "end": 1.2, "text": "..."} ],
  "markers":  [ {"t": 0, "name": "...", "note": "..."} ] }
Video tracks are numbered from 1 (V1 = main storyline), audio tracks from 1 (A1). "av" clips carry their own audio.
"""
import argparse, json, os, subprocess, sys
from collections import Counter
from fractions import Fraction as F
from urllib.parse import quote
from xml.sax.saxutils import escape, quoteattr

HERE = os.path.dirname(os.path.abspath(__file__))
FP = "/opt/homebrew/bin/ffprobe"
RATES = {"23.976": F(24000, 1001), "24": F(24), "25": F(25), "29.97": F(30000, 1001), "30": F(30), "50": F(50),
         "59.94": F(60000, 1001), "60": F(60)}
FMT = {F(24000, 1001): "2398", F(24): "24", F(25): "25", F(30000, 1001): "2997", F(30): "30", F(50): "50",
       F(60000, 1001): "5994", F(60): "60"}

_PROBE = {}
def probe(path):
    if path not in _PROBE:
        r = subprocess.run([FP, "-v", "error", "-show_entries", "stream=codec_type,r_frame_rate,width,height,sample_aspect_ratio,channels,sample_rate:format=duration",
                            "-of", "json", path], capture_output=True, text=True)
        j = json.loads(r.stdout or "{}"); v = next((s for s in j.get("streams", []) if s["codec_type"] == "video"), None)
        a = next((s for s in j.get("streams", []) if s["codec_type"] == "audio"), None)
        rate = F(v["r_frame_rate"]) if v else None
        if rate: rate = min(RATES.values(), key=lambda r: abs(r - rate)) if min(abs(r - rate) for r in RATES.values()) < F(1, 100) else rate
        sar = 1.0
        if v and ":" in v.get("sample_aspect_ratio", "1:1"):
            n, d = v.get("sample_aspect_ratio", "1:1").split(":"); sar = (int(n) / int(d)) if d != "0" and n != "0" else 1.0
        _PROBE[path] = {"dur": float(j.get("format", {}).get("duration", 0)), "rate": rate,
                        "w": int(v["width"]) * sar if v else 0, "h": int(v["height"]) if v else 0,
                        "ch": int(a["channels"]) if a else 0, "sr": int(a["sample_rate"]) if a else 48000}
    return _PROBE[path]

def pick_rate(cl):
    if cl.get("fps"): return RATES[str(cl["fps"])]
    c = Counter()
    for x in cl["clips"]:
        r = probe(x["src"])["rate"]
        if r and x.get("media", "av") != "a": c[r] += x["out"] - x["in"]
    return c.most_common(1)[0][0] if c else F(24000, 1001)

def T(q):
    q = F(q); return f"{q.numerator}s" if q.denominator == 1 else f"{q.numerator}/{q.denominator}s"

def build(cl, out_dir):
    W, H = cl.get("width", 1920), cl.get("height", 1080)
    lead = max(0.0, -min(x["rec"] for x in cl["clips"]))        # e.g. an audio pre-roll before the first picture
    if lead:
        for x in cl["clips"]: x["rec"] += lead
        for c in cl.get("captions", []): c["start"] += lead; c["end"] += lead
        for m in cl.get("markers", []): m["t"] += lead
    rate = pick_rate(cl); fd = 1 / rate
    fr = lambda sec, up=False: (-(-F(sec).limit_denominator(10**6) // fd) if up else F(sec).limit_denominator(10**6) // fd)
    # ---- resources
    assets, res = {}, []
    res.append(f'<format id="r1" name="FFVideoFormat{H}p{FMT.get(rate, "")}" frameDuration="{T(fd)}" width="{W}" height="{H}"/>')
    fmts = {rate: "r1"}
    for x in cl["clips"]:
        p = x["src"]
        if p in assets: continue
        if not os.path.exists(p): raise SystemExit(f"missing source: {p}")
        info = probe(p); aid = f"r{len(res) + 1}"
        fmt_attr = ""
        if info["rate"]:
            if info["rate"] not in fmts:
                fid = f"r{len(res) + 1}"; res.append(f'<format id="{fid}" frameDuration="{T(1 / info["rate"])}" width="{int(info["w"])}" height="{info["h"]}"/>')
                fmts[info["rate"]] = fid; aid = f"r{len(res) + 1}"
            fmt_attr = f' format="{fmts[info["rate"]]}"'
        sfd = (1 / info["rate"]) if info["rate"] else F(1, 1000)
        d = (F(info["dur"]).limit_denominator(10**6) // sfd) * sfd
        name = x.get("clip") or os.path.splitext(os.path.basename(p))[0]
        res.append(f'<asset id="{aid}" name={quoteattr(name)} start="0s" duration="{T(d)}" hasVideo="{1 if info["rate"] else 0}"'
                   f' hasAudio="{1 if info["ch"] else 0}"{fmt_attr} audioSources="1" audioChannels="{info["ch"] or 2}" audioRate="{info["sr"]}">'
                   f'<media-rep kind="original-media" src="file://{quote(p)}"/></asset>')
        vid = f"r{len(res) + 1}"     # picture-only twin: Resolve honours a timeMap only on asset-clips, and ignores srcEnable
        res.append(f'<asset id="{vid}" name={quoteattr(name + " (picture)")} start="0s" duration="{T(d)}" hasVideo="1" hasAudio="0"{fmt_attr}>'
                   f'<media-rep kind="original-media" src="file://{quote(p)}"/></asset>')
        assets[p] = (aid, info, sfd, vid)
    # ---- items on the timeline grid
    items = []
    for x in cl["clips"]:
        aid, info, sfd, vid = assets[x["src"]]
        if x.get("media", "av") == "v": aid = vid
        sp = F(x.get("speed", 1)).limit_denominator(1000)
        s_in = (F(x["in"]).limit_denominator(10**6) // sfd) * sfd                    # floor to a source frame
        rec0 = fr(x["rec"])
        play = fr((F(x["out"]).limit_denominator(10**6) - s_in) / sp, up=True)          # ceil: never clip the last word
        hold = fr(x.get("freeze", 0), up=True)
        adur = (F(info["dur"]).limit_denominator(10**6) // sfd) * sfd
        base = dict(x=x, aid=aid, info=info, sp=sp, adur=adur, media=x.get("media", "av"), track=int(x.get("track", 1)))
        items.append(dict(base, s_in=s_in, rec=rec0, play=play, hold=0, n=play))
        if hold:   # Resolve ignores flat or constant timeMaps, so a freeze is the take's last frame played at 2% speed (verified frozen in Resolve)
            last = s_in + play * fd * sp - sfd
            items.append(dict(base, sp=F(1, 50), s_in=max(F(0), (last // sfd) * sfd), rec=rec0 + play, play=hold, hold=0, n=hold,
                              x=dict(x, name=(x.get("name") or "") + " [freeze]")))
    total = max(i["rec"] + i["n"] for i in items)
    # ---- spine = one gap over the whole edit, every item connected to it. Resolve reads a gap child's offset relative to the
    # gap (as FCP does) but a <video> child's as absolute, so a gap host is the one form both editors agree on.
    spine = [dict(gap=True, rec=0, n=total, kids=sorted(items, key=lambda i: (i["rec"], i["media"] == "a", i["track"])))]

    def lstart(i):                  # clip start in its own (adjusted) time: Resolve and FCP read a timeMap over the whole asset
        return i["s_in"] if i["sp"] == 1 else i["s_in"] / i["sp"]

    def local(host, rec):           # a connected item's offset is in the host's local (adjusted) time
        base = F(0) if host.get("gap") else lstart(host)
        return base + (rec - host["rec"]) * fd

    def transform(i):
        x = i["x"]; info = i["info"]
        if i["media"] == "a" or not (x.get("rect") or x.get("crop")): return ""
        sw, sh = info["w"], info["h"]
        base = min(W / sw, H / sh)                                  # Resolve/FCP default: fit
        cx, cy, cw, ch = x.get("crop") or (0, 0, 1, 1)
        rx, ry, rw, rh = x.get("rect") or (0, 0, 1, 1)
        win_w, win_h = cw * sw, ch * sh                              # source window to show
        k = min(rw * W / win_w, rh * H / win_h)                      # source px -> timeline px
        scale = k / base
        # centre of the window must land on the centre of the rect
        wcx, wcy = (cx + cw / 2) * sw, (cy + ch / 2) * sh
        dx = (rx + rw / 2) * W - W / 2 - (wcx - sw / 2) * k
        dy = (ry + rh / 2) * H - H / 2 - (wcy - sh / 2) * k
        pos = f"{dx / H * 100:.4f} {-dy / H * 100:.4f}"              # FCPXML: % of frame height, +y up
        out = f'<adjust-transform position="{pos}" scale="{scale:.5f} {scale:.5f}"/>'
        if x.get("crop") and (cw < 1 or ch < 1) and x.get("rect"):  # tile showing part of a source: trim the rest
            out = (f'<adjust-crop mode="trim"><trim-rect left="{cx * 100:.3f}" right="{(1 - cx - cw) * 100:.3f}"'
                   f' top="{cy * 100:.3f}" bottom="{(1 - cy - ch) * 100:.3f}"/></adjust-crop>') + out
        return out

    def volume(i):
        x = i["x"]
        g, fi, fo = x.get("gain_db", 0), x.get("fade_in", 0), x.get("fade_out", 0)
        if not (g or fi or fo): return ""
        fades = ""
        if fi or fo:
            fades = '<param name="amount">' + (f'<fadeIn type="linear" duration="{T(fr(fi, True) * fd)}"/>' if fi else "") + \
                    (f'<fadeOut type="linear" duration="{T(fr(fo, True) * fd)}"/>' if fo else "") + '</param>'
        return f'<adjust-volume amount="{g:+.1f}dB">{fades}</adjust-volume>'

    def timemap(i):
        """whole-asset map (FCP's own form, which Resolve reads): 0 -> 0 at the clip's speed; a freeze maps its range to one frame"""
        if i["sp"] == 1: return ""
        return f'<timeMap><timept time="0s" value="0s" interp="linear"/><timept time="{T(i["adur"] / i["sp"])}" value="{T(i["adur"])}" interp="linear"/></timeMap>'

    def clip_xml(i, offset, lane=None):
        """av and picture-only -> asset-clip (picture-only via a hasAudio=0 asset); audio only -> <audio>"""
        x = i["x"]; nm = x.get("name") or x.get("clip") or ""
        ln = f' lane="{lane}"' if lane is not None else ""
        kids = "".join(clip_xml(k, local(i, k["rec"]), k_lane(k)) for k in i.get("kids", []))
        common = f'ref="{i["aid"]}"{ln} name={quoteattr(nm[:60])} offset="{T(offset)}" start="{T(lstart(i))}" duration="{T(i["n"] * fd)}"'
        if i["media"] == "a":
            return f'<audio {common} role="dialogue">' + timemap(i) + volume(i) + kids + '</audio>'
        return f'<asset-clip {common} tcFormat="NDF">' + timemap(i) + transform(i) + volume(i) + kids + '</asset-clip>'

    max_a = max([i["track"] for i in items if i["media"] == "a"] + [1])
    def k_lane(k):  # Resolve stacks audio lanes from the most negative up: A1 = lane -max_a
        return k["track"] if k["media"] != "a" else -(max_a + 1 - k["track"])

    body = []
    for s in spine:
        if s.get("gap"):
            kids = "".join(clip_xml(k, local(s, k["rec"]), k_lane(k)) for k in s["kids"])
            body.append(f'<gap name="Gap" offset="{T(s["rec"] * fd)}" start="0s" duration="{T(s["n"] * fd)}">{kids}</gap>')
        else:
            body.append(clip_xml(s, s["rec"] * fd))
    mhost = spine[0] if spine else None
    markers = "".join(f'<marker start="{T(local(mhost, fr(m["t"])))}" duration="{T(fd)}" value={quoteattr(m.get("name", ""))} note={quoteattr(m.get("note", ""))}/>'
                      for m in cl.get("markers", []))
    if markers and body:   # markers ride on the first spine element (local time)
        first = body[0]; cut = first.rfind("</")
        body[0] = first[:cut] + markers + first[cut:]
    name = cl.get("name", "supercut")
    xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE fcpxml>', '<fcpxml version="1.10">', '<resources>', *res, '</resources>',
           '<library>', f'<event name={quoteattr("Supercut Studio exports")}>', f'<project name={quoteattr(name)}>',
           f'<sequence format="r1" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k" duration="{T(total * fd)}">',
           '<spine>', *body, '</spine>', '</sequence>', '</project>', '</event>', '</library>', '</fcpxml>']
    os.makedirs(out_dir, exist_ok=True)
    base = os.path.join(out_dir, safe(name))
    open(base + ".fcpxml", "w").write("\n".join(xml))
    out = {"fcpxml": base + ".fcpxml", "fps": next((k for k, v in RATES.items() if v == rate), f"{float(rate):.3f}"), "frames": int(total), "clips": len(items), "sources": len(assets)}
    if cl.get("captions"):
        def ts(sec):
            ms = int(round(float(fr(sec) * fd) * 1000)); return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"
        srt = []
        for k, c in enumerate(cl["captions"], 1): srt += [str(k), f'{ts(c["start"])} --> {ts(c["end"])}', c["text"], ""]
        open(base + ".srt", "w").write("\n".join(srt)); out["srt"] = base + ".srt"
    return out

def safe(name): return "".join(c if c.isalnum() or c in "-_." else "-" for c in name).strip("-")[:120] or "supercut"

# ---------- engine plan (sentence / film) -> cut list ----------
def from_plan(name):
    sys.path.insert(0, HERE)
    import supercut2 as S
    snips = json.load(open(os.path.join(S.OUT, name + ".plan.json")))
    film_p = os.path.join(HERE, "films", name + ".json"); film = json.load(open(film_p)) if os.path.exists(film_p) else {}
    t0 = min(s["t"] for s in snips); clips, caps = [], []
    for s in snips:
        src = os.path.join(S.SRC, S.CLIPS[s["clip"]]); dur = s["out"] - s["in"]; hold = s["hold"]
        ws = S.words(s["clip"]); nxt = (ws[s["i1"] + 1]["start"] - S.ASR_LAG) if s["i1"] + 1 < len(ws) else s["out"] + 9
        live = nxt - s["out"] >= hold + 0.1 and not s.get("vend")
        vin = s.get("vin") or s["in"]; vlen = (dur + hold) if live else dur
        if s.get("vend"): vlen = max(0.1, s["vend"] - 0.04 - vin)
        info = S.src_info(s["clip"])
        crop = punch_window(S, s, info)
        rec = s["t"] - t0
        clips.append(dict(media="v", track=1, rec=rec, src=src, **{"in": vin, "out": vin + vlen}, freeze=max(0.0, dur + hold - vlen),
                          crop=crop, rect=[0, 0, 1, 1] if crop else None, clip=s["clip"], name=f'{s["clip"]} {s["said"]}'))
        clips.append(dict(media="a", track=1, rec=rec - s["xf_head"], src=src, **{"in": s["in"] - s["xf_head"], "out": s["out"] + s["xf_tail"]},
                          gain_db=s["gain"], fade_in=2 * s["xf_head"], fade_out=2 * s["xf_tail"], clip=s["clip"], name=s["said"]))
    lines = film.get("lines")
    for ln in sorted({s["line"] for s in snips}):
        ss = [s for s in snips if s["line"] == ln]
        a = ss[0]["t"] - t0; b = ss[-1]["t"] - t0 + ss[-1]["out"] - ss[-1]["in"] + ss[-1]["hold"]
        text = (lines[ln].get("caption") or lines[ln]["text"]) if lines and ln < len(lines) else " ".join(s["said"] for s in ss)
        caps.append(dict(start=a, end=b, text=text))
    bed = film.get("bed")
    if bed and bed not in ("roomtone", "none"):
        p = os.path.expanduser(bed); total = max(c["rec"] + c["out"] - c["in"] + c.get("freeze", 0) for c in clips)
        clips.append(dict(media="a", track=2, rec=0, src=p, **{"in": 0, "out": min(total, probe(p)["dur"])},
                          gain_db=round(film.get("bed_db", -32.0) - mean_db(p), 1), fade_in=0.4, name="music bed"))
    return {"version": 1, "name": name, "origin": "engine", "fps": None, "width": 1920, "height": 1080, "clips": clips, "captions": caps}

def mean_db(p):
    r = subprocess.run(["/opt/homebrew/bin/ffmpeg", "-nostdin", "-v", "info", "-t", "60", "-i", p, "-af", "volumedetect", "-f", "null", "-"],
                       capture_output=True, text=True)
    for l in r.stderr.splitlines():
        if "mean_volume" in l: return float(l.split(":")[1].split()[0])
    return -20.0

def punch_window(S, s, info):
    """the engine's pane crop + push-in as one source window [x, y, w, h] (fractions), or None for the whole frame"""
    cid = s["clip"]; tr = S.track_info(cid, s.get("track")); pn = S.pane(cid, s)
    px, py, pw, ph = pn or (0, 0, 1, 1)
    if not tr or not S.pane_punch(cid) or pn: return [px, py, pw, ph] if pn else None
    W, H = info["w"] * pw, info["h"] * ph
    x, y, w, h = tr["box"]; x, y, w, h = (x - px) / pw, (y - py) / ph, w / pw, h / ph
    zmax = 2.0 if info["h"] >= 720 else 1.5
    z = min(max(0.40 / max(h, 1e-3), 1.0), zmax)
    ch = H / z; cw = ch * 16 / 9
    if cw > W: cw = W; ch = cw * 9 / 16
    if ch > H: ch = H; cw = ch * 16 / 9
    if z < 1.08 and abs(W / H - 16 / 9) < 0.02: return None
    cx, cy = (x + w / 2) * W, (y + h / 2 + 0.12 * h) * H
    x0 = min(max(cx - cw / 2, 0), W - cw); y0 = min(max(cy - ch / 2, 0), H - ch)
    return [round(px + x0 / info["w"], 5), round(py + y0 / info["h"], 5), round(cw / info["w"], 5), round(ch / info["h"], 5)]

def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--cuts"); g.add_argument("--plan")
    ap.add_argument("--out", default=os.path.join(HERE, "films", "exports"))
    a = ap.parse_args()
    cl = json.load(open(a.cuts)) if a.cuts else from_plan(a.plan)
    os.makedirs(a.out, exist_ok=True)
    if a.plan: json.dump(cl, open(os.path.join(a.out, safe(cl["name"]) + ".cuts.json"), "w"), indent=1)   # what was exported, for audit
    print(json.dumps(build(cl, a.out)))

if __name__ == "__main__":
    main()
