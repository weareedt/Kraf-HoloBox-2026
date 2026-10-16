#!/usr/bin/env python
"""
Refine Johnny's parang stills: grade them, lift the backdrop to white, and remove the
wooden stand the parang was photographed on.

Sixteen Sony ARW raws, same extraction trick as tools/refine-stills.py -- ffmpeg cannot
decode ARW, but each file carries a full-resolution 7008x4672 embedded JPEG.

TWO SEPARATE PROBLEMS, and conflating them destroys the pictures:

  1. THE BACKDROP is neutral and bright; everything that matters is either dark (steel,
     rosewood) or saturated (rattan). A neutral-and-bright key removes it cleanly on all
     sixteen. Verified by rendering the mask over the images, not assumed.

  2. THE STAND is pale wood. On the blade close-ups it is separable by colour, because
     steel is neutral and wood is warm. ON THE SHEATH CLOSE-UPS IT IS NOT: the sheath is
     rosewood and the binding is rattan, so a warm key selects THE ENTIRE PARANG. That was
     measured -- the whole object lights up in the mask overlay.

So the stand is found by CONNECTIVITY instead of by colour alone. The stand touches the
frame border; the rattan binding in the middle of the sheath does not. A flood fill from
the border, allowed to travel only through backdrop and pale wood, reaches the stand and
stops at the dark rosewood -- even where the parang runs off the edge of the frame, because
it exits dark.

That connected region is then used only as a RESTRICTION on a full-resolution warm key, not
as the matte itself. The region is computed at low resolution and is therefore soft; the
key inside it is computed per pixel and is therefore sharp where the blade crosses the wood.

Usage: refine-parang.py <arw-folder> <out-folder> <tmp> [--white N] [--luma N]
"""
import os
import subprocess
import sys
from collections import deque

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ffmpeg_path import ffmpeg, ffprobe
BIN = ffmpeg()

ARW, OUT, TMP = sys.argv[1:4]
SRC = os.path.join(TMP, "parang-previews")
REG = os.path.join(TMP, "parang-regions")


def arg(flag, default):
    return type(default)(sys.argv[sys.argv.index(flag) + 1]) if flag in sys.argv else default


WHITE = arg("--white", 255)       # what the backdrop becomes
TARGET_LUMA = arg("--luma", 112)  # subject midtone after grading

# backdrop key: background = neutral AND bright
S0, S1 = 10, 22                   # saturation ramp; above S1 it is subject
V0, V1 = 118, 150                 # luma ramp; below V0 it is subject
# stand key, applied only inside the connected region
W0, W1 = 8, 22                    # (R-B) ramp
# What the flood fill may travel through. Measured: the stand reads luma 116-136 with
# R-B ~27, the rosewood sheath luma 30-60, the backdrop R-B ~0. PALE_V sits between the
# stand and the rosewood; PALE_W sits between the stand and the backdrop.
# PALE_V was 90 and leaked: the sheath's rim-lit upper edge passed, so wherever the parang
# ran off the frame the fill entered there and spread along the rattan. At 110 the three
# images with a real board measure 19-23% and everything else falls below 2.1%.
PALE_W, PALE_V = 12, 110
MIN_STAND = 0.05        # for a WARM-WOOD subject, where a false positive paints out parang
# Was briefly lowered to 0.003 for steel subjects, to try to catch the narrow upright post
# behind the parang. It caught the post AND bit notches out of the rattan hilt wraps, which
# is a worse picture than a post in the background. The post cannot be removed by colour or
# by crop -- it sits mid-frame directly behind the hilt, which is the same wood -- so it
# stays until someone supplies a hand-painted mask.
MIN_STAND_STEEL = MIN_STAND
DILATE = 2
STEEL_SAT = 0.25   # below this the subject is steel and a warm key can separate it                 # below this the "stand" is noise, not a stand

AW, AH = 960, 640                 # analysis/region resolution
FULL_W, FULL_H = 7008, 4672

SOI = bytes([0xFF, 0xD8, 0xFF])
EOI = bytes([0xFF, 0xD9])


def run(args):
    r = subprocess.run([BIN, "-v", "error", "-y"] + args, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-900:])


def extract_previews():
    os.makedirs(SRC, exist_ok=True)
    n = 0
    for f in sorted(os.listdir(ARW)):
        if not f.lower().endswith(".arw"):
            continue
        dst = os.path.join(SRC, os.path.splitext(f)[0] + ".jpg")
        if os.path.exists(dst):
            n += 1
            continue
        d = open(os.path.join(ARW, f), "rb").read()
        best, i = None, 0
        while True:
            i = d.find(SOI, i)
            if i < 0:
                break
            j = d.find(EOI, i)
            if j > 0 and (best is None or j - i > len(best)):
                best = d[i:j + 2]
            i += 3
        if best:
            open(dst, "wb").write(best)
            n += 1
    print(f"  {n} previews ready")


def sample(path, vf="null", w=AW, h=AH):
    raw = os.path.join(TMP, "pr.rgb")
    run(["-i", path, "-vf", f"{vf},scale={w}:{h}:flags=area",
         "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", raw])
    return open(raw, "rb").read()


def pct(v, p):
    v = sorted(v)
    return v[int(p * (len(v) - 1))] if v else 0


def png_gray(path, buf, w, h):
    """Minimal 8-bit greyscale PNG writer -- no imaging library is installed."""
    import struct
    import zlib
    raw = b"".join(b"\x00" + bytes(buf[y * w:(y + 1) * w]) for y in range(h))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    open(path, "wb").write(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b""))


def stand_region(d):
    """
    Border-connected PALE WARM WOOD. Returns (mask, coverage) at AWxAH.

    The fill travels through pale warm wood ONLY -- not through backdrop, and not through
    dark wood. Both exclusions are load-bearing, and the first one was learned the hard way:

      - Travelling through BACKDROP reaches everything, because everything touches the
        backdrop. The first version did this and ate the rattan binding, punching white
        holes straight through the parang.
      - Travelling through DARK wood would run the length of the rosewood sheath, which
        leaves the frame in most close-ups and would therefore drag in the whole object.

    What survives the two rules is exactly the stand: pale, warm, and running off the edge
    of the frame. The rattan binding is pale and warm too, but it is landlocked in dark
    rosewood and never touches the border, so the fill cannot reach it.
    """
    passable = bytearray(AW * AH)
    warm = bytearray(AW * AH)
    for y in range(AH):
        for x in range(AW):
            i = (y * AW + x) * 3
            r, g, b = d[i], d[i + 1], d[i + 2]
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            sat = max(r, g, b) - min(r, g, b)
            w = int(r) - int(b)
            k = y * AW + x
            if w > W0 and sat > S0:
                warm[k] = 1
            # pale warm wood only
            if w > PALE_W and sat > S0 and lum > PALE_V:
                passable[k] = 1

    seen = bytearray(AW * AH)
    q = deque()
    for x in range(AW):
        for y in (0, AH - 1):
            k = y * AW + x
            if passable[k] and not seen[k]:
                seen[k] = 1
                q.append(k)
    for y in range(AH):
        for x in (0, AW - 1):
            k = y * AW + x
            if passable[k] and not seen[k]:
                seen[k] = 1
                q.append(k)
    while q:
        k = q.popleft()
        x, y = k % AW, k // AW
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < AW and 0 <= ny < AH:
                nk = ny * AW + nx
                if passable[nk] and not seen[nk]:
                    seen[nk] = 1
                    q.append(nk)

    reg = bytearray(AW * AH)
    n = 0
    for k in range(AW * AH):
        if seen[k] and warm[k]:
            reg[k] = 1
            n += 1

    # Dilate only slightly here. Where the region is used as the matte ITSELF (the warm
    # subject case) dilation eats into the parang rather than costing nothing. Two steps at
    # this resolution is ~15px at 7008 wide: enough to cover the stand's defocused edge
    # that the fill under-reaches, little enough not to show.
    return dilate(bytearray(255 if v else 0 for v in reg), DILATE), n / (AW * AH)


def dilate(mask, steps):
    for _ in range(steps):
        nxt = bytearray(mask)
        for y in range(AH):
            row = y * AW
            for x in range(AW):
                if mask[row + x]:
                    continue
                if ((x and mask[row + x - 1]) or (x < AW - 1 and mask[row + x + 1])
                        or (y and mask[row - AW + x]) or (y < AH - 1 and mask[row + AW + x])):
                    nxt[row + x] = 255
        mask = nxt
    return mask


def subject_stats(d, w=AW, h=AH):
    sub = []
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            i = (y * w + x) * 3
            r, g, b = d[i], d[i + 1], d[i + 2]
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            sat = max(r, g, b) - min(r, g, b)
            if sat > S1 or lum < V0:
                sub.append((lum, sat))
    if not sub:
        return 0, 0
    return pct([s[0] for s in sub], 0.5), pct([s[1] for s in sub], 0.5)


def ramp_up(a, b):
    return f"lut=c0='if(lte(val,{a}),0,if(gte(val,{b}),255,255*(val-{a})/({b}-{a})))'"


def ramp_down(a, b):
    return f"lut=c0='if(gte(val,{b}),0,if(lte(val,{a}),255,255*({b}-val)/({b}-{a})))'"


def relative_sat(d, reg):
    """
    Median (max-min)/max over the subject, outside the stand region.

    ABSOLUTE saturation is useless for this: it is not brightness-invariant, so dark
    rosewood reads max-min 10 and looks as neutral as steel. The ratio separates them --
    steel 0.05, rosewood 0.27-0.57 -- which is what decides whether a warm key can tell
    the subject from the stand.
    """
    vals = []
    for y in range(0, AH, 2):
        for x in range(0, AW, 2):
            k = y * AW + x
            if reg[k]:
                continue
            i = k * 3
            r, g, b = d[i], d[i + 1], d[i + 2]
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            mx, mn = max(r, g, b), min(r, g, b)
            if (mx - mn) > S1 or lum < V0:
                if mx > 8:
                    vals.append((mx - mn) / mx)
    return pct(vals, 0.5) if vals else 0.0


def build_filter(gamma, sat, use_region, steel):
    g = (f"[0:v]eq=gamma={gamma:.4f}:saturation={sat:.4f},format=rgb24,"
         "split=4[img][s_src][l_src][w_src];"
         # saturation = max(r,g,b) - min(r,g,b)
         "[s_src]format=gbrp,split=2[sa][sb];"
         "[sa]extractplanes=r+g+b[ra][ga][ba];"
         "[ra][ga]blend=all_mode=lighten[t1];"
         "[t1][ba]blend=all_mode=lighten[MX];"
         "[sb]extractplanes=r+g+b[rb][gb][bb];"
         "[rb][gb]blend=all_mode=darken[t2];"
         "[t2][bb]blend=all_mode=darken[MN];"
         "[MX][MN]blend=all_mode=subtract[SAT];"
         "[l_src]format=gray,split=2[LUM][LUM2];"
         # backdrop = neutral AND bright
         f"[SAT]{ramp_down(S0, S1)}[mneutral];"
         f"[LUM]{ramp_up(V0, V1)}[mbright];"
         "[mneutral][mbright]blend=all_mode=darken[MBG];")

    if use_region and steel:
        # Steel is neutral, so a per-pixel WARM key separates it from the stand at full
        # resolution -- sharp where the blade crosses the wood, and reaching the stand's
        # shadowed parts that the pale-wood fill cannot.
        #
        # THE REGION RESTRICTION IS NOT OPTIONAL, even though the subject is "steel". These
        # frames are close-ups: a blade shot still contains the rosewood hilt and its rattan
        # wrap, and _BS21137 is the whole sheathed parang. Letting the warm key run over the
        # entire frame stripped all of that to white and left the pictures grey and flat.
        # "Steel" describes what crosses the STAND, not everything in the picture.
        g += ("[w_src]format=gbrp,extractplanes=r+b[rw][bw];"
              "[rw][bw]blend=all_mode=subtract[WARM];"
              f"[WARM]{ramp_up(W0, W1)}[mwarm];[LUM2]nullsink;"
              f"[1:v]scale={FULL_W}:{FULL_H},format=gray[REGION];"
              "[mwarm][REGION]blend=all_mode=darken[MBASE];"
              "[MBG][MBASE]blend=all_mode=lighten[MALL];")
    elif use_region:
        # The subject is warm wood -- rosewood sheath and rattan, the SAME material as the
        # stand. No colour key can separate them, so the connected region is the whole
        # matte. It stops exactly at the parang but misses the stand's darker, shadowed
        # parts, so removal here is PARTIAL and the run says so.
        g += ("[w_src]nullsink;[LUM2]nullsink;"
              f"[1:v]scale={FULL_W}:{FULL_H},format=gray[MBASE];"
              "[MBG][MBASE]blend=all_mode=lighten[MALL];")
    else:
        g += "[w_src]nullsink;[LUM2]nullsink;[MBG]copy[MALL];"

    g += ("[MALL]gblur=sigma=1.6[ALPHA];"
          f"color=c=0x{WHITE:02X}{WHITE:02X}{WHITE:02X}:s={FULL_W}x{FULL_H}[WHT];"
          "[WHT][ALPHA]alphamerge[wf];"
          "[img][wf]overlay=format=auto,format=rgb24[out]")
    return g


extract_previews()
os.makedirs(OUT, exist_ok=True)
os.makedirs(REG, exist_ok=True)

rows = []
for name in sorted(os.listdir(SRC)):
    if not name.lower().endswith(".jpg"):
        continue
    src = os.path.join(SRC, name)
    stem = os.path.splitext(name)[0]

    d0 = sample(src)
    luma0, sat0 = subject_stats(d0)

    gamma = 1.0
    if 5 < luma0 < 250:
        import math
        gamma = math.log(luma0 / 255.0) / math.log(TARGET_LUMA / 255.0)
        gamma = max(0.45, min(2.5, gamma))

    reg, cov = stand_region(d0)
    steel_subject = relative_sat(d0, reg) < STEEL_SAT
    use_region = cov > (MIN_STAND_STEEL if steel_subject else MIN_STAND)
    # Dilate further for the steel case: there the region only RESTRICTS a per-pixel key,
    # so reaching past the stand's edge costs nothing and catches its soft shadow.
    steel = steel_subject
    if steel:
        reg = dilate(reg, 5)
    regpath = os.path.join(REG, stem + ".png")
    if use_region:
        png_gray(regpath, reg, AW, AH)

    # BOTH branches consume the region image: the steel branch restricts its warm key to it,
    # the warm-subject branch uses it as the matte outright. This once read
    # `use_region and not steel`, left over from a version where the steel key ran over the
    # whole frame -- so steel images were handed no region, fell through to the do-nothing
    # branch, and the run still cheerfully reported "warm key (steel)".
    args = ["-i", src] + (["-i", regpath] if use_region else [])
    fc = build_filter(gamma, 1.0, use_region, steel)
    dst = os.path.join(OUT, stem + ".png")
    run(args + ["-filter_complex", fc, "-map", "[out]", "-frames:v", "1",
                "-compression_level", "6", dst])

    d2 = sample(dst)
    luma2, sat2 = subject_stats(d2)
    mb = os.path.getsize(dst) / 1048576
    rows.append((stem, cov, mb, steel))
    tag = ("nothing removed  " if not use_region
           else f"warm key {100*cov:4.1f}%" if steel else f"region {100*cov:4.1f}% PART")
    print(f"  {stem:<12} gamma {gamma:.2f}  {tag}   luma {luma0:3.0f}->{luma2:3.0f}"
          f" (target {TARGET_LUMA})   {mb:5.1f} MB")

print(f"\n  {len(rows)} images -> {OUT}   total {sum(r[2] for r in rows):.0f} MB")
full = [r[0] for r in rows if r[3]]
part = [r[0] for r in rows if not r[3] and r[1] > MIN_STAND]
print(f"  warm key applied (steel subject): {', '.join(full) or 'none'}")
if part:
    print(f"  stand PARTLY removed (subject is the same wood as the stand): {', '.join(part)}")
