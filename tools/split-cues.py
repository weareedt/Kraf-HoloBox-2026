#!/usr/bin/env python
"""
Split over-long subtitle cues into readable ones, keeping the measured timing.

Whisper's own segments carry timings taken from the actual speech, which is exactly what
the subtitles need -- but a segment can run to 150 characters, far past what fits on a
two-line band. This splits those at sentence and clause boundaries and hands each piece a
share of the segment's time proportional to its character count.

That proportional split is an approximation INSIDE a segment only. It never accumulates,
because every segment's start and end are the ones Whisper measured, so an error cannot
drift past the end of the cue it occurred in -- unlike spreading a whole script across a
clip, which is what produced the drift this replaces.

Usage: split-cues.py <in.srt> <out.srt> [--max 84] [--line 46]
"""
import re
import sys

SRC, DST = sys.argv[1:3]


def arg(flag, default):
    return type(default)(sys.argv[sys.argv.index(flag) + 1]) if flag in sys.argv else default


MAX = arg("--max", 84)       # characters before a cue must be split
LINE = arg("--line", 46)     # characters per displayed line
MIN_CUE = 1.0
GAP = 0.04


def parse(path):
    text = open(path, encoding="utf-8-sig").read().replace("\r\n", "\n")
    cues = []
    for block in re.split(r"\n\s*\n", text.strip()):
        lines = [l for l in block.split("\n") if l.strip()]
        if len(lines) < 2:
            continue
        i = 1 if re.fullmatch(r"\d+", lines[0].strip()) else 0
        if "-->" not in lines[i]:
            continue
        a, b = lines[i].split("-->")

        def sec(s):
            m = re.search(r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})", s)
            return int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3]) + int(m[4]) / 1000

        body = " ".join(lines[i + 1:]).strip()
        if body:
            cues.append([sec(a), sec(b), body])
    return cues


def ts(s):
    h = int(s // 3600)
    m = int(s % 3600 // 60)
    return f"{h:02d}:{m:02d}:{s % 60:06.3f}".replace(".", ",")


def pieces(text):
    """Break at sentence ends first, then at clause commas, then on words."""
    out = []
    for sent in re.split(r"(?<=[.!?])\s+", text):
        if not sent:
            continue
        if len(sent) <= MAX:
            out.append(sent)
            continue
        part, buf = re.split(r"(?<=,)\s+", sent), ""
        for p in part:
            if len(buf) + len(p) + 1 <= MAX:
                buf = f"{buf} {p}".strip()
            else:
                if buf:
                    out.append(buf)
                buf = p
        if buf:
            out.append(buf)
    # Anything still too long is broken on words into BALANCED chunks. Greedily filling to
    # MAX instead leaves an orphan: an 86-character sentence became a 79-character cue
    # followed by a 0.46s cue reading "Ilang."
    final = []
    for p in out:
        if len(p) <= MAX:
            final.append(p)
            continue
        words = p.split()
        n = -(-len(p) // MAX)                      # chunks needed, rounded up
        target = len(p) / n
        chunks, buf = [], ""
        for w in words:
            cand = f"{buf} {w}".strip()
            # close the chunk once adding another word would take it further from the
            # target than stopping here, as long as chunks remain to hold the rest
            if buf and len(chunks) < n - 1 and abs(len(cand) - target) > abs(len(buf) - target):
                chunks.append(buf)
                buf = w
            else:
                buf = cand
        if buf:
            chunks.append(buf)
        final.extend(chunks)
    return final


def wrap(text):
    """Two display lines, balanced, breaking on a word."""
    if len(text) <= LINE:
        return text
    words = text.split()
    best, bestcost = None, None
    for k in range(1, len(words)):
        a, b = " ".join(words[:k]), " ".join(words[k:])
        if len(a) > LINE or len(b) > LINE:
            continue
        cost = abs(len(a) - len(b))
        if bestcost is None or cost < bestcost:
            best, bestcost = (a, b), cost
    if best:
        return best[0] + "\n" + best[1]
    # cannot fit two lines; let it be long rather than drop words
    return text


cues = parse(SRC)
out = []
for a, b, text in cues:
    ps = pieces(text)
    if len(ps) == 1:
        out.append([a, b, ps[0]])
        continue
    total = sum(max(len(p), 1) for p in ps)
    acc = 0
    for p in ps:
        w = max(len(p), 1)
        s = a + (b - a) * acc / total
        acc += w
        e = a + (b - a) * acc / total
        out.append([s, e, p])

for i in range(len(out) - 1):
    if out[i][1] > out[i + 1][0] - GAP:
        out[i][1] = max(out[i][0] + 0.3, out[i + 1][0] - GAP)

with open(DST, "w", encoding="utf-8") as f:
    for n, (a, b, t) in enumerate(out, 1):
        f.write(f"{n}\n{ts(a)} --> {ts(b)}\n{wrap(t)}\n\n")

longest = max(len(l) for _, _, t in out for l in wrap(t).split("\n"))
short = sum(1 for a, b, _ in out if b - a < MIN_CUE)
print(f"  {len(cues)} segments -> {len(out)} cues")
print(f"  longest display line {longest} chars (limit {LINE})")
print(f"  cues under {MIN_CUE}s: {short}")
print(f"  wrote {DST}")
