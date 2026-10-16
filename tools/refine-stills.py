#!/usr/bin/env python
"""
Refine Maznah's Bakul stills: crop the studio floor, match them to the product
turntable's grade, and put them on clean white.

The stills are Sony ARW raws. ffmpeg cannot decode ARW, but each file carries a
FULL-RESOLUTION (7008x4672) embedded JPEG, which is the camera's own rendering --
better behaved than a raw development we would have to guess the parameters for.

Three measured corrections, in this order:

  1. CROP THE FLOOR. Six of the nine frames have a wooden floor band down the left
     edge. It is saturated, so a background key keeps it -- it has to go first.
     It is found by column coverage: a floor column is "not backdrop" down almost
     its whole height, while a column through the subject is not.

  2. MATCH THE GRADE. The stills measure darker and flatter than the turntable
     frames they have to sit beside (subject luma p50 57 vs 81, saturation 29 vs 42).
     Gamma and saturation are solved PER IMAGE from its own measurements, because
     the nine frames differ from each other by as much as they differ from the target.

  3. BACKDROP TO WHITE. The backdrop is neutral (saturation 2-4) and the dyed strips
     are not, so a saturation key works, with a brightness term to hold the dark
     parts of the weave. Same shape as the one used for the turntable video.
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ffmpeg_path import ffmpeg, ffprobe
BIN = ffmpeg()

ARW = sys.argv[1]          # folder of Sony .ARW stills
OUT = sys.argv[2]          # folder for the refined PNGs
TMP = sys.argv[3]          # scratch
SRC = os.path.join(TMP, "arw-previews")


SOI = bytes([0xFF, 0xD8, 0xFF])
EOI = bytes([0xFF, 0xD9])


def extract_previews():
    """Pull the full-resolution JPEG each ARW carries, by scanning for SOI/EOI."""
    os.makedirs(SRC, exist_ok=True)
    n = 0
    for f in sorted(os.listdir(ARW)):
        if not f.lower().endswith(".arw"):
            continue
        d = open(os.path.join(ARW, f), "rb").read()
        best, i = None, 0
        while True:
            i = d.find(SOI, i)
            if i < 0:
                break
            j = d.find(EOI, i)
            if j > 0:
                seg = d[i:j + 2]
                if best is None or len(seg) > len(best):
                    best = seg
            i += 3
        if best:
            open(os.path.join(SRC, os.path.splitext(f)[0] + ".jpg"), "wb").write(best)
            n += 1
    print(f"  extracted {n} full-resolution previews")

TARGET_LUMA = 81           # measured on product rotate/pngseq/Bakul000.png
TARGET_SAT = 42

# backdrop key: subject = saturated OR dark
S0, S1 = 12, 26
V0, V1 = 90, 125
WHITE = 255

AW, AH = 480, 320          # analysis resolution


def run(args):
    r = subprocess.run([BIN, "-v", "error", "-y"] + args, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-800:])


def sample(path, vf):
    raw = os.path.join(TMP, "an.rgb")
    run(["-i", path, "-vf", f"{vf},scale={AW}:{AH}:flags=area",
         "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", raw])
    return open(raw, "rb").read()


def px(d, x, y):
    i = (y * AW + x) * 3
    return d[i], d[i + 1], d[i + 2]


def is_subject(r, g, b):
    return (max(r, g, b) - min(r, g, b)) > 14 or (0.299 * r + 0.587 * g + 0.114 * b) < 110


def pct(v, p):
    v = sorted(v)
    return v[int(p * (len(v) - 1))] if v else 0


def floor_band(d):
    """Columns at the edges that are 'not backdrop' down almost their whole height."""
    cov = [sum(1 for y in range(AH) if is_subject(*px(d, x, y))) / AH for x in range(AW)]
    L = 0
    while L < AW and cov[L] > 0.80:
        L += 1
    R = AW - 1
    while R > 0 and cov[R] > 0.80:
        R -= 1
    return L, AW - 1 - R          # columns to drop, left and right


def subject_stats(d, x0=0, x1=AW):
    sub = [px(d, x, y) for y in range(0, AH, 2) for x in range(x0, x1, 2)
           if is_subject(*px(d, x, y))]
    if not sub:
        return 0, 0
    luma = [int(0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]) for p in sub]
    sat = [max(p) - min(p) for p in sub]
    return pct(luma, 0.5), pct(sat, 0.5)


def key_filter(gamma, sat):
    """Grade, then composite the neutral backdrop to white."""
    def up(a, b):
        return f"lut=c0='if(lte(val,{a}),0,if(gte(val,{b}),255,255*(val-{a})/({b}-{a})))'"

    def down(a, b):
        return f"lut=c0='if(gte(val,{b}),0,if(lte(val,{a}),255,255*({b}-val)/({b}-{a})))'"

    return (
        f"[0:v]crop=iw-{{dropL}}-{{dropR}}:ih:{{dropL}}:0,"
        f"eq=gamma={gamma:.4f}:saturation={sat:.4f},format=gbrp,split=3[base][white][m];"
        "[m]split=2[ma][mb];"
        "[ma]extractplanes=r+g+b[r1][g1][b1];"
        "[r1][g1]blend=all_mode=lighten[x1];"
        "[x1][b1]blend=all_mode=lighten,split=2[MXa][MXb];"
        "[mb]extractplanes=r+g+b[r2][g2][b2];"
        "[r2][g2]blend=all_mode=darken[x2];"
        "[x2][b2]blend=all_mode=darken[MN];"
        f"[MXa][MN]blend=all_mode=subtract,{up(S0, S1)}[mSat];"
        f"[MXb]{down(V0, V1)}[mDark];"
        "[mSat][mDark]blend=all_mode=lighten,gblur=sigma=1.0,negate[Mbg];"
        f"[white]lut=r={WHITE}:g={WHITE}:b={WHITE}[W];"
        "[W][Mbg]alphamerge[wf];"
        "[base][wf]overlay=format=auto,format=rgb24[out]"
    )


extract_previews()
os.makedirs(OUT, exist_ok=True)
report = []
for name in sorted(os.listdir(SRC)):
    if not name.lower().endswith(".jpg"):
        continue
    src = os.path.join(SRC, name)
    stem = os.path.splitext(name)[0]

    d0 = sample(src, "null")
    dl, dr = floor_band(d0)
    cropL = round(dl / AW * 7008)
    cropR = round(dr / AW * 7008)
    # The floor's edge is slightly defocused, so column coverage falls below the
    # threshold while a 3-9px sliver of it is still there. Measured, then over-cropped
    # by 1% of the width, which costs nothing on a 7008px frame.
    if cropL:
        cropL += round(0.01 * 7008)
    if cropR:
        cropR += round(0.01 * 7008)
    crop = f"crop=iw-{cropL}-{cropR}:ih:{cropL}:0"

    # measure the subject INSIDE the crop, so the floor cannot skew the grade
    luma, _ = subject_stats(d0, dl, AW - dr)
    gamma = 1.0
    if 5 < luma < 250:
        import math
        gamma = math.log(luma / 255.0) / math.log(TARGET_LUMA / 255.0)
        gamma = max(0.5, min(2.5, gamma))

    # saturation is measured AFTER the gamma, because gamma changes it too
    d1 = sample(src, f"{crop},eq=gamma={gamma:.4f}")
    _, sat1 = subject_stats(d1)
    satmul = max(0.5, min(2.5, TARGET_SAT / sat1)) if sat1 else 1.0

    fc = key_filter(gamma, satmul).replace("{dropL}", str(cropL)).replace("{dropR}", str(cropR))
    dst = os.path.join(OUT, stem + ".png")
    run(["-i", src, "-filter_complex", fc, "-map", "[out]", "-frames:v", "1", dst])

    d2 = sample(dst, "null")
    luma2, sat2 = subject_stats(d2)
    mb = os.path.getsize(dst) / 1048576
    report.append((stem, cropL, gamma, satmul, luma, luma2, sat1, sat2, mb))
    print(f"  {stem}  floor {cropL:4d}px  gamma {gamma:.2f}  sat x{satmul:.2f}"
          f"   luma {luma}->{luma2} (target {TARGET_LUMA})"
          f"   sat {sat1}->{sat2} (target {TARGET_SAT})   {mb:.1f} MB")

print(f"\n  {len(report)} images written to {OUT}")
print(f"  total {sum(r[8] for r in report):.0f} MB")
