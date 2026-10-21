#!/usr/bin/env python
"""
Replace the backdrop of every frame in a turntable folder with one flat colour. The
frames stay OPAQUE: the backdrop is repainted, never made transparent.

Built for Johnny's parang turns, which were photographed on a mottled backdrop: a greyish
photo rectangle with swirl marks, laid on a painted near-white surround, so on the product
panel the parang sat inside a visible box. The brief was to make that backdrop match the
panel's (#EFEFEF) WITHOUT eating into the parang, and to leave the delivered PNGs alone.
So this reads the drop folder and writes new frames elsewhere.

The parang is protected first and the backdrop painted second -- never the other way round:

  1. SEED: pixels that are certainly parang -- darker than STRONG_LUMA, or coloured (chroma
     above STRONG_CHROMA, which is what catches the pale rattan binding).
  2. GROW from the seeds into 8-connected neighbours that are still distinctly not backdrop
     (darker than WEAK_LUMA, or chroma above WEAK_CHROMA). Growing only from seeds means a
     grey speck in the backdrop can never become "parang".
  2b. CLOSE the mask by CLOSE_RADIUS, so the light pierced filigree on the blade's spine
     joins the blade instead of being lost (see the comment at the step).
  3. FILL HOLES: whatever the backdrop cannot reach from the frame border is parang, so a
     highlight enclosed by the blade survives even when it is as light as the wall. The
     cost: the few backdrop pixels seen THROUGH the openwork of the spine keep their old
     colour (ParangOnly24: 128 pixels of 2.2 million).
  4. DROP ISLANDS smaller than MIN_AREA (dust) and anything touching the frame border (the
     photo's edge; the parang never reaches it), then composite: every parang pixel is
     copied exactly, and the one-pixel feather lives on the BACKDROP side only.

Thresholds are measured, not chosen (ParangOnly24, the frame with the most uneven
backdrop of all 117): backdrop luma never below 240 (p1 246) and chroma at most 11; blade
luma at most ~207; rattan chroma median 112. WEAK_LUMA 238 sits just under the backdrop's
darkest pixel, STRONG_LUMA 225 well above the blade's brightest.

Every frame is CHECKED, not trusted, and the run fails if any check fails:
  - every parang pixel, edge included, is byte-identical to the source;
  - every backdrop pixel not touching the parang is exactly the fill colour;
  - at least one parang component survives.
Warnings (printed, recorded, not fatal): more than one component, islands removed, and a
parang area more than AREA_JUMP off the median of its neighbours -- a mask that suddenly
shrinks or swells is the visible failure on a turntable.

A report of every frame is written to <out>/report.json.

Pure Python, no numpy or PIL, per the project's tooling rule; ffmpeg decodes and encodes.
About 15 s a frame on one core; frames run in parallel.

Usage: replace-backdrop.py <src-folder> <pattern> <out-folder> --fill R,G,B [--skip N,N] [--jobs N]
       pattern is printf-style, e.g. "ParangOnly%02d.png"; output is frame-NN.png, numbered
       contiguously. --skip leaves out source frames by number (e.g. a blank export).
"""
import json
import os
import re
import statistics
import subprocess
import sys
from collections import deque
from multiprocessing import Pool

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ffmpeg_path import ffmpeg, ffprobe  # noqa: E402

STRONG_LUMA, STRONG_CHROMA = 225, 20
WEAK_LUMA, WEAK_CHROMA = 238, 13
MIN_AREA = 400
CLOSE_RADIUS = 12
AREA_JUMP = 0.15

FFMPEG = FFPROBE = None


def _init(ff, fp):
    global FFMPEG, FFPROBE
    FFMPEG, FFPROBE = ff, fp


def process(job):
    src, dst, fill = job
    probe = subprocess.run([FFPROBE, '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                            'stream=width,height', '-of', 'csv=p=0', src],
                           capture_output=True, text=True, check=True).stdout.strip()
    W, H = map(int, probe.split(','))
    raw = subprocess.run([FFMPEG, '-v', 'error', '-i', src, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
                         capture_output=True, check=True).stdout
    N = W * H

    strong = bytearray(N)
    weak = bytearray(N)
    for p in range(N):
        i = p * 3
        r, g, b = raw[i], raw[i + 1], raw[i + 2]
        y = (r * 299 + g * 587 + b * 114) // 1000
        c = max(r, g, b) - min(r, g, b)
        if y < STRONG_LUMA or c > STRONG_CHROMA:
            strong[p] = 1
        if y < WEAK_LUMA or c > WEAK_CHROMA:
            weak[p] = 1

    def neighbours(p):
        x, y = p % W, p // W
        for dy in (-1, 0, 1):
            yy = y + dy
            if 0 <= yy < H:
                for dx in (-1, 0, 1):
                    xx = x + dx
                    if (dx or dy) and 0 <= xx < W:
                        yield yy * W + xx

    # 2. grow from the seeds
    mask = bytearray(strong)
    q = deque(p for p in range(N) if strong[p])
    while q:
        p = q.popleft()
        for n in neighbours(p):
            if not mask[n] and weak[n]:
                mask[n] = 1
                q.append(n)

    # 2b. CLOSE the mask by CLOSE_RADIUS (dilate, then erode). The bare blade's spine is a
    # pierced silver filigree almost as light as the wall: only its dark piercings pass the
    # thresholds, as specks a few pixels apart, and without this they were thrown away as
    # dust and the light metal between them painted over -- the whole decorated spine
    # vanished (ParangOnly 22: 381 px of piercings, and the filigree with them). Closing
    # bridges gaps up to 2 x CLOSE_RADIUS, joining the piercings to the blade and keeping the
    # metal between them. The cost is a few small pockets of original backdrop in tight
    # concavities, which keep their source colour (a few levels lighter than the fill).
    xs = [p % W for p in range(N) if mask[p]]
    if xs:
        ys = [p // W for p in range(N) if mask[p]]
        m = CLOSE_RADIUS + 2
        bx0, bx1 = max(0, min(xs) - m), min(W - 1, max(xs) + m)
        by0, by1 = max(0, min(ys) - m), min(H - 1, max(ys) + m)
        bw, bh = bx1 - bx0 + 1, by1 - by0 + 1
        big = bw * bh + 1

        def chessboard(seed):
            """Chessboard distance to the nearest 1 in `seed` (a bw*bh bytearray)."""
            d = [0 if v else big for v in seed]
            for y in range(bh):
                row = y * bw
                for x in range(bw):
                    k = row + x
                    if d[k]:
                        best = d[k]
                        if x and d[k - 1] + 1 < best: best = d[k - 1] + 1
                        if y:
                            up = k - bw
                            if d[up] + 1 < best: best = d[up] + 1
                            if x and d[up - 1] + 1 < best: best = d[up - 1] + 1
                            if x < bw - 1 and d[up + 1] + 1 < best: best = d[up + 1] + 1
                        d[k] = best
            for y in range(bh - 1, -1, -1):
                row = y * bw
                for x in range(bw - 1, -1, -1):
                    k = row + x
                    if d[k]:
                        best = d[k]
                        if x < bw - 1 and d[k + 1] + 1 < best: best = d[k + 1] + 1
                        if y < bh - 1:
                            dn = k + bw
                            if d[dn] + 1 < best: best = d[dn] + 1
                            if x < bw - 1 and d[dn + 1] + 1 < best: best = d[dn + 1] + 1
                            if x and d[dn - 1] + 1 < best: best = d[dn - 1] + 1
                        d[k] = best
            return d

        local = bytearray(bw * bh)
        for y in range(bh):
            src_row = (by0 + y) * W + bx0
            local[y * bw:(y + 1) * bw] = mask[src_row:src_row + bw]
        dilated = bytearray(1 if v <= CLOSE_RADIUS else 0 for v in chessboard(local))
        to_outside = chessboard(bytearray(0 if v else 1 for v in dilated))
        closed_added = 0
        for y in range(bh):
            row = y * bw
            for x in range(bw):
                if to_outside[row + x] > CLOSE_RADIUS:
                    p = (by0 + y) * W + bx0 + x
                    if not mask[p]:
                        mask[p] = 1
                        closed_added += 1
    else:
        closed_added = 0

    # 3. fill holes: flood the backdrop in from the border
    outside = bytearray(N)
    q = deque()
    border = [x for x in range(W)] + [(H - 1) * W + x for x in range(W)] + \
             [y * W for y in range(H)] + [y * W + W - 1 for y in range(H)]
    for p in border:
        if not mask[p] and not outside[p]:
            outside[p] = 1
            q.append(p)
    while q:
        p = q.popleft()
        x, y = p % W, p // W
        for n in ((p - 1) if x else -1, (p + 1) if x < W - 1 else -1,
                  (p - W) if y else -1, (p + W) if y < H - 1 else -1):
            if n >= 0 and not mask[n] and not outside[n]:
                outside[n] = 1
                q.append(n)
    holes = 0
    for p in range(N):
        if not mask[p] and not outside[p]:
            mask[p] = 1
            holes += 1

    # 4a. drop islands, and anything touching the frame border. The parang never reaches
    # the edge of the frame; the photo rectangle's own edge does -- a darker band down the
    # left border of FullParang 25-30 was kept as a second "parang" of 36-66k px and showed
    # as a light strip down the side of the repainted frame.
    seen = bytearray(N)
    kept, removed, border_removed = [], 0, 0
    for s in range(N):
        if mask[s] and not seen[s]:
            comp = [s]
            seen[s] = 1
            k = 0
            touches = False
            while k < len(comp):
                c = comp[k]
                cx, cy = c % W, c // W
                if cx == 0 or cy == 0 or cx == W - 1 or cy == H - 1:
                    touches = True
                for n in neighbours(c):
                    if mask[n] and not seen[n]:
                        seen[n] = 1
                        comp.append(n)
                k += 1
            if touches or len(comp) < MIN_AREA:
                for p in comp:
                    mask[p] = 0
                if touches:
                    border_removed += len(comp)
                else:
                    removed += len(comp)
            else:
                kept.append(len(comp))

    # 4b. composite. Parang pixels are copied exactly -- the feather lives ENTIRELY on the
    # backdrop side: a backdrop pixel touching the parang keeps a share of its source value
    # (its anti-aliased edge) in proportion to how many of its 8 neighbours are parang.
    # Blending the parang's own outer ring instead was tried first and softened the true
    # edge by 100-200 pixels a frame, which is exactly the "eating the parang" to avoid.
    out = bytearray(N * 3)
    for y in range(H):
        for x in range(W):
            p = y * W + x
            i = p * 3
            if mask[p]:
                out[i:i + 3] = raw[i:i + 3]
                continue
            a = 0
            for yy in (y - 1, y, y + 1):
                if 0 <= yy < H:
                    base = yy * W
                    for xx in (x - 1, x, x + 1):
                        if 0 <= xx < W:
                            a += mask[base + xx]
            if a == 0:
                out[i], out[i + 1], out[i + 2] = fill
            else:
                for k in range(3):
                    out[i + k] = (raw[i + k] * a + fill[k] * (9 - a) + 4) // 9

    # Checks, on the composited result: EVERY parang pixel identical to the source, edge
    # included; every backdrop pixel not touching the parang exactly the fill.
    fill_b = bytes(fill)
    inner = same = bg = flat = 0
    for y in range(H):
        for x in range(W):
            p = y * W + x
            i = p * 3
            if mask[p]:
                inner += 1
                same += out[i:i + 3] == raw[i:i + 3]
            else:
                if not any(mask[(y + dy) * W + x + dx]
                           for dy in (-1, 0, 1) for dx in (-1, 0, 1)
                           if 0 <= y + dy < H and 0 <= x + dx < W):
                    bg += 1
                    flat += out[i:i + 3] == fill_b

    subprocess.run([FFMPEG, '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}',
                    '-i', '-', '-pix_fmt', 'rgb24', dst], input=bytes(out), check=True)

    return {
        'frame': os.path.basename(dst), 'source': os.path.basename(src),
        'parang': sum(mask), 'closedAdded': closed_added, 'components': kept, 'islandsRemoved': removed, 'borderRemoved': border_removed, 'holesFilled': holes,
        'interior': inner, 'interiorIdentical': same, 'backdrop': bg, 'backdropFlat': flat,
    }


def main():
    args = sys.argv[1:]
    jobs = os.cpu_count() or 4
    fill = None
    skip = set()
    pos = []
    i = 0
    while i < len(args):
        if args[i] == '--fill':
            fill = tuple(int(v) for v in args[i + 1].split(','))
            i += 2
        elif args[i] == '--skip':
            skip = {int(v) for v in args[i + 1].split(',') if v}
            i += 2
        elif args[i] == '--jobs':
            jobs = int(args[i + 1])
            i += 2
        else:
            pos.append(args[i])
            i += 1
    if len(pos) != 3 or not fill or len(fill) != 3:
        raise SystemExit(__doc__.split('Usage:')[1])
    src_dir, pattern, out_dir = pos

    rx = re.compile('^' + re.sub(r'%0?(\d*)d', lambda m: r'(\d{%s})' % (m.group(1) or '1,'),
                                 re.escape(pattern).replace(r'\%', '%')) + '$')
    found = sorted((int(m.group(1)), f) for f in os.listdir(src_dir) if (m := rx.match(f)))
    if not found:
        raise SystemExit(f'  no frames matching {pattern} in {src_dir}')
    missing = skip - {n for n, _ in found}
    if missing:
        raise SystemExit(f'  --skip names frames that do not exist: {sorted(missing)}')
    found = [(n, f) for n, f in found if n not in skip]
    pad = max(len(str(len(found) - 1)), 2)
    os.makedirs(out_dir, exist_ok=True)
    for f in os.listdir(out_dir):           # a smaller set must not leave stale frames behind
        if f.startswith('frame-') and f.endswith('.png'):
            os.remove(os.path.join(out_dir, f))
    # Output is numbered contiguously, so skipped frames leave no gap in the sequence.
    work = [(os.path.join(src_dir, f), os.path.join(out_dir, f'frame-{k:0{pad}d}.png'), fill)
            for k, (n, f) in enumerate(found)]

    with Pool(min(jobs, len(work)), initializer=_init, initargs=(ffmpeg(), ffprobe())) as pool:
        results = pool.map(process, work, chunksize=1)

    failures, warnings = [], []
    areas = [r['parang'] for r in results]
    for k, r in enumerate(results):
        if not r['components']:
            failures.append(f"{r['frame']}: no parang left")
        if r['interiorIdentical'] != r['interior']:
            failures.append(f"{r['frame']}: {r['interior'] - r['interiorIdentical']} interior pixels changed")
        if r['backdropFlat'] != r['backdrop']:
            failures.append(f"{r['frame']}: {r['backdrop'] - r['backdropFlat']} backdrop pixels not the fill")
        if len(r['components']) > 1:
            warnings.append(f"{r['frame']}: {len(r['components'])} components {r['components']}")
        if r['borderRemoved']:
            warnings.append(f"{r['frame']}: {r['borderRemoved']} px touching the frame border repainted")
        if r['islandsRemoved']:
            warnings.append(f"{r['frame']}: {r['islandsRemoved']} px of islands removed")
        around = [areas[(k + d) % len(areas)] for d in (-2, -1, 1, 2)]
        med = statistics.median(around)
        r['areaVsNeighbours'] = round(r['parang'] / med, 3)
        if abs(r['parang'] / med - 1) > AREA_JUMP:
            warnings.append(f"{r['frame']}: parang area {r['areaVsNeighbours']}x its neighbours")

    with open(os.path.join(out_dir, 'report.json'), 'w', encoding='utf-8') as fh:
        json.dump({'fill': fill, 'thresholds': {
            'strongLuma': STRONG_LUMA, 'strongChroma': STRONG_CHROMA,
            'weakLuma': WEAK_LUMA, 'weakChroma': WEAK_CHROMA, 'minArea': MIN_AREA,
            'closeRadius': CLOSE_RADIUS},
            'failures': failures, 'warnings': warnings, 'frames': results}, fh, indent=1)

    print(f'  {len(results)} frames -> {out_dir}')
    print(f'  parang area {min(areas)}..{max(areas)} px; every parang pixel identical on every frame: '
          f'{all(r["interiorIdentical"] == r["interior"] for r in results)}; '
          f'backdrop exactly {fill} on every frame: {all(r["backdropFlat"] == r["backdrop"] for r in results)}')
    for w in warnings:
        print(f'  warning  {w}')
    for f in failures:
        print(f'  FAILED   {f}')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
