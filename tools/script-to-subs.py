#!/usr/bin/env python
"""
Time a known script against a recording, producing a subtitle file.

Used where a talk was read from a teleprompter: the words are known exactly, but nothing
here can transcribe, so the timings have to come from the audio itself.

The method is deliberately simple, because the recording it is built for is simple — a
single speaker reading a prompter at a steady pace:

  1. build a loudness envelope and mark which parts are speech
  2. measure how much SPEECH time the recording contains, ignoring the pauses
  3. give each cue a share of that speech time proportional to its character count
  4. map those shares back to wall-clock, so the pauses fall between cues on their own

That last step is what makes it work on a block-by-block prompter read: the long gaps
between blocks are skipped rather than being handed to a cue, so cues do not drift the way
they would if the script were spread evenly across the running time.

It assumes a roughly constant speaking rate. That holds for a prompter read and not much
else, so check the result rather than trusting it — a cue that lands early or late will
pull its neighbours with it until the next long pause resets the alignment.

Usage: script-to-subs.py <script.txt> <video> <out.srt> [tmpdir]
   script.txt holds one cue per blank-line-separated block; newlines inside a block are
   the cue's own display lines.
"""
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ffmpeg_path import ffmpeg, ffprobe
BIN = ffmpeg()

SCRIPT, VIDEO, OUT = sys.argv[1:4]
TMP = sys.argv[4] if len(sys.argv) > 4 else os.path.dirname(OUT)

HZ = 20            # envelope samples per second
SR = 8000
PAD = 0.25         # word-gap closing, each side. Must stay BELOW half the shortest pause
                   # worth preserving, or real pauses are swallowed and counted as speech —
                   # which collapses step 4 back into a plain even spread.
LEAD = 0.12        # start each cue slightly before its audio
MIN_CUE = 0.9      # no cue shorter than this
GAP = 0.06         # leave a sliver between consecutive cues
ANCHOR = 0.45      # snap a cue boundary to a pause within this distance


def envelope():
    raw = os.path.join(TMP, "s2s.pcm")
    subprocess.run([BIN, "-v", "error", "-y", "-i", VIDEO, "-vn",
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


cues = [b.strip() for b in re.split(r"\n\s*\n", open(SCRIPT, encoding="utf-8-sig").read()) if b.strip()]
env = envelope()
dur = len(env) / HZ
print(f"  {len(cues)} cues, {dur:.1f}s of audio")

srt = sorted(env)
floor = srt[int(0.10 * len(srt))]
peak = srt[int(0.90 * len(srt))]
thr = floor + 0.25 * (peak - floor)
raw_speech = [v > thr for v in env]
pad = int(PAD * HZ)
speech = [any(raw_speech[max(0, i - pad):i + pad + 1]) for i in range(len(env))]
total_speech = sum(speech) / HZ
print(f"  speech {total_speech:.1f}s of {dur:.1f}s  ({100*total_speech/dur:.0f}%)")

# wall-clock time at which a given amount of cumulative speech has elapsed
marks = []
acc = 0.0
for i, sp in enumerate(speech):
    if sp:
        acc += 1.0 / HZ
        marks.append((acc, i / HZ))


def at_speech(t):
    if not marks:
        return t
    lo, hi = 0, len(marks) - 1
    if t <= marks[0][0]:
        return marks[0][1]
    if t >= marks[-1][0]:
        return marks[-1][1]
    while lo < hi:
        mid = (lo + hi) // 2
        if marks[mid][0] < t:
            lo = mid + 1
        else:
            hi = mid
    return marks[lo][1]


weights = [max(8, len(re.sub(r"\s+", " ", c))) for c in cues]
total_w = sum(weights)
out = []
acc_w = 0
for c, w in zip(cues, weights):
    a = at_speech(total_speech * acc_w / total_w)
    acc_w += w
    b = at_speech(total_speech * acc_w / total_w)
    out.append([a, b, c])

# Snap boundaries onto the pauses he actually took. The proportional spread puts each
# boundary near the right place; a pause nearby is almost certainly the real one, and
# landing on it exactly stops a cue appearing over the tail of the previous sentence.
# Detect these on the RAW envelope, not the padded one: padding exists to stop word gaps
# counting as pause, so by construction it has already closed the shorter real pauses.
pauses = []
run = 0
for i, sp in enumerate(raw_speech + [True]):
    if not sp:
        run += 1
    else:
        if run >= int(0.7 * HZ):
            pauses.append(((i - run) / HZ, i / HZ))
        run = 0
snapped = 0
for i in range(len(out) - 1):
    t = out[i][1]
    near = [p for p in pauses if abs(p[0] - t) <= ANCHOR or (p[0] <= t <= p[1])]
    if not near:
        continue
    p = min(near, key=lambda p: abs(p[0] - t))
    # A snap that squeezes the cue below readable length is the wrong pause, or the right
    # pause for a boundary this cue does not own. Leave the proportional timing alone.
    if p[0] - out[i][0] < MIN_CUE or out[i + 1][1] - p[1] < MIN_CUE:
        continue
    out[i][1] = p[0]
    out[i + 1][0] = p[1]
    snapped += 1
print(f"  snapped {snapped} of {len(out)-1} boundaries onto pauses ({len(pauses)} pauses found)")

for c in out:
    c[0] = max(0.0, c[0] - LEAD)
for i in range(len(out) - 1):
    if out[i][1] < out[i][0] + MIN_CUE:
        out[i][1] = out[i][0] + MIN_CUE
    if out[i][1] > out[i + 1][0] - GAP:
        out[i][1] = max(out[i][0] + MIN_CUE, out[i + 1][0] - GAP)
out[-1][1] = min(max(out[-1][1], out[-1][0] + MIN_CUE), dur)

with open(OUT, "w", encoding="utf-8") as f:
    for n, (a, b, c) in enumerate(out, 1):
        f.write(f"{n}\n{ts(a)} --> {ts(b)}\n{c}\n\n")

print(f"  wrote {OUT}")
print(f"  first cue {ts(out[0][0])}   last cue ends {ts(out[-1][1])}  (clip is {ts(dur)})")
