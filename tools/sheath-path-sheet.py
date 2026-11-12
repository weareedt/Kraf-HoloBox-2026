"""Usage: python tools/sheath-path-sheet.py content/artists sheath_fit.json out.png [hideFromY soft]
Contact sheet: the bare blade with the sheath over it at several travels, straight
slide (top row) vs the fitted path (bottom row). Same compositing as the app: backdrop, then
the blade-hide cover (if hideFromY is given: backdrop colour from that sheath row down, soft
top edge, moving with the sheath), then the sheath, both through the screen-fixed mask.
Prints how many blade pixels still show below the mouth line at each travel.
"""
import sys
import json
import numpy as np
import cv2

ROOT, FIT, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
HIDE = float(sys.argv[4]) if len(sys.argv) > 4 else None
SOFT = float(sys.argv[5]) if len(sys.argv) > 5 else 20
sh = cv2.imread(f'{ROOT}/johnny/products/full-parang/sheath.png', cv2.IMREAD_UNCHANGED)
mk = cv2.imread(f'{ROOT}/johnny/products/full-parang/sheath-mask.png', cv2.IMREAD_UNCHANGED)
bare = cv2.imread(f'{ROOT}/johnny/products/parang-only/frames/frame-00.webp')
H, W = sh.shape[:2]
r = 1.0106 / 0.95
M = np.float32([[r, 0, 540 - 649.46 * r], [0, r, 1024 - 1090.8 * r]])
base = cv2.warpAffine(bare, M, (W, H), borderValue=(239, 239, 239)).astype(np.float32)
bladem = (np.abs(base - 239).max(axis=2) > 18)
fit = json.load(open(FIT))
keys = fit if isinstance(fit[0], list) and len(fit[0]) == 3 else [(d, th, dx) for d, th, dx, *_ in fit]
kd = [k[0] for k in keys]
mx0, mouth = 507.5, 613
ma = mk[..., 3:4].astype(np.float32) / 255
rows = np.arange(H, dtype=np.float32)[:, None, None]
cover_local = None
if HIDE is not None:
    cover_local = np.clip((rows - HIDE) / SOFT, 0, 1) * np.ones((H, W, 1), np.float32)
below_local = (rows[..., 0] > mouth + 2) * np.ones((H, W), np.float32)


def comp(theta, dx, d):
    A = cv2.getRotationMatrix2D((mx0, mouth), -theta, 1.0)
    A[0, 2] += dx
    A[1, 2] += d
    out = base.copy()
    if cover_local is not None:
        c = cv2.warpAffine(cover_local, A, (W, H))[..., None] * ma
        out = out * (1 - c) + 239 * c
    s = cv2.warpAffine(sh, A, (W, H)).astype(np.float32)
    a = s[..., 3:4] / 255 * ma
    out = out * (1 - a) + s[..., :3] * a
    # blade still showing below the mouth line: blade pixel, below, and the result is not
    # within 12 levels of what covers it (sheath or backdrop)
    below = cv2.warpAffine(below_local, A, (W, H)) > 0.5
    showing = bladem & below & (np.abs(out - base).max(axis=2) < 12) & (np.abs(base - 239).max(axis=2) > 18)
    return out.astype(np.uint8), int(showing.sum())


ds = [0, 120, 240, 360, 480, 600, 720, 840]
sheet = []
for mode in ('straight', 'fit'):
    tiles = []
    for d in ds:
        th = float(np.interp(d, kd, [k[1] for k in keys])) if mode == 'fit' else 0
        dx = float(np.interp(d, kd, [k[2] for k in keys])) if mode == 'fit' else 0
        img, n = comp(th, dx, d)
        print(f'{mode:8s} d {d:4d}: blade showing below the mouth {n:6d} px')
        img = cv2.resize(img[200:1850, 360:700], None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
        cv2.putText(img, f'{d}', (6, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 200), 2)
        tiles.append(img)
    sheet.append(np.hstack(tiles))
cv2.imwrite(OUT, np.vstack(sheet))
