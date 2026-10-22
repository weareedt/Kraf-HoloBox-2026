#!/usr/bin/env python
"""
Build a backdrop plate for a clip that never shows an empty frame.

tools/transcode.mjs lifts Maznah's grey backdrop to white with a difference matte, and
that needs a PLATE: a picture of the backdrop with nobody in front of it. Her walk and
dance give one for free, because both open on several seconds of empty studio. Her
profile and product talks never do — she is seated in frame from the first frame to the
last, and the only non-occupied frames are dip-to-white transitions between takes.

So the plate is reconstructed instead of captured. The backdrop is a studio cyclorama lit
by a couple of soft sources: a smooth, low-frequency falloff with no detail in it. That
is exactly the kind of field a low-order 2-D polynomial describes well, so:

  1. mask out everything that is obviously NOT clean backdrop — saturated (her costume,
     her skin) or dark (her hair, her shorts, the stool)
  2. fit a degree-4 polynomial per channel to what is left
  3. mark pixels sitting well BELOW that fit as her cast shadow, add them to the mask,
     and refit — otherwise the shadow is baked into the plate, the matte then sees no
     difference there, and the lift erases the shadow it is supposed to preserve
  4. evaluate the fit over the whole frame and upscale

The fit residual on the unmasked pixels is printed; if it is not small, the backdrop is
not polynomial and this approach should not be trusted.

Usage: make-plate.py <clip> <out.png> [sample-seconds...] [--degree N]

--degree (default 4) is the polynomial order. Bangie's cyclorama has a stronger vignette than
Maznah's: at degree 4 her refined backdrop still spread 26 levels (the top-left corner landed
on 218); degree 6 brought it to 13 and the fit residual from 2.5 to 1.5 levels, with no seams,
because the error stays a smooth gradient.
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ffmpeg_path import ffmpeg, ffprobe
BIN = ffmpeg()

CLIP = sys.argv[1]
OUT = sys.argv[2]
ARGS = sys.argv[3:]
DEGREE = 4
if "--degree" in ARGS:
    k = ARGS.index("--degree")
    DEGREE = int(ARGS[k + 1])
    del ARGS[k:k + 2]
TIMES = ARGS or ["20", "60", "100"]

W, H = 270, 480          # the falloff is low-frequency; this is ample
FULL_W, FULL_H = 2160, 3840
DEG = DEGREE             # polynomial degree per axis-sum (4 unless --degree)


def frame(t):
    raw = OUT + f".{t}.rgb"
    subprocess.run([BIN, "-v", "error", "-y", "-ss", str(t), "-i", CLIP,
                    "-vf", f"scale={W}:{H}:flags=area", "-frames:v", "1",
                    "-pix_fmt", "rgb24", "-f", "rawvideo", raw], check=True)
    d = open(raw, "rb").read()
    os.remove(raw)
    return d


# Average the sample frames: cheap noise reduction, and nothing moves in the backdrop.
frames = [frame(t) for t in TIMES]
img = [sum(f[i] for f in frames) // len(frames) for i in range(W * H * 3)]


def at(x, y):
    i = (y * W + x) * 3
    return img[i], img[i + 1], img[i + 2]


terms = [(i, j) for i in range(DEG + 1) for j in range(DEG + 1) if i + j <= DEG]


def basis(x, y):
    u = x / (W - 1.0) - 0.5
    v = y / (H - 1.0) - 0.5
    return [(u ** i) * (v ** j) for i, j in terms]


def solve(A, b):
    """Gaussian elimination with partial pivoting; A is n x n, b is n."""
    n = len(b)
    M = [row[:] + [b[k]] for k, row in enumerate(A)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(M[r][c]))
        M[c], M[p] = M[p], M[c]
        if abs(M[c][c]) < 1e-12:
            continue
        for r in range(n):
            if r == c:
                continue
            f = M[r][c] / M[c][c]
            for k in range(c, n + 1):
                M[r][k] -= f * M[c][k]
    return [M[i][n] / M[i][i] if abs(M[i][i]) > 1e-12 else 0.0 for i in range(n)]


def fit(mask, ch):
    n = len(terms)
    A = [[0.0] * n for _ in range(n)]
    b = [0.0] * n
    for y in range(0, H, 2):
        for x in range(0, W, 2):
            if mask[y * W + x]:
                continue
            g = basis(x, y)
            val = at(x, y)[ch]
            for i in range(n):
                b[i] += g[i] * val
                gi = g[i]
                for j in range(n):
                    A[i][j] += gi * g[j]
    return solve(A, b)


# --- pass 1: mask her by colour and darkness ------------------------------------
mask = bytearray(W * H)
for y in range(H):
    for x in range(W):
        r, g, bl = at(x, y)
        if (max(r, g, bl) - min(r, g, bl)) > 20 or (0.299 * r + 0.587 * g + 0.114 * bl) < 140:
            mask[y * W + x] = 1

# dilate, so her soft edge does not drag the fit down
for _ in range(3):
    nm = bytearray(mask)
    for y in range(1, H - 1):
        for x in range(1, W - 1):
            if mask[y * W + x]:
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        nm[(y + dy) * W + x + dx] = 1
    mask = nm
print(f"  masked by colour/darkness : {100*sum(mask)/len(mask):.1f}% of the frame")

# --- pass 2+3: add the cast shadow, then refit ----------------------------------
for it in range(3):
    coef = [fit(mask, c) for c in range(3)]
    added = 0
    for y in range(H):
        for x in range(W):
            if mask[y * W + x]:
                continue
            g = basis(x, y)
            px = at(x, y)
            # below the fitted field on every channel = shadow, not noise
            if all(sum(c * t for c, t in zip(coef[ch], g)) - px[ch] > 5 for ch in range(3)):
                mask[y * W + x] = 1
                added += 1
    if it == 0 or added:
        print(f"  pass {it+1}: +{added} shadow pixels -> {100*sum(mask)/len(mask):.1f}% masked")
    if not added:
        break

# residual on what we kept, which is the honest check on the whole idea
res = []
for y in range(0, H, 2):
    for x in range(0, W, 2):
        if mask[y * W + x]:
            continue
        g = basis(x, y)
        px = at(x, y)
        for ch in range(3):
            res.append(abs(sum(c * t for c, t in zip(coef[ch], g)) - px[ch]))
res.sort()
print(f"  fit residual on clean backdrop: median {res[len(res)//2]:.2f}  p95 {res[int(.95*len(res))]:.2f} levels")

# --- evaluate and write ---------------------------------------------------------
out = bytearray(W * H * 3)
for y in range(H):
    for x in range(W):
        g = basis(x, y)
        for ch in range(3):
            v = sum(c * t for c, t in zip(coef[ch], g))
            out[(y * W + x) * 3 + ch] = max(0, min(255, int(round(v))))
tmp = OUT + ".small.rgb"
open(tmp, "wb").write(bytes(out))
subprocess.run([BIN, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
                "-s", f"{W}x{H}", "-i", tmp,
                "-vf", f"scale={FULL_W}:{FULL_H}:flags=bicubic", "-frames:v", "1", OUT], check=True)
os.remove(tmp)
print(f"  wrote {OUT}  ({FULL_W}x{FULL_H})")
