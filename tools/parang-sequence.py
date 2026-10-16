#!/usr/bin/env python
"""
Turn a parang turntable clip into a PNG sequence for the swipe-rotate viewer.

Both clips are Sony XAVC S-Log3 with `rotation=90` side data -- they decode 2160x3840
PORTRAIT despite the stream saying 3840x2160. Forcing a landscape scale squashes them.

THE BACKDROP IS LIFTED, NOT KEYED. Measured on the graded frame, the polished blade sits at
luma 195 against a backdrop of 181 -- it is BRIGHTER than the wall and just as neutral, so
"neutral and bright" selects the blade more strongly than the background and a key built that
way erases the parang. Instead `out = in * WHITE / plate` carries the blade along with the
wall behind it. Nothing is classified, so nothing can be misclassified, and the result keeps
the object's own tone instead of the blown-out look a hard key gave.

  * plate: temporal median over the whole clip (the object only occupies the centre, so for
    most pixels the backdrop is what is there most of the time), with a degree-3 polynomial
    fitted to the backdrop pixels to recover the centre column the object never leaves.
  * the polynomial is CLAMPED to the range it was fitted to. A quarter of the frame is
    turntable and table with no backdrop in it, and extrapolating into that gap predicted 143
    where the footage measures 170 -- gain x1.78 instead of x1.43, burning out every frame.

--base keep   leaves the wooden rotator disc alone (FullParang: it is part of the shot)
--base drop   removes the disc and the table below BASE_Y, for the clip where the parang
              hangs on a string and the disc is only scenery. Safe there because the subject
              crossing it is neutral steel, while the disc is warm (R-B 63 against 9).
              It is deliberately restricted to the lower frame: run over the whole picture
              the same key also eats the rosewood hilt and its rattan binding.

Usage:
  parang-sequence.py <video> <outdir> <tmp> --start S --turn T --frames N
                     [--base keep|drop] [--long 2048] [--white 250] [--sat 1.30]
"""
import math
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ffmpeg_path import ffmpeg, ffprobe
BIN = ffmpeg()
FFPROBE = ffprobe()

VID, OUTDIR, TMP = sys.argv[1:4]


def arg(flag, default):
    if flag in sys.argv:
        v = sys.argv[sys.argv.index(flag) + 1]
        return type(default)(v) if not isinstance(default, str) else v
    return default


START = arg("--start", 0.0)
TURN = arg("--turn", 2.167)
NFRAMES = arg("--frames", 52)
BASE = arg("--base", "keep")
LONG = arg("--long", 2048)
WHITE = arg("--white", 250)
SAT = arg("--sat", 1.30)
BASE_Y = arg("--base-y", 0.74)      # warm key applies only below this, as a fraction
MARGIN = arg("--margin", 0.03)

W0, W1 = 20, 44                      # (R-B) ramp for the disc and table
PW, PH = 135, 240
NSAMP, DEG = 36, 3
GAIN_UNIT = 64

SLOG3 = ("st(0,val*1023/255);"
         "st(1,if(gte(ld(0),171.2103),pow(10,(ld(0)-420)/261.5)*0.19-0.01,"
         "(ld(0)-95)*0.01125/76.2103));"
         "255*if(lt(ld(1),0.018),4.5*ld(1),1.099*pow(max(ld(1),0),0.45)-0.099)")
LUT = f"lut=c0='{SLOG3}':c1='{SLOG3}':c2='{SLOG3}'"
GRADE = f"format=rgb24,{LUT},eq=saturation={SAT:.3f},format=rgb24"


def run(args):
    r = subprocess.run([BIN, "-v", "error", "-y"] + args, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("ffmpeg failed: " + (r.stderr or "")[-1200:])


def probe(key):
    r = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0",
                        "-show_entries", key, "-of", "default=nw=1:nk=1", VID],
                       capture_output=True, text=True)
    return r.stdout.strip().split("\n")[0]


DUR = float(probe("format=duration"))
FW, FH = int(probe("stream=width")), int(probe("stream=height"))
if FW > FH:
    FW, FH = FH, FW
print(f"  {os.path.basename(VID)}  {DUR:.2f}s  decodes {FW}x{FH}")
print(f"  window {START:.2f}s + {TURN:.3f}s -> {NFRAMES} frames   base={BASE}")


# ---------------------------------------------------------------- plate
def temporal_median():
    raw = os.path.join(TMP, "ps_samp.rgb")
    run(["-i", VID, "-vf", f"fps={NSAMP/DUR:.6f},{GRADE},scale={PW}:{PH}:flags=area",
         "-frames:v", str(NSAMP), "-pix_fmt", "rgb24", "-f", "rawvideo", raw])
    d = open(raw, "rb").read()
    n = len(d) // (PW * PH * 3)
    med = bytearray(PW * PH * 3)
    for i in range(PW * PH * 3):
        v = sorted(d[f * PW * PH * 3 + i] for f in range(n))
        med[i] = v[n // 2]
    os.remove(raw)
    return med


def solve(A, b, m):
    AtA = [[0.0] * m for _ in range(m)]
    Atb = [0.0] * m
    for row, v in zip(A, b):
        for i in range(m):
            Atb[i] += row[i] * v
            ri = row[i]
            for j in range(m):
                AtA[i][j] += ri * row[j]
    for i in range(m):
        AtA[i][i] += 1e-6
        p = max(range(i, m), key=lambda k: abs(AtA[k][i]))
        AtA[i], AtA[p] = AtA[p], AtA[i]
        Atb[i], Atb[p] = Atb[p], Atb[i]
        pv = AtA[i][i]
        if abs(pv) < 1e-12:
            continue
        for k in range(i + 1, m):
            f = AtA[k][i] / pv
            if f:
                for j in range(i, m):
                    AtA[k][j] -= f * AtA[i][j]
                Atb[k] -= f * Atb[i]
    x = [0.0] * m
    for i in range(m - 1, -1, -1):
        s = Atb[i] - sum(AtA[i][j] * x[j] for j in range(i + 1, m))
        x[i] = s / AtA[i][i] if abs(AtA[i][i]) > 1e-12 else 0.0
    return x


def png_rgb(path, buf, w, h):
    import struct
    import zlib
    raw = b"".join(b"\x00" + bytes(buf[y * w * 3:(y + 1) * w * 3]) for y in range(h))

    def ch(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    open(path, "wb").write(b"\x89PNG\r\n\x1a\n"
                           + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                           + ch(b"IDAT", zlib.compress(raw, 6)) + ch(b"IEND", b""))


key = (f"{os.path.basename(VID)}-{NSAMP}-{PW}x{PH}-s{SAT:.2f}".replace(".", "_") + ".raw")
medpath = os.path.join(TMP, "ps_med_" + key)
if os.path.exists(medpath):
    med = bytearray(open(medpath, "rb").read())
    print("  plate samples cached")
else:
    print(f"  building plate from {NSAMP} frames ...")
    med = temporal_median()
    open(medpath, "wb").write(bytes(med))

pts = [[], [], []]
xs, ys = [], []
for y in range(PH):
    for x in range(PW):
        i = (y * PW + x) * 3
        r, g, b = med[i], med[i + 1], med[i + 2]
        if int(r) - int(b) > 14 or 0.299 * r + 0.587 * g + 0.114 * b < 120:
            continue
        xs.append(x / PW)
        ys.append(y / PH)
        for c in range(3):
            pts[c].append(med[i + c])
terms = [(i, j) for i in range(DEG + 1) for j in range(DEG + 1) if i + j <= DEG]
A = [[(x ** i) * (y ** j) for i, j in terms] for x, y in zip(xs, ys)]
coeffs, bounds, resid = [], [], []
for c in range(3):
    co = solve(A, pts[c], len(terms))
    coeffs.append(co)
    err = sorted(abs(sum(a * k for a, k in zip(row, co)) - v)
                 for row, v in zip(A, pts[c]))
    resid.append(err[len(err) // 2])
    obs = sorted(pts[c])
    bounds.append((obs[int(0.02 * (len(obs) - 1))], obs[int(0.98 * (len(obs) - 1))]))
print(f"  plate fitted to {100*len(xs)/(PW*PH):.0f}% of frame, "
      f"residual {max(resid):.1f} levels")

gain = bytearray(PW * PH * 3)
lo, hi = 99.0, 0.0
for y in range(PH):
    for x in range(PW):
        for c in range(3):
            v = sum(k * ((x / PW) ** i) * ((y / PH) ** j)
                    for k, (i, j) in zip(coeffs[c], terms))
            v = max(bounds[c][0], min(bounds[c][1], v))
            g = WHITE / max(v, 1.0)
            lo, hi = min(lo, g), max(hi, g)
            gain[(y * PW + x) * 3 + c] = max(0, min(255, int(round(g * GAIN_UNIT))))
gainpath = os.path.join(TMP, "ps_gain.png")
png_rgb(gainpath, gain, PW, PH)
print(f"  gain x{lo:.2f}..x{hi:.2f}")


# ---------------------------------------------------------------- filter
def ramp_up(a, b):
    return f"lut=c0='if(lte(val,{a}),0,if(gte(val,{b}),255,255*(val-{a})/({b}-{a})))'"


# Rough seek to just before the window, then trim ACCURATELY inside the graph.
#
# `-ss` alone before `-i` is a keyframe seek: ffmpeg lands on the keyframe before the
# timestamp and decodes forward, and the fps filter then emits its first frame from before
# the window. That produced a junk first frame whose nearest match in the whole sequence was
# frame 8 -- it was not a neighbour of anything, and it broke the loop: the wrap step came
# out 2.9x the median while frames 2..26 stepped evenly. Trimming in the graph is exact.
SEEK = max(0.0, START - 0.6)
TRIM = START - SEEK


def graph(extra_out):
    g = (f"[0:v]trim=start={TRIM:.4f}:duration={SEARCH:.4f},setpts=PTS-STARTPTS,"
         f"{GRADE}[g];"
         f"[1:v]scale={FW}:{FH}:flags=bicubic,format=rgb24[gn];"
         f"[g][gn]blend=all_expr='clip(A*B/{GAIN_UNIT},0,255)':shortest=1,"
         "format=rgb24[lift];")
    if BASE == "drop":
        # warm key, restricted to the lower frame by a generated band so the rosewood
        # hilt and its rattan wrap -- both warmer than the disc -- are never touched
        g += ("[lift]split=2[img][w];"
              "[w]format=gbrp,extractplanes=r+b[rw][bw];"
              "[rw][bw]blend=all_mode=subtract[WARM];"
              f"[WARM]{ramp_up(W0, W1)}[mwarm];"
              f"color=c=black:s={FW}x{FH},format=gray,"
              f"geq=lum='if(gt(Y,{int(BASE_Y*FH)}),255,0)',"
              f"boxblur=0:0:0:0:{max(2,int(FH*0.004))}:1[band];"
              "[mwarm][band]blend=all_mode=darken:shortest=1,gblur=sigma=2[ALPHA];"
              f"color=c=0x{WHITE:02X}{WHITE:02X}{WHITE:02X}:s={FW}x{FH},format=rgb24[WHT];"
              "[WHT][ALPHA]alphamerge[wf];"
              "[img][wf]overlay=shortest=1:format=auto,format=rgb24" + extra_out)
    else:
        g += "[lift]null" + extra_out
    return g


# ---------------------------------------------------------------- pick by angle
# Frames are chosen by ANGLE, not by time, and that is what makes the loop close.
#
# The blade hangs on a string and slows as it spins, so no single period describes the clip:
# the autocorrelation is flat across 2.13-2.20s (8.46, 8.46, 8.52) rather than peaked. A
# fixed time window therefore cannot land on exactly 360 degrees, and it did not -- the wrap
# step came out 0.37x the median, frame 26 nearly duplicating frame 1.
#
# So: walk the native frames, use frame-to-frame image distance as a stand-in for angular
# speed, and take the 26 frames at even CUMULATIVE distance. Deceleration stops mattering,
# because a slow stretch simply contributes fewer frames.
AW, AH = 96, 170
SEARCH = TURN * 1.45


def pick_frames():
    raw = os.path.join(TMP, "ps_ang.rgb")
    run(["-ss", str(SEEK), "-i", VID, "-vf",
         f"trim=start={TRIM:.4f}:duration={SEARCH:.4f},setpts=PTS-STARTPTS,"
         f"format=rgb24,{LUT},scale={AW}:{AH}:flags=area",
         "-pix_fmt", "rgb24", "-f", "rawvideo", raw])
    a = open(raw, "rb").read()
    m = len(a) // (AW * AH * 3)
    top = int(AH * 0.62)                       # object only; the table never rotates

    def dd(i, j):
        oi, oj = i * AW * AH * 3, j * AW * AH * 3
        s = 0
        for y in range(0, top):
            base = y * AW * 3
            for x in range(0, AW * 3, 3):
                s += abs(a[oi + base + x] - a[oj + base + x])
        return s / (top * AW)

    # the frame that comes back to frame 0: lowest distance within a sane band
    lo = int(m * (TURN * 0.80) / SEARCH)
    hi = min(m - 1, int(m * (TURN * 1.25) / SEARCH))
    end = min(range(lo, hi + 1), key=lambda k: dd(0, k))
    print(f"  one turn measured as {end} native frames "
          f"({end/ (m/SEARCH):.3f}s)")

    steps = [0.0]
    for f in range(1, end + 1):
        steps.append(steps[-1] + dd(f - 1, f))
    total = steps[end]
    picks = []
    for k in range(NFRAMES):
        target = total * k / NFRAMES
        picks.append(min(range(end + 1), key=lambda f: abs(steps[f] - target)))
    os.remove(raw)
    # a repeat would show as a frozen frame in the spin
    if len(set(picks)) < NFRAMES:
        print(f"  ! only {len(set(picks))} distinct frames for {NFRAMES} slots -- "
              f"the clip does not hold enough rotation")
    return picks, end


PICKS, TURN_FRAMES = pick_frames()
print(f"  picked frames: {PICKS[:8]} ... {PICKS[-3:]}")
SELECT = "+".join(f"eq(n\\,{p})" for p in PICKS)

# ---------------------------------------------------------------- bbox
# One decode pass only. An earlier version rendered the window to throwaway PNGs before
# this, which is a whole extra decode of 4K 10-bit S-Log3 for output nothing ever read.
BW, BH = 180, 320
raw = os.path.join(TMP, "ps_bbox.rgb")
run(["-ss", str(SEEK), "-i", VID, "-loop", "1", "-i", gainpath,
     "-filter_complex", graph(f",select='{SELECT}',scale={BW}:{BH}[out]"), "-map", "[out]",
     "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-f", "rawvideo", raw])
d = open(raw, "rb").read()
nb = len(d) // (BW * BH * 3)

# Count ink per row and per column across every frame, then keep only rows and columns
# carrying a FEW dark pixels. A single-pixel test expanded the box to the whole frame: a
# speck in the top-right corner and the faint remnant of the disc's edge were enough, and
# the object ended up a thin strip in a sea of white.
INK, MINPX = 224, 3
rowink = [0] * BH
colink = [0] * BW
for f in range(nb):
    off = f * BW * BH * 3
    for y in range(BH):
        for x in range(BW):
            k = off + (y * BW + x) * 3
            if d[k] < INK and d[k + 1] < INK and d[k + 2] < INK:
                rowink[y] += 1
                colink[x] += 1
os.remove(raw)
def biggest_run(ink, n):
    """
    Extent of the largest CONTIGUOUS block of inked lines, ignoring islands.

    Taking min and max of every inked line instead let a faint vertical wall edge at the
    far right of the shot -- about 20 ink pixels per column, against 361-1191 for the
    parang itself -- drag the box across the whole frame, leaving the object jammed against
    one edge in a field of white. The object is one solid block; the artefact is a separate
    island, and that is what separates them.
    """
    thr = max(2 * n, int(0.004 * BH * BW * 0.01) + n)
    runs, start = [], None
    for i, v in enumerate(list(ink) + [0]):
        if v >= thr and start is None:
            start = i
        elif v < thr and start is not None:
            runs.append((start, i - 1, sum(ink[start:i])))
            start = None
    if not runs:
        return 0, len(ink) - 1
    a, b, _ = max(runs, key=lambda r: r[2])
    return a, b


y0, y1 = biggest_run(rowink, nb)
x0, x1 = biggest_run(colink, nb)
mx, my = int(BW * MARGIN), int(BH * MARGIN)
x0, x1 = max(0, x0 - mx), min(BW - 1, x1 + mx)
y0, y1 = max(0, y0 - my), min(BH - 1, y1 + my)
cw = int(round((x1 - x0 + 1) / BW * FW)) // 2 * 2
chh = int(round((y1 - y0 + 1) / BH * FH)) // 2 * 2
cx = int(round(x0 / BW * FW)) // 2 * 2
cy = int(round(y0 / BH * FH)) // 2 * 2
print(f"  content bbox {cw}x{chh} at {cx},{cy} of {FW}x{FH}")

sc = LONG / max(cw, chh)
ow, oh = int(cw * sc) // 2 * 2, int(chh * sc) // 2 * 2
fps = NFRAMES / TURN
print(f"  output {ow}x{oh} @ {fps:.2f} fps")

# ---------------------------------------------------------------- render
os.makedirs(OUTDIR, exist_ok=True)
for f in os.listdir(OUTDIR):
    if f.endswith(".png"):
        os.remove(os.path.join(OUTDIR, f))
out = graph(f",select='{SELECT}',"
            f"crop={cw}:{chh}:{cx}:{cy},"
            f"scale={ow}:{oh}:flags=lanczos[out]")
# -fps_mode passthrough is essential with `select`. Without it ffmpeg conforms the output
# to a default frame rate and DUPLICATES frames to fill the gaps the selection left, so
# -frames:v N took N copies of the first frame -- all 26 outputs byte-identical.
run(["-ss", str(SEEK), "-i", VID, "-loop", "1", "-i", gainpath,
     "-filter_complex", out, "-map", "[out]", "-fps_mode", "passthrough",
     "-frames:v", str(NFRAMES),
     "-pix_fmt", "rgb24", "-f", "image2", os.path.join(OUTDIR, "frame-%03d.png")])

files = sorted(f for f in os.listdir(OUTDIR) if f.endswith(".png"))
mb = sum(os.path.getsize(os.path.join(OUTDIR, f)) for f in files) / 1048576
print(f"  wrote {len(files)} frames, {mb:.1f} MB total -> {OUTDIR}")
