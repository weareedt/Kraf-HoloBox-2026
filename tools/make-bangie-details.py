#!/usr/bin/env python
"""
Bangie's two extra Terokai Produk hotspots (6 Nov 2026): Anai-anai (termites) and Komuniti
penduduk kampung (village community), from the museum's motif sheet. For each: a yellow
rectangle and a detail picture in the designer's own frame, both cut from newbase.png.

Measured off the designer's four (`product explore/1 - Beji.png` etc.) rather than guessed:
  - the frame is 692x692: transparent glow, a 10 px white border at 80-90 px, and a 512x512
    picture inside it (90-602). The new picture is put inside an existing file's frame, so
    border, rounded corners and glow are the designer's own pixels;
  - each picture is a square crop of the base about as large as its rectangle's longer side
    (0.75-1.12x across the four, found by template matching);
  - the rectangle is a 10 px #F6FF00 stroke; its PNG is the path size + 10.

Where the two motifs are:
  - Anai-anai: the segmented insect inside the diamond, middle column, found by matching the
    museum sheet's thumbnail (score 0.74); its red box lands at base x 668-769, y 895-1070.
  - Village: the row of small figures along the bottom edge, its right end ("most bottom
    right", per the user): the last five figures and the white band above them.

Usage: make-bangie-details.py <newbase.png> <a designer detail.png> <out dir>
"""
import sys
import numpy as np
from PIL import Image, ImageDraw

BASE, FRAME, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
YELLOW = (246, 255, 0, 255)
STROKE = 10
INNER = (90, 602)            # the picture box inside the frame, both axes

# id: (rectangle path X, Y, W, H in base px), (square crop x0, y0, side)
SPOTS = {
    '5 - Anai-anai':        ((668, 895, 101, 175), (623, 888, 190)),
    # The crop stops 12 px short of the base's bottom edge, where a white scrap shows.
    '6 - VillageCommunity': ((922, 2292, 183, 100), (910, 2198, 190)),
}
RECT_NAMES = {'5 - Anai-anai': 'Rectangle 5 Anai-anai', '6 - VillageCommunity': 'Rectangle 6 Village Community'}

base = Image.open(BASE).convert('RGB')
frame = Image.open(FRAME).convert('RGBA')
fa = np.asarray(frame).astype(int)
i0, i1 = INNER
# Keep the frame's own white border wherever it reaches into the picture box (its rounded
# inner corners): near-white, opaque pixels within 24 px of the box edge.
yy, xx = np.mgrid[0:frame.height, 0:frame.width]
near_edge = (np.minimum(np.minimum(xx - i0, i1 - 1 - xx), np.minimum(yy - i0, i1 - 1 - yy)) < 24)
border = (fa[..., :3].min(-1) > 235) & (fa[..., 3] > 250) & near_edge
in_box = (xx >= i0) & (xx < i1) & (yy >= i0) & (yy < i1)

for name, ((X, Y, W, H), (cx, cy, side)) in SPOTS.items():
    crop = base.crop((cx, cy, cx + side, cy + side)).resize((i1 - i0, i1 - i0), Image.LANCZOS)
    canvas = np.asarray(frame).copy()
    pic = np.zeros_like(canvas); pic[i0:i1, i0:i1, :3] = np.asarray(crop); pic[i0:i1, i0:i1, 3] = 255
    put = in_box & ~border
    canvas[put] = pic[put]
    Image.fromarray(canvas).save(f'{OUT}/{name}.png')

    rect = Image.new('RGBA', (W + STROKE, H + STROKE), (0, 0, 0, 0))
    ImageDraw.Draw(rect).rectangle([0, 0, W + STROKE - 1, H + STROKE - 1], outline=YELLOW, width=STROKE)
    rect.save(f'{OUT}/{RECT_NAMES[name]}.png')
    print(f'{name}.png  crop {cx},{cy} side {side}  |  {RECT_NAMES[name]}.png {W + STROKE}x{H + STROKE}, '
          f'centre {X + W / 2},{Y + H / 2}')
