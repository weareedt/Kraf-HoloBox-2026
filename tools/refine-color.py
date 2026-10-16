#!/usr/bin/env python
"""
Colour-correct a turntable clip and lift its backdrop to white. Nothing else.

No key, no crop, no frame selection -- the whole frame comes through, including the wooden
rotator disc, the table and any hands. This is an intermediate for further work, so it stays
deliberately non-destructive.

Two things happen:

  1. S-LOG3 -> REC.709. Both clips are Sony XAVC, 10-bit 4:2:2, and every pixel sits between
     luma 95 and 139 with saturation about 2 -- the log signature, and why the raw footage
     looks flat and grey. The published inverse transfer to scene linear followed by the
     Rec.709 OETF is the correct fix; a contrast slider is not. A saturation boost stands in
     for the S-Gamut3.Cine -> Rec.709 matrix.

  2. BACKDROP LIFTED, NOT KEYED. Measured on the graded frame the polished blade sits at
     luma 195 against a backdrop of 181 -- BRIGHTER than the wall and just as neutral. Any
     "neutral and bright" key therefore selects the blade more strongly than the background
     and erases the parang; that was tried and it returned blank white frames. Instead
     `out = in * WHITE / plate` carries the blade along with the wall behind it, so nothing
     is classified and nothing can be misclassified.

     MULTIPLICATIVE, not additive. The stage clips add `WHITE - plate` because their gap to
     white is only ~40 levels. Here it is ~74, with dark corners wanting +142, and adding
     that globally lifts the dark rosewood hilt from 60 to 202 -- the whole picture goes flat
     and chalky. A gain sends the backdrop to white and leaves the hilt at 85.

     The plate comes from a temporal median over the clip, with a degree-3 polynomial fitted
     to its backdrop pixels, CLAMPED to the range it was fitted to. A quarter of the frame is
     turntable and table with no backdrop in it, and extrapolating into that gap predicted
     143 where the footage measures 170 -- gain x1.78 instead of x1.43, burning out the
     bottom of every frame.

Both clips carry `rotation=90` side data: they decode 2160x3840 PORTRAIT even though the
stream says 3840x2160. Forcing a landscape scale squashes them.

Usage: refine-color.py <video> <out.mp4> <tmp> [--white 250] [--sat 1.30] [--crf 12]
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ffmpeg_path import ffmpeg, ffprobe
BIN = ffmpeg()
FFPROBE = ffprobe()

VID, OUT, TMP = sys.argv[1:4]
# Scratch names are per-video. Two instances sharing "rc_samp.rgb" and "rc_gain.png" had
# one delete the other's working file mid-run.
TAG = os.path.splitext(os.path.basename(VID))[0].replace(" ", "_")


def arg(flag, default):
    if flag in sys.argv:
        return type(default)(sys.argv[sys.argv.index(flag) + 1])
    return default


WHITE = arg("--white", 250)
SAT = arg("--sat", 1.30)
CRF = arg("--crf", 14)

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


def temporal_median():
    raw = os.path.join(TMP, f"rc_samp_{TAG}.rgb")
    # fps FIRST: the S-Log3 lut is a per-pixel expression over an 8.3 Mpixel frame, and
    # running it across the whole clip to then throw 96% of the frames away is minutes of
    # work for nothing.
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


# Cached: building it decodes the whole clip, and 4K 10-bit 4:2:2 at 220 Mbit/s takes
# minutes. The key carries everything the plate depends on -- a cache key that does not
# include its inputs is a silent wrong answer, not a stale file.
key = f"{os.path.basename(VID)}-{NSAMP}-{PW}x{PH}-s{SAT:.2f}".replace(".", "_") + ".raw"
medpath = os.path.join(TMP, "rc_med_" + key)
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
            continue                       # wood or object, not backdrop
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
    err = sorted(abs(sum(a * k for a, k in zip(row, co)) - v) for row, v in zip(A, pts[c]))
    resid.append(err[len(err) // 2])
    obs = sorted(pts[c])
    bounds.append((obs[int(0.02 * (len(obs) - 1))], obs[int(0.98 * (len(obs) - 1))]))
print(f"  plate fitted to {100*len(xs)/(PW*PH):.0f}% of frame, "
      f"residual {max(resid):.1f} levels")
if max(resid) > 4:
    print("  ! residual high -- the fit may not describe this backdrop well")

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
gainpath = os.path.join(TMP, f"rc_gain_{TAG}.png")
png_rgb(gainpath, gain, PW, PH)
print(f"  gain x{lo:.2f}..x{hi:.2f}  (target white {WHITE})")
if hi > 255 / GAIN_UNIT:
    print(f"  ! gain exceeds x{255/GAIN_UNIT:.2f} and is clipping -- lower --white")

# shortest=1 is essential: the `-loop 1` gain image never reaches EOF, and blend's framesync
# waits for every input, so without it the encode never finishes. `-shortest` on the output
# cannot rescue it with a single output stream.
# The `format=rgb24` AFTER the blend is the load-bearing one, and leaving it out produced a
# fully magenta render. Putting `format=rgb24` on blend's two INPUTS is not enough: ffmpeg
# negotiates formats backwards from what the next filter wants, so with `format=yuv420p`
# straight after it, the blend itself ran in YUV and the gain multiplied the chroma planes
# as well as luma. Measured on the backdrop: rgb(255,117,255) without it, rgb(247,250,247)
# with it. The README's older note to "add the offset in RGB" is necessary but not
# sufficient -- the RGB has to be pinned on the output side of the blend.
fc = (f"[0:v]{GRADE}[g];"
      f"[1:v]scale={FW}:{FH}:flags=bicubic,format=rgb24[gn];"
      f"[g][gn]blend=all_expr='clip(A*B/{GAIN_UNIT},0,255)':shortest=1,"
      "format=rgb24,format=yuv420p[out]")

os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
run(["-i", VID, "-loop", "1", "-i", gainpath, "-filter_complex", fc, "-map", "[out]",
     "-c:v", "libx264", "-preset", "medium", "-crf", str(CRF),
     "-pix_fmt", "yuv420p", "-an", "-shortest", OUT])
mb = os.path.getsize(OUT) / 1048576
print(f"  wrote {OUT}  {mb:.1f} MB  (crf {CRF})")
