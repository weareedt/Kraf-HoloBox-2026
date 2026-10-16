#!/usr/bin/env python
"""
Refine Johnny's two parang turntable videos: convert the log, lift the backdrop to white,
and remove the wooden turntable disc, the table and the hands.

Both clips are Sony XAVC, 10-bit 4:2:2 HEVC at ~220 Mbit/s, and both carry rotation=90
side data -- they decode 2160x3840 PORTRAIT even though the stream says 3840x2160. Forcing
them into a landscape scale silently squashes them, which is how the first look at this
footage went wrong.

THE BACKDROP CANNOT BE KEYED, and that is the whole shape of this script. Measured on the
graded frame:

    backdrop   luma 181   sat  3
    blade      luma 195   sat  9     <-- BRIGHTER than the backdrop, and as neutral
    disc       luma 157   sat 63
    table      luma 135   sat 48

The parang is polished steel reflecting a white backdrop, so "neutral and bright" selects
the blade more strongly than the backdrop. A key built that way erases the parang and
returns a blank white frame, which is exactly what it did.

So the two problems are solved by two different mechanisms:

  * THE BACKDROP is lifted, not keyed: out = in + (WHITE - plate), the same additive offset
    used for the stage clips. Nothing is classified, so nothing can be misclassified -- the
    blade is simply carried along by the same offset as the wall behind it.

    The plate is built by TEMPORAL MEDIAN. The camera is static and the parang only
    occupies the centre, so for most pixels the backdrop is what is there most of the time.
    The centre column, which the parang never leaves, is recovered by fitting a 2-D
    polynomial to the pixels that ARE backdrop and evaluating it everywhere -- the same
    reconstruction as tools/make-plate.py.

  * THE DISC, TABLE AND HANDS are keyed on warmth alone, with no brightness term. They are
    the only strongly warm things in frame (R-B 48-63 against 1-9 for the backdrop and the
    blade), and they are what "remove the bottom base" asks for. The hands come out with
    them for free, which matters because a hand is in shot for nearly all of FullParang.

Usage: refine-parang-video.py <video> <out.mp4> <tmp> [--white N] [--sat N] [--seconds N]
"""
import math
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ffmpeg_path import ffmpeg, ffprobe
BIN = ffmpeg()
FFPROBE = ffprobe()

VID, OUT, TMP = sys.argv[1:4]


def arg(flag, default):
    return type(default)(sys.argv[sys.argv.index(flag) + 1]) if flag in sys.argv else default


WHITE = arg("--white", 246)     # headroom below 255 so the disc's soft shadow survives
SAT = arg("--sat", 1.30)        # stands in for S-Gamut3.Cine -> Rec.709
SECONDS = arg("--seconds", 0.0)  # 0 = whole clip
START = arg("--start", 0.0)      # trim point, for cutting the hands out
W0, W1 = 18, 38                 # (R-B) ramp for the disc/table/hands
PALE_V = 100                    # the fill travels only through wood brighter than this
PW, PH = 135, 240               # plate-fitting resolution
NSAMP = 36                      # frames in the temporal median
DEG = 3                         # polynomial degree per axis

SLOG3 = ("st(0,val*1023/255);"
         "st(1,if(gte(ld(0),171.2103),pow(10,(ld(0)-420)/261.5)*0.19-0.01,"
         "(ld(0)-95)*0.01125/76.2103));"
         "255*if(lt(ld(1),0.018),4.5*ld(1),1.099*pow(max(ld(1),0),0.45)-0.099)")
LUT = f"lut=c0='{SLOG3}':c1='{SLOG3}':c2='{SLOG3}'"
GRADE = f"format=rgb24,{LUT},eq=saturation={SAT:.3f},format=rgb24"


def run(args, **kw):
    r = subprocess.run([BIN, "-v", "error", "-y"] + args, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        raise RuntimeError("ffmpeg failed: " + (r.stderr or "(no stderr)")[-1500:])
    return r


def probe(key):
    r = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0",
                        "-show_entries", key, "-of", "default=nw=1:nk=1", VID],
                       capture_output=True, text=True)
    return r.stdout.strip().split("\n")[0]


DUR = float(probe("format=duration"))
FULL_W, FULL_H = int(probe("stream=width")), int(probe("stream=height"))
if FULL_W > FULL_H:                       # rotation=90 -> the decoded frame is portrait
    FULL_W, FULL_H = FULL_H, FULL_W
print(f"  {os.path.basename(VID)}  {DUR:.2f}s  decodes {FULL_W}x{FULL_H}")


def ramp_up(a, b):
    return f"lut=c0='if(lte(val,{a}),0,if(gte(val,{b}),255,255*(val-{a})/({b}-{a})))'"


# ---------------------------------------------------------------- the plate

def temporal_median():
    raw = os.path.join(TMP, "pv_samp.rgb")
    # fps FIRST. The S-Log3 lut is a per-pixel expression over an 8.3 Mpixel frame; running
    # it across the whole clip to then throw away 96% of the frames is minutes of work for
    # nothing. Decimating first grades only the frames the median actually uses.
    run(["-i", VID, "-vf", f"fps={NSAMP/DUR:.6f},{GRADE},scale={PW}:{PH}:flags=area",
         "-frames:v", str(NSAMP), "-pix_fmt", "rgb24", "-f", "rawvideo", raw])
    d = open(raw, "rb").read()
    n = len(d) // (PW * PH * 3)
    med = bytearray(PW * PH * 3)
    for i in range(PW * PH * 3):
        vals = sorted(d[f * PW * PH * 3 + i] for f in range(n))
        med[i] = vals[n // 2]
    os.remove(raw)
    return med, n


def fit_plate(med):
    """Degree-DEG 2-D polynomial per channel, fitted only to backdrop pixels."""
    pts = [[], [], []]
    xs, ys = [], []
    for y in range(PH):
        for x in range(PW):
            i = (y * PW + x) * 3
            r, g, b = med[i], med[i + 1], med[i + 2]
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            if int(r) - int(b) > 14 or lum < 120:     # disc/table, or the parang
                continue
            xs.append(x / PW)
            ys.append(y / PH)
            for c in range(3):
                pts[c].append(med[i + c])
    cover = len(xs) / (PW * PH)

    terms = [(i, j) for i in range(DEG + 1) for j in range(DEG + 1) if i + j <= DEG]
    A = [[(x ** i) * (y ** j) for i, j in terms] for x, y in zip(xs, ys)]
    coeffs = []
    resid = []
    bounds = []
    for c in range(3):
        co = solve_lstsq(A, pts[c], len(terms))
        coeffs.append(co)
        err = [abs(sum(a * k for a, k in zip(row, co)) - v) for row, v in zip(A, pts[c])]
        err.sort()
        resid.append(err[len(err) // 2])
        # The range the fit is ENTITLED to predict. A quarter of the frame is turntable and
        # table, with no backdrop in it at all, and a degree-3 surface extrapolating into
        # that gap ran away: it predicted 143 where the footage measures 170, so the gain
        # there reached x1.78 instead of x1.43 and burnt the bottom of every frame out.
        # Extrapolation beyond the fitted data is not evidence, so the plate is clamped to
        # what was actually observed.
        obs = sorted(pts[c])
        bounds.append((obs[int(0.02 * (len(obs) - 1))], obs[int(0.98 * (len(obs) - 1))]))
    return terms, coeffs, cover, resid, bounds


def solve_lstsq(A, b, m):
    """Normal equations + Gaussian elimination. m is small (10 for DEG=3)."""
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

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    open(path, "wb").write(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b""))


# Cached because building it decodes the whole clip, and 4K 10-bit 4:2:2 at 220 Mbit/s takes
# minutes. The key carries everything the plate depends on -- a cache key that does not
# include its inputs is a silent wrong answer, not a stale file.
medkey = (f"{os.path.basename(VID)}-{NSAMP}-{PW}x{PH}-sat{SAT:.2f}"
          .replace(".", "_") + ".raw")
medpath = os.path.join(TMP, "pv_med_" + medkey)
if os.path.exists(medpath):
    med = bytearray(open(medpath, "rb").read())
    print(f"  plate samples cached ({medkey})")
else:
    print(f"  building plate from {NSAMP} frames ...")
    med, _n = temporal_median()
    open(medpath, "wb").write(bytes(med))
terms, coeffs, cover, resid, bounds = fit_plate(med)
print(f"  plate fitted to {100*cover:.0f}% of the frame"
      f"   median residual R{resid[0]:.1f} G{resid[1]:.1f} B{resid[2]:.1f} levels")
if max(resid) > 4:
    print("  ! residual is high -- the fit may not describe this backdrop well")

# The GAIN image: WHITE / plate, evaluated at the plate's resolution and scaled up by ffmpeg.
# It is a smooth low-order surface, so upscaling it loses nothing.
#
# MULTIPLICATIVE, NOT ADDITIVE -- and this is the whole correction, not a detail. The stage
# clips use `out = in + (WHITE - plate)` because their backdrop is already near white and the
# offset is ~40 levels, small enough that brightening a mis-matted pixel is harmless. Here the
# graded backdrop sits at 181 and the gap to white is ~74, with the plate's dark corners
# needing +142. Added globally that lifts the dark rosewood hilt from 60 to 202 and flattens
# the whole picture; worse, it drives channels into the 255 ceiling, which destroys R-B and so
# BLINDS THE WARM KEY -- the disc, table and hand stopped being removed at all.
#
# Illumination is a gain, not an offset. `out = in * WHITE / plate` sends the backdrop to
# WHITE while leaving a dark pixel proportionally dark: the hilt goes 60 -> 85, not 60 -> 202.
#
# Carried at 1/64 scale (64 = unity) so gains up to 3.98 fit in an unsigned image.
GAIN_UNIT = 64
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
offpath = os.path.join(TMP, "pv_gain.png")
png_rgb(offpath, gain, PW, PH)


def stand_region(med):
    """
    Border-connected warm material: the turntable disc and the table it stands on.

    THE WARM KEY MUST BE RESTRICTED TO THIS. Run over the whole frame it also removes the
    parang's own rosewood hilt and rattan binding, which are warmer than the disc -- the
    hilt came out as a white silhouette.

    Connectivity separates them because of how the shot is built: the parang stands free in
    the middle and touches no edge of the frame, while the disc and the table run off every
    side. Computed on the TEMPORAL MEDIAN, which is hand-free by construction, so one static
    region serves the whole clip.
    """
    from collections import deque
    warm = bytearray(PW * PH)
    for y in range(PH):
        for x in range(PW):
            i = (y * PW + x) * 3
            r, g, b = med[i], med[i + 1], med[i + 2]
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            # PALE warm only. On FullParang the parang is SHEATHED -- warm rosewood standing
            # directly ON the warm disc -- so a fill that travels through any warm pixel
            # climbs straight up the object and whites out the whole parang. Measured on the
            # median: disc 150, table 118, sheath 62. The gate splits them.
            if int(r) - int(b) > W0 - 4 and lum > PALE_V:
                warm[y * PW + x] = 1
    seen = bytearray(PW * PH)
    q = deque()
    for x in range(PW):
        for y in (0, PH - 1):
            k = y * PW + x
            if warm[k] and not seen[k]:
                seen[k] = 1
                q.append(k)
    for y in range(PH):
        for x in (0, PW - 1):
            k = y * PW + x
            if warm[k] and not seen[k]:
                seen[k] = 1
                q.append(k)
    while q:
        k = q.popleft()
        x, y = k % PW, k // PW
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < PW and 0 <= ny < PH:
                nk = ny * PW + nx
                if warm[nk] and not seen[nk]:
                    seen[nk] = 1
                    q.append(nk)
    # Dilate generously: this only RESTRICTS a per-pixel key, so overreach costs nothing and
    # covers the hand where it rests on the disc.
    for _ in range(4):
        nxt = bytearray(seen)
        for y in range(PH):
            row = y * PW
            for x in range(PW):
                if seen[row + x]:
                    continue
                if ((x and seen[row + x - 1]) or (x < PW - 1 and seen[row + x + 1])
                        or (y and seen[row - PW + x]) or (y < PH - 1 and seen[row + PW + x])):
                    nxt[row + x] = 1
        seen = nxt
    return bytearray(255 if v else 0 for v in seen), sum(1 for v in seen if v) / (PW * PH)


reg, regcov = stand_region(med)
regpath = os.path.join(TMP, "pv_region.png")
png_rgb(regpath, bytearray(v for p in reg for v in (p, p, p)), PW, PH)
print(f"  disc/table region {100*regcov:.0f}% of frame")
print(f"  gain ranges x{lo:.2f}..x{hi:.2f}")
if hi > 255 / GAIN_UNIT:
    print(f"  ! gain exceeds x{255/GAIN_UNIT:.2f} and is being clipped -- lower --white")
if lo < 0:
    print("  ! negative offset -- the plate is brighter than WHITE somewhere; raise --white")

# ---------------------------------------------------------------- the render

fc = (
    f"[0:v]{GRADE}[g];"
    f"[1:v]scale={FULL_W}:{FULL_H}:flags=bicubic,format=rgb24[off];"
    # out = in * gain, done in RGB. In YUV the correction lands on the chroma planes too and
    # the whole frame comes out magenta.
    #
    # shortest=1 IS NOT OPTIONAL on either of the two filters fed by an endless input -- the
    # `-loop 1` offset image and the `color` source. blend's and overlay's framesync run
    # until EVERY input reaches EOF, and neither of those ever does, so without it the
    # encode never finishes: a one-second test ran for twenty minutes. `-shortest` on the
    # output cannot rescue it, because there is only one output stream.
    f"[g][off]blend=all_expr='clip(A*B/{GAIN_UNIT},0,255)':shortest=1,format=rgb24[lifted];"
    "[lifted]split=2[img][w];"
    "[w]format=gbrp,extractplanes=r+b[rw][bw];"
    "[rw][bw]blend=all_mode=subtract[WARM];"
    f"[WARM]{ramp_up(W0, W1)}[mwarm];"
    f"[2:v]scale={FULL_W}:{FULL_H}:flags=bicubic,format=gray[REGION];"
    "[mwarm][REGION]blend=all_mode=darken:shortest=1,gblur=sigma=2[ALPHA];"
    f"color=c=0x{WHITE:02X}{WHITE:02X}{WHITE:02X}:s={FULL_W}x{FULL_H},format=rgb24[WHT];"
    "[WHT][ALPHA]alphamerge[wf];"
    "[img][wf]overlay=shortest=1:format=auto,format=yuv420p[out]"
)

args = ["-i", VID, "-loop", "1", "-i", offpath, "-loop", "1", "-i", regpath]
if SECONDS:
    args = ["-t", str(SECONDS)] + args
if START:
    args = ["-ss", str(START)] + args
run(args + ["-filter_complex", fc, "-map", "[out]",
            "-c:v", "libx264", "-preset", "medium", "-crf", "16",
            "-pix_fmt", "yuv420p", "-an", "-shortest", OUT])
mb = os.path.getsize(OUT) / 1048576
print(f"  wrote {OUT}  {mb:.1f} MB")
