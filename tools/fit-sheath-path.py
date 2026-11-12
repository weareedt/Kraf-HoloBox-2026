"""Usage: python tools/fit-sheath-path.py content/artists   (writes sheath_fit.json here)
Per-step best pose of the sheath while it is drawn off the blade.

Frame pixels of the sheathed turntable (1080x2048). At each travel d (the mouth centre's
drop), the sheath is rotated by theta about its mouth centre and shifted (dx, d). Ugly =
blade pixels below the moved mouth line, not covered by sheath alpha x screen-fixed mask.
"""
import sys
import json
import numpy as np
import cv2

ROOT = sys.argv[1]
S = 2
sh = cv2.imread(f'{ROOT}/johnny/products/full-parang/sheath.png', cv2.IMREAD_UNCHANGED)
mk = cv2.imread(f'{ROOT}/johnny/products/full-parang/sheath-mask.png', cv2.IMREAD_UNCHANGED)
bare = cv2.imread(f'{ROOT}/johnny/products/parang-only/frames/frame-00.webp')
H, W = sh.shape[:2]
diff = np.abs(bare.astype(int) - 239).max(axis=2)
blade = (diff > 18).astype(np.uint8)
r = 1.0106 / 0.95
M = np.float32([[r, 0, 540 - 649.46 * r], [0, r, 1024 - 1090.8 * r]])
blade = cv2.warpAffine(blade, M, (W, H), flags=cv2.INTER_NEAREST)

sa = sh[..., 3].astype(np.float32) / 255
ma = mk[..., 3].astype(np.float32) / 255
ys, xs = np.nonzero(sa > 0.5)
mouth = int(ys.min())
mrow = xs[ys <= mouth + 3]
mx0 = float(mrow.min() + mrow.max()) / 2
print('mouth centre', mx0, mouth)

w, h = W // S, H // S
sa_s = cv2.resize(sa, (w, h), interpolation=cv2.INTER_AREA)
ma_s = cv2.resize(ma, (w, h), interpolation=cv2.INTER_AREA)
bl_s = cv2.resize(blade.astype(np.float32), (w, h), interpolation=cv2.INTER_AREA) > 0.5
below = np.zeros((h, w), np.uint8)
below[mouth // S + 1:, :] = 1


def pose(theta, dx, d):
    """sheath-local -> screen at /S: rotate theta (deg, screen clockwise) about the mouth
    centre, then shift by (dx, d)."""
    A = cv2.getRotationMatrix2D((mx0 / S, mouth / S), -theta, 1.0)
    A[0, 2] += dx / S
    A[1, 2] += d / S
    return A.astype(np.float32)


def ugly(A):
    cov = cv2.warpAffine(sa_s, A, (w, h)) * ma_s
    inside = cv2.warpAffine(below, A, (w, h)) > 0
    return int((bl_s & inside & (cov < 0.5)).sum()) * S * S


tip = int(np.nonzero(blade)[0].max())
out = []
prev = (0.0, 0.0)
for d in range(0, tip - mouth + 60, 40):
    best = None
    for th in np.arange(-6, 6.01, 0.5):
        for dx in range(-40, 41, 4):
            u = ugly(pose(th, dx, d))
            # small preference for staying near the previous pose (smooth) and for zero
            score = u + 6 * abs(th - prev[0]) + 0.5 * abs(dx - prev[1]) + 2 * abs(th)
            if best is None or score < best[0]:
                best = (score, u, th, dx)
    straight = ugly(pose(0, 0, d))
    prev = (best[2], best[3])
    out.append((d, best[2], best[3], best[1], straight))
    print(f'd {d:4d}: theta {best[2]:+5.1f}  dx {best[3]:+4d}  ugly {best[1]:6d}  (straight {straight:6d})')
json.dump(out, open('sheath_fit.json', 'w'))
