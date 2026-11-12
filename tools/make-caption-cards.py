#!/usr/bin/env python
"""
Caption cards for Bangie's Terokai Produk details (6 Nov 2026), drawn in the style of
Maznah's supplied cards (maznah/products/bakul/info-*.png), measured off them:

  white fill, a border and text in #5E2207, ~70 px corner radius and a 10 px border on a
  926 px card shown at 0.546 (so ~38 and ~5.5 design px), Arial Bold for the Malay and
  Arial Italic for the English, ~50 px type (~27 design px on screen).

Each card: a title line (Malay bold / English italic), the Malay description in bold, the
English in italic, all centred. The words are the ones on the museum's motif sheet for the
four rectangles (user's screenshot, 6 Nov 2026). All four are drawn the SAME height -- half
the picture's, at the user's request -- with the text centred in it and set at the largest
size that fits, so every detail+caption group centres identically on screen.

They are drawn at twice the size they appear (1264 px wide for a 632 design-px card), so
they stay sharp on the 4K panel; content.json gives each one its display width (`w`).

Usage: make-caption-cards.py <out dir>      writes caption-1.png .. caption-4.png
Edit CARDS below and re-run, then `npm run prepare-assets` stages them.
"""
import os, sys
from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1]
W = 1264                       # px; shown at 632 design px (2x for the 4K panel)
H = 632                        # px; shown at 316: HALF the picture's 632 (user, 6 Nov 2026)
BROWN = (94, 34, 7, 255)       # #5E2207, Maznah's cards' border and text
BORDER = 11                    # Maznah: 10 px at 0.546 -> 5.5 design px -> 11 at 2x
RADIUS = 76                    # Maznah: ~70 px at 0.546 -> ~38 design px -> 76 at 2x
PAD_X, PAD_Y = 56, 30          # inside the border
MAX_SIZE = 54                  # Maznah's ~50 px at 0.546 = ~27 design px -> 54 at 2x
LEAD = 1.22                    # line pitch / size, Maznah's 48 px pitch on 50 px type
FONTS = 'C:/Windows/Fonts/'

CARDS = [
    ('Beji', 'Beji',
     'Seorang pemimpin yang bercita-cita tinggi membina tangga gergasi ke langit untuk '
     'menemui Petara (roh tertinggi).',
     'An ambitious leader who aspired to build a gigantic ladder reaching up to the '
     'heavens to meet Petara (the supreme spirit).'),
    ('Tangga Gergasi', 'Giant Ladder',
     'Gambaran tangga gergasi yang dibina oleh Beji untuk naik ke langit bertemu Petara '
     '(roh tertinggi).',
     'Depicts the gigantic ladder built by Beji to ascend to the heavens and meet Petara '
     '(the supreme spirit).'),
    ('Tangga Gergasi yang Telah Rosak', 'Damaged Giant Ladder',
     'Motif ini menggambarkan tangga yang rosak dimakan anai-anai dan akhirnya hancur. '
     'Perkara ini menggagalkan usaha Beji untuk naik ke langit.',
     'This motif depicts the ladder being damaged by termites and eventually collapsing. '
     "This ultimately thwarted Beji's attempt to ascend to the heavens."),
    ('Pahlawan (Pengikut Beji)', "Warriors (Beji's Followers)",
     'Menggambarkan pengikut setia. Mereka membantu Beji mengumpulkan pokok-pokok tinggi '
     'dan besar untuk membina tangga gergasi bagi memenuhi cita-cita Beji.',
     "Represents Beji's loyal followers, who helped him gather tall, large trees to "
     'construct the giant ladder in pursuit of his ambition.'),
    ('Anai-anai', 'Termites',
     'Menggambarkan serangga yang memakan tangga gergasi dan menyebabkan usaha Beji tidak '
     'berjaya.',
     "Depicts insects that consumed the giant ladder, causing Beji's ambitious undertaking "
     'to fail.'),
    ('Komuniti Penduduk Kampung', 'Village Community',
     'Menggambarkan sekelompok masyarakat yang kuat dan saling bekerjasama.',
     'Represents a strong and united community whose members work together cooperatively.'),
]

TEXT_W = W - 2 * (BORDER + PAD_X)
probe = ImageDraw.Draw(Image.new('RGBA', (1, 1)))


def fonts(size):
    """The four faces at one type size; the title a touch larger, gaps in proportion."""
    global BOLD, ITAL, T_BOLD, T_ITAL, SIZE, TITLE, GAP
    SIZE, TITLE, GAP = size, size + 4, round(size * 0.6)
    BOLD = ImageFont.truetype(FONTS + 'arialbd.ttf', SIZE)
    ITAL = ImageFont.truetype(FONTS + 'ariali.ttf', SIZE)
    T_BOLD = ImageFont.truetype(FONTS + 'arialbd.ttf', TITLE)
    T_ITAL = ImageFont.truetype(FONTS + 'arialbi.ttf', TITLE)


def wrap(text, font):
    lines, cur = [], ''
    for word in text.split():
        trial = f'{cur} {word}'.strip()
        if probe.textlength(trial, font=font) <= TEXT_W or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = word
    return lines + [cur]


def title_runs(bm, en):
    """The title as one centred line of runs: Malay bold, ' / ', English italic.
    The same word twice (Beji) is written once."""
    if bm == en:
        return [[(bm, T_BOLD)]]
    runs = [(bm, T_BOLD), ('  /  ', T_BOLD), (en, T_ITAL)]
    if sum(probe.textlength(t, font=f) for t, f in runs) <= TEXT_W:
        return [runs]
    return [[(bm, T_BOLD)], [(en, T_ITAL)]]   # too long for one line: two


def layout(card):
    bm_t, en_t, bm, en = card
    blocks = [('title', title_runs(bm_t, en_t), TITLE),
              ('bm', [[(l, BOLD)] for l in wrap(bm, BOLD)], SIZE),
              ('en', [[(l, ITAL)] for l in wrap(en, ITAL)], SIZE)]
    height = sum(len(lines) * round(size * LEAD) for _, lines, size in blocks) + GAP * (len(blocks) - 1)
    return blocks, height


# The card height is fixed (H), so the type is the largest size, at most Maznah's, at
# which the longest of the four still fits; all four share it.
for size in range(MAX_SIZE, 24, -1):
    fonts(size)
    laid = [layout(c) for c in CARDS]
    if max(h for _, h in laid) + 2 * (BORDER + PAD_Y) <= H:
        break
print(f'type {SIZE} px (title {TITLE}) = {SIZE / 2:.1f} design px on screen')

os.makedirs(OUT, exist_ok=True)
for i, (blocks, text_h) in enumerate(laid, 1):
    im = Image.new('RGBA', (W, H), (255, 255, 255, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, W - 1, H - 1], radius=RADIUS, fill=(255, 255, 255, 255),
                        outline=BROWN, width=BORDER)
    y = (H - text_h) / 2
    for _, lines, size in blocks:
        pitch = round(size * LEAD)
        for runs in lines:
            x = (W - sum(d.textlength(t, font=f) for t, f in runs)) / 2
            for t, f in runs:
                d.text((x, y + pitch / 2), t, font=f, fill=BROWN, anchor='lm')
                x += d.textlength(t, font=f)
            y += pitch
        y += GAP
    im.save(f'{OUT}/caption-{i}.png')
    print(f'caption-{i}.png  {W}x{H}  ({sum(len(l) for _, l, _ in blocks)} lines)')
