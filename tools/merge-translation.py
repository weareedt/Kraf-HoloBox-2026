#!/usr/bin/env python
"""
Pair a hand-written translation with the timings of a machine transcript.

Whisper gives segment timings taken from the actual speech. Its own `--translate` output is
loose with craft terms and Iban words, so the English here is written by hand against the
Malay transcript -- one blank-line-separated block per transcript segment, in order. This
keeps the measured timings and substitutes the text.

It refuses to run if the counts do not match, because a silent off-by-one would shift every
remaining subtitle and still produce a plausible-looking file.

Usage: merge-translation.py <transcript.srt> <translation.txt> <out.srt> [--segments N]
   --segments N uses only the first N transcript segments, for dropping a trailing
   hallucination. Verify it IS one by measuring the audio there before passing this.
"""
import re
import sys

SRT, TXT, OUT = sys.argv[1:4]
LIMIT = int(sys.argv[sys.argv.index("--segments") + 1]) if "--segments" in sys.argv else 0


def sec(s):
    m = re.search(r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})", s)
    return int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3]) + int(m[4]) / 1000


def ts(s):
    h = int(s // 3600)
    m = int(s % 3600 // 60)
    return f"{h:02d}:{m:02d}:{s % 60:06.3f}".replace(".", ",")


spans = []
raw = open(SRT, encoding="utf-8-sig").read().replace("\r\n", "\n")
for block in re.split(r"\n\s*\n", raw.strip()):
    lines = [l for l in block.split("\n") if l.strip()]
    if len(lines) < 2:
        continue
    i = 1 if re.fullmatch(r"\d+", lines[0].strip()) else 0
    if "-->" not in lines[i]:
        continue
    a, b = lines[i].split("-->")
    spans.append((sec(a), sec(b), " ".join(lines[i + 1:]).strip()))

if LIMIT:
    dropped = spans[LIMIT:]
    spans = spans[:LIMIT]
    for a, b, t in dropped:
        print(f"  dropped segment {ts(a)}-{ts(b)}: {t[:60]}")

blocks = [b.strip().replace("\n", " ")
          for b in re.split(r"\n\s*\n", open(TXT, encoding="utf-8-sig").read()) if b.strip()]

if len(blocks) != len(spans):
    sys.exit(f"  REFUSING: {len(spans)} transcript segments but {len(blocks)} translation "
             f"blocks. Every subtitle after the mismatch would be wrong.")

with open(OUT, "w", encoding="utf-8") as f:
    for n, ((a, b, _), text) in enumerate(zip(spans, blocks), 1):
        f.write(f"{n}\n{ts(a)} --> {ts(b)}\n{text}\n\n")

print(f"  {len(spans)} segments merged -> {OUT}")
print(f"  covers {ts(spans[0][0])} to {ts(spans[-1][1])}")
