#!/usr/bin/env python
"""
Reproduce the hand-made Photoshop clean-up across a whole turntable sequence.

The reference is the .psd saved beside each sequence: the object alone on white, with the
rotator disc, the table, the hands and the studio wall edge all gone, and the object kept
down to where it meets the disc.

Measured off that PSD against its own frame, the edit is three zones:

  1. ABOVE the disc   - keep a wide band around the object, fill outside it. That removes
                        the hands (x > 690) and the studio wall edge.
  2. ACROSS the disc  - keep only the object, fill the rest. This is the hard part.
  3. BELOW the object - fill everything.

ZONE 2 CANNOT BE DONE BY COLOUR, and the PSD proves it. Scoring every pixel in that band
against what the PSD kept:

    parang   luma  p50  66   p90 162   p99 220   max 235   (the pale rattan binding)
    disc     luma  min  67   p10 173   p50 232

They overlap, so the best a brightness ramp manages is losing 8% of the parang or keeping
1% of the disc -- either visible. Warmth is no better: at the blade tip the disc rim reads
R-B 58 against the blade's 53.

What does separate them is SHAPE. In every row the object is one contiguous horizontal run,
and the disc is what lies outside it. So each row's dark core is found, the span between its
extremes is kept -- which carries the pale rattan along, because the rattan sits BETWEEN
dark edges -- and everything outside is filled. Rows whose core is hidden (a row crossing a
rattan band can have no dark pixel at all) inherit their neighbours' span through a median
filter, since the object's width changes slowly down its length.

The frames are RGBA with transparent bands top and bottom, and are flattened onto the fill
colour, which is sampled from the PSD so the filled area cannot seam against the kept
backdrop. Reading them as RGB instead turns those bands BLACK.

Usage:
  clean-sequence.py <folder> <outdir> --disc-top Y --obj-bottom Y --band X0,X1
                    [--fill R,G,B] [--core 120] [--pad 4] [--smooth 15] [--tmp DIR]
"""
import os
import struct
import subprocess
import sys
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ffmpeg_path import ffmpeg, ffprobe
BIN = ffmpeg()

FOLDER, OUTDIR = sys.argv[1], sys.argv[2]


def arg(flag, default):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default


DISC_TOP = int(arg("--disc-top", 1548))
OBJ_BOTTOM = int(arg("--obj-bottom", 1692))
BAND = [int(v) for v in arg("--band", "385,695").split(",")]
FILL = [int(v) for v in arg("--fill", "251,250,252").split(",")]
CORE = int(arg("--core", 120))      # "unmistakably the object" luma
PAD = int(arg("--pad", 4))          # grown either side of the measured span
SMOOTH = int(arg("--smooth", 15))   # median window, in rows
DILATE = int(arg("--dilate", 12))   # envelope window, in rows
TMP = arg("--tmp", OUTDIR)

W, H = 1080, 2048
BH = OBJ_BOTTOM        # the row-span mask covers everything above the object bottom
FILLHEX = "0x%02X%02X%02X" % tuple(FILL)

pngs = sorted(f for f in os.listdir(FOLDER) if f.lower().endswith(".png"))
if not pngs:
    sys.exit(f"  no PNGs in {FOLDER}")
os.makedirs(OUTDIR, exist_ok=True)
print(f"  {len(pngs)} frames from {os.path.basename(FOLDER)}")
print(f"  disc {DISC_TOP}..{OBJ_BOTTOM} ({BH} rows)  band {BAND}  fill {FILLHEX}"
      f"  core <{CORE}  smooth {SMOOTH} dilate {DILATE} pad {PAD}")


def run(args):
    r = subprocess.run([BIN, "-v", "error", "-y"] + args, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("ffmpeg failed: " + (r.stderr or "")[-900:])


def png_gray(path, buf, w, h):
    raw = b"".join(b"\x00" + bytes(buf[y * w:(y + 1) * w]) for y in range(h))

    def ch(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    open(path, "wb").write(b"\x89PNG\r\n\x1a\n"
                           + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
                           + ch(b"IDAT", zlib.compress(raw, 6)) + ch(b"IEND", b""))


bandraw = os.path.join(TMP, "_cs_band.rgba")
maskpng = os.path.join(TMP, "_cs_mask.png")
report = []

for n, f in enumerate(pngs):
    src = os.path.join(FOLDER, f)
    run(["-i", src, "-vf", f"scale={W}:{H},crop={W}:{BH}:0:0",
         "-pix_fmt", "rgba", "-f", "rawvideo", bandraw])
    d = open(bandraw, "rb").read()

    spans = []
    for y in range(BH):
        base = y * W
        lo = hi = None
        for x in range(BAND[0], BAND[1] + 1):      # inwards from the left
            k = (base + x) * 4
            if d[k + 3] >= 128 and                d[k] * 0.299 + d[k + 1] * 0.587 + d[k + 2] * 0.114 < CORE:
                lo = x
                break
        if lo is not None:
            for x in range(BAND[1], lo - 1, -1):   # and inwards from the right
                k = (base + x) * 4
                if d[k + 3] >= 128 and                    d[k] * 0.299 + d[k + 1] * 0.587 + d[k + 2] * 0.114 < CORE:
                    hi = x
                    break
        spans.append((lo, hi) if lo is not None and hi is not None else None)

    # Reject rows whose span is implausibly wide. The object's width changes smoothly down
    # its length, so a row two or three times the typical width is not the object getting
    # fatter -- it is something else dark in that row. A fingertip with a shadow under it
    # read as core at x 695 and stretched two rows from ~90 px to 207, leaving the finger
    # in the output.
    widths = sorted(s[1] - s[0] for s in spans if s)
    if widths:
        typical = widths[len(widths) // 2]
        limit = max(int(typical * 1.9), typical + 40)
        spans = [s if (s and s[1] - s[0] <= limit) else None for s in spans]

    known = [i for i, s in enumerate(spans) if s]
    if not known:
        report.append((f, None))
        spans = [(BAND[0], BAND[1])] * BH
    else:
        # rows with no visible core inherit the nearest measured row
        for i in range(BH):
            if spans[i] is None:
                j = min(known, key=lambda k: abs(k - i))
                spans[i] = spans[j]
        # Two passes, and both are needed.
        #
        # MEDIAN first, so one stray dark pixel out on the disc cannot widen a row.
        #
        # Then DILATE: running min of the left edge and max of the right edge. Median alone
        # cut a notch out of the parang wherever a pale rattan band crosses its edge -- the
        # dark core there shrank from 48 px to 10, and the median followed it down. The span
        # has to be an envelope that never shrinks faster than the object does, and the
        # object's width changes slowly, so taking the extremes over a short window closes
        # those notches while costing only a few pixels of disc at the edges.
        los = [s[0] for s in spans]
        his = [s[1] for s in spans]
        med_lo, med_hi = [], []
        for i in range(BH):
            a = max(0, i - SMOOTH // 2)
            b = min(BH, i + SMOOTH // 2 + 1)
            med_lo.append(sorted(los[a:b])[(b - a) // 2])
            med_hi.append(sorted(his[a:b])[(b - a) // 2])
        spans = []
        for i in range(BH):
            a = max(0, i - DILATE)
            b = min(BH, i + DILATE + 1)
            lo = min(med_lo[a:b]) - PAD
            hi = max(med_hi[a:b]) + PAD
            spans.append((max(BAND[0], lo), min(BAND[1], hi)))
        report.append((f, (min(s[0] for s in spans), max(s[1] for s in spans))))

    mask = bytearray(W * BH)            # 255 = fill, 0 = keep
    for y in range(BH):
        lo, hi = spans[y]
        row = y * W
        for x in range(W):
            if x < lo or x > hi:
                mask[row + x] = 255
    png_gray(maskpng, mask, W, BH)

    # Only the zone below the object needs a box now: the row-span mask covers everything
    # above it, full height. Keeping a plain "wide band" above the disc let a fingertip
    # survive inside it at y 1516 -- the object there spans x 490..590 and the finger sat at
    # x 647, inside the band but nowhere near the parang.
    boxes = [
        f"drawbox=x=0:y={OBJ_BOTTOM}:w={W}:h={H-OBJ_BOTTOM}:color={FILLHEX}@1:t=fill",
    ]
    fc = (f"color=c={FILLHEX}:s={W}x{H},format=rgb24[bg];"
          f"[0:v]scale={W}:{H},format=rgba[a];"
          f"[bg][a]overlay=shortest=1:format=auto,format=rgb24,"
          + ",".join(boxes) + "[base];"
          f"color=c={FILLHEX}:s={W}x{BH},format=rgb24[bf];"
          f"[1:v]format=gray[mk];"
          f"[bf][mk]alphamerge[bandfill];"
          f"[base][bandfill]overlay=0:0:format=auto,format=rgb24[out]")
    # -frames:v 1 because two still inputs otherwise make the image2 muxer try to write
    # several frames to the same filename.
    # -pix_fmt rgb24 is not optional. Without it ffmpeg's PNG encoder picks its own format
    # and chose an 8-BIT PALETTE: a crop of the sheath went from 28,721 colours to 252,
    # which bands the wood badly once it is blown up on a 2 m screen. The file still looks
    # fine in a thumbnail, which is why it went unnoticed.
    run(["-i", src, "-i", maskpng, "-filter_complex", fc, "-map", "[out]",
         "-frames:v", "1", "-pix_fmt", "rgb24", os.path.join(OUTDIR, f)])

    if n % 10 == 0 or n == len(pngs) - 1:
        s = report[-1][1]
        print(f"   {n+1}/{len(pngs)}  span x {s[0]}..{s[1]}" if s
              else f"   {n+1}/{len(pngs)}  no object core found")

for p in (bandraw, maskpng):
    if os.path.exists(p):
        os.remove(p)
blank = [f for f, s in report if s is None]
if blank:
    print(f"  ! {len(blank)} frames had no object core in the disc band: {blank[:5]}")
mb = sum(os.path.getsize(os.path.join(OUTDIR, f)) for f in pngs) / 1048576
print(f"  wrote {len(pngs)} frames, {mb:.1f} MB -> {OUTDIR}")
