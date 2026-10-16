#!/usr/bin/env python
"""
Close a turntable sequence that does not quite come back round.

Norhaiza's first keris jolts once per revolution, and swiping left crosses the join head
on. Measured on the built frames: every step is about 5.9 units apart except the wrap from
the last frame to the first, which is 11.7 — a double step, so one frame's worth of
rotation is simply missing. The source has all 76 frames it was shipped with, numbered
without a gap, so nothing was lost in the build; the original capture never closed the turn.

Two fixes were tried and rejected before this one:

  * A 50/50 BLEND of the two frames ghosts badly. The keris carving is fine detail and the
    result reads as a double exposure, which is more obvious than the jump it replaces.
  * `minterpolate` on just the two frames produces nothing at all — it needs motion context,
    not an isolated pair.

Giving minterpolate the frames either side of the join does work: the synthesised frame is
sharp, and it splits the 6.6-unit gap into 3.7 and 3.8, below the median step. That is what
this does — rebuild the sequence with the missing frame inserted at the join.

Usage: close-loop.py <src-folder> <out-folder> [--context 4] [--pattern "Keris-%02d.png"]
"""
import os
import re
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ffmpeg_path import ffmpeg

BIN = ffmpeg()
SRC, OUT = sys.argv[1], sys.argv[2]


def arg(flag, default):
    return type(default)(sys.argv[sys.argv.index(flag) + 1]) if flag in sys.argv else default


CONTEXT = arg("--context", 4)      # frames taken from each side to feed the flow estimate
TMP = arg("--tmp", OUT + "_tmp")

frames = sorted(f for f in os.listdir(SRC) if f.lower().endswith(".png"))
if len(frames) < CONTEXT * 2:
    sys.exit(f"  need at least {CONTEXT*2} frames, found {len(frames)}")
print(f"  {len(frames)} source frames in {os.path.basename(SRC)}")

shutil.rmtree(TMP, ignore_errors=True)
os.makedirs(TMP)

# the join, with CONTEXT frames either side, in rotation order
order = frames[-CONTEXT:] + frames[:CONTEXT]
for i, f in enumerate(order):
    shutil.copyfile(os.path.join(SRC, f), os.path.join(TMP, "%02d.png" % i))

subprocess.run([BIN, "-v", "error", "-y", "-framerate", "10", "-start_number", "0",
                "-i", os.path.join(TMP, "%02d.png"),
                "-vf", "minterpolate=fps=20:mi_mode=mci:mc_mode=aobmc"
                       ":me_mode=bidir:vsbmc=1",
                "-start_number", "0", os.path.join(TMP, "i%02d.png")], check=True)

# doubling the rate puts each original on an even index; the one we want sits between the
# last source frame and the first, i.e. just after the context frames from the left side
mid = CONTEXT * 2 - 1
bridge = os.path.join(TMP, "i%02d.png" % mid)
if not os.path.exists(bridge):
    sys.exit(f"  interpolation produced no frame at index {mid}")

shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT)
m = re.match(r"^(.*?)(\d+)\.png$", frames[0], re.I)
if not m:
    sys.exit(f"  cannot read a number out of {frames[0]!r}")
stem, width = m.group(1), len(m.group(2))
for i, f in enumerate(frames):
    shutil.copyfile(os.path.join(SRC, f),
                    os.path.join(OUT, f"{stem}{str(i).zfill(width)}.png"))
shutil.copyfile(bridge, os.path.join(OUT, f"{stem}{str(len(frames)).zfill(width)}.png"))
shutil.rmtree(TMP, ignore_errors=True)
print(f"  wrote {len(frames)+1} frames -> {OUT}  (one synthesised at the join)")
