#!/usr/bin/env python
"""
Carry an existing subtitle file across to a re-cut of the same video.

When a talk is re-edited — some lines dropped, some new ones recorded — the old
translation is still correct for everything that survived. Re-typing it would be waste
and would risk losing the museum's wording. This matches the two soundtracks and moves
each cue to where its audio now sits.

NO TRANSCRIPTION IS INVOLVED, and none is possible here: there is no speech-to-text on
this machine, and the subtitles are an English translation of Malay speech in any case,
so a machine transcript would not match the museum's wording even if one existed.

What it does:
  - builds a loudness envelope of both soundtracks
  - for each cue, correlates the old audio around that cue against the new audio and
    moves the cue to the best match, keeping its duration
  - a cue whose audio is no longer present is DROPPED (that line was cut)
  - stretches of the new audio that no surviving cue covers, and that contain speech,
    are emitted as explicit placeholders — these are the new script, and only a human
    who can hear them can fill them in

Every decision is reported with its correlation so a weak match can be checked by hand.

Usage: retime-subs.py <old.srt> <old-video> <new-video> <out.srt> [tmpdir]
"""
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ffmpeg_path import ffmpeg, ffprobe
BIN = ffmpeg()
OLD_SRT, OLD_VID, NEW_VID, OUT = sys.argv[1:5]
TMP = sys.argv[5] if len(sys.argv) > 5 else os.path.dirname(OUT)

HZ = 20                 # envelope samples per second
SR = 8000
WIN = int(5.0 * HZ)     # seconds of audio used to place each cue
SEARCH = int(60 * HZ)   # how far either side of the predicted spot to look
GOOD = 0.72             # correlation below this means the line is gone
SPEECH_GAP = 2.5        # seconds of uncovered speech worth flagging as new script


def envelope(path, tag):
    raw = os.path.join(TMP, f"env_{tag}.pcm")
    subprocess.run([BIN, "-v", "error", "-y", "-i", path, "-vn",
                    "-ac", "1", "-ar", str(SR), "-f", "s16le", raw], check=True)
    d = open(raw, "rb").read()
    hop = SR // HZ
    env = []
    for i in range(0, len(d) // 2 - hop, hop):
        acc = 0
        for k in range(i, i + hop, 4):
            v = int.from_bytes(d[2 * k:2 * k + 2], "little", signed=True)
            acc += v * v
        env.append((acc / (hop / 4)) ** 0.5)
    os.remove(raw)
    return env


def ts(s):
    h = int(s // 3600); m = int(s % 3600 // 60); sec = s % 60
    return f"{h:02d}:{m:02d}:{sec:06.3f}".replace(".", ",")


def parse(path):
    txt = open(path, encoding="utf-8-sig").read().replace("\r\n", "\n")
    out = []
    for blk in re.split(r"\n\s*\n", txt.strip()):
        lines = [l for l in blk.split("\n") if l.strip()]
        if len(lines) < 2:
            continue
        m = re.search(r"(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)", blk)
        if not m:
            continue
        g = [int(x) for x in m.groups()]
        a = g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000.0
        b = g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000.0
        body = lines[lines.index(m.group(0)) + 1:] if m.group(0) in lines else lines[2:]
        out.append([a, b, "\n".join(body).strip()])
    return out


def best_match(eo, en, at, lo, hi):
    """Where in `en` does the `eo` window starting at `at` sit? Returns (offset, corr)."""
    w = eo[at:at + WIN]
    if len(w) < WIN:
        return None, -1.0
    m = sum(w) / WIN
    s = (sum((x - m) ** 2 for x in w) / WIN) ** 0.5
    if s < 1e-6:
        return None, -1.0
    w = [(x - m) / s for x in w]
    best, bestv = None, -2.0
    for off in range(max(0, lo), min(len(en) - WIN, hi)):
        c = en[off:off + WIN]
        cm = sum(c) / WIN
        cs = (sum((x - cm) ** 2 for x in c) / WIN) ** 0.5
        if cs < 1e-6:
            continue
        dot = 0.0
        for a, b in zip(w, c):
            dot += a * (b - cm)
        r = dot / (WIN * cs)
        if r > bestv:
            bestv, best = r, off
    return best, bestv


cues = parse(OLD_SRT)
print(f"  {len(cues)} cues in {os.path.basename(OLD_SRT)}")
print("  building envelopes...")
eo, en = envelope(OLD_VID, "old"), envelope(NEW_VID, "new")
print(f"  old {len(eo)/HZ:.1f}s   new {len(en)/HZ:.1f}s")

kept, dropped = [], []
shift = 0           # running estimate, keeps the search local and ordered
for a, b, text in cues:
    at = int(a * HZ)
    guess = at + shift
    off, r = best_match(eo, en, at, guess - SEARCH, guess + SEARCH)
    if off is None or r < GOOD:
        dropped.append((a, b, text, r))
        continue
    shift = off - at
    na = off / HZ
    kept.append([na, na + (b - a), text, r])

kept.sort(key=lambda c: c[0])
# a re-timed cue may now overlap its neighbour; trim rather than let them collide
for i in range(len(kept) - 1):
    if kept[i][1] > kept[i + 1][0] - 0.05:
        kept[i][1] = max(kept[i][0] + 0.4, kept[i + 1][0] - 0.05)

# Uncovered speech in the new audio = the new script.
# The threshold sits a quarter of the way from the room's noise floor up to speech level.
# Taking a high percentile of the whole envelope instead was too strict and silently
# missed 34 seconds of new material in her profile.
srt_env = sorted(en)
floor = srt_env[int(0.10 * len(srt_env))]
peak = srt_env[int(0.90 * len(srt_env))]
loud = floor + 0.25 * (peak - floor)
gaps = []
covered = [False] * len(en)
for a, b, _, _ in kept:
    for i in range(int(a * HZ), min(len(en), int(b * HZ))):
        covered[i] = True
# Close the gaps BETWEEN WORDS first. Speech is not continuously above any threshold —
# requiring an unbroken run missed 34 seconds of new material in her profile, because
# every pause between words broke the run.
raw_speech = [v > loud for v in en]
pad = int(0.6 * HZ)
speech = [any(raw_speech[max(0, i - pad):i + pad + 1]) for i in range(len(en))]

run = None
for i in range(len(en) + 1):
    live = i < len(en) and not covered[i] and speech[i]
    if live:
        run = i if run is None else run
    elif run is not None:
        if (i - run) / HZ >= SPEECH_GAP:
            gaps.append((run / HZ, i / HZ))
        run = None

with open(OUT, "w", encoding="utf-8") as f:
    n = 0
    merged = [("cue", c) for c in kept] + [("gap", g) for g in gaps]
    merged.sort(key=lambda x: x[1][0])
    for kind, item in merged:
        n += 1
        if kind == "cue":
            a, b, text, r = item
            f.write(f"{n}\n{ts(a)} --> {ts(b)}\n{text}\n\n")
        else:
            a, b = item
            f.write(f"{n}\n{ts(a)} --> {ts(b)}\n"
                    f"### NEW SCRIPT — not in the old cut, needs writing ###\n\n")

print(f"\n  re-timed : {len(kept)}")
print(f"  dropped  : {len(dropped)}  (audio no longer present)")
print(f"  new gaps : {len(gaps)}  (uncovered speech, placeholders written)")
if dropped:
    print("\n  dropped cues:")
    for a, b, text, r in dropped:
        print(f"    old {ts(a)}  corr {r:+.2f}  {text.splitlines()[0][:58]}")
if gaps:
    print("\n  new-script gaps in the new cut:")
    for a, b in gaps:
        print(f"    {ts(a)} -> {ts(b)}   ({b-a:.1f}s)")
weak = [c for c in kept if c[3] < 0.85]
if weak:
    print(f"\n  {len(weak)} cues matched below 0.85 — worth a spot check:")
    for a, b, text, r in weak[:10]:
        print(f"    {ts(a)}  corr {r:.2f}  {text.splitlines()[0][:52]}")
print(f"\n  wrote {OUT}")
