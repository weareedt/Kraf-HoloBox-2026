#!/usr/bin/env python
"""
Extract the caption tracks from an Adobe Premiere project as .srt files.

Built for Bangie (2 Nov 2026): the editor captioned her Iban talks in English inside
Premiere and exported only burnt-in review videos. The captions themselves -- text and
exact timing -- are in the .prproj, which is gzipped XML:

  * each CaptionDataClipTrack is one caption track (here: one per talk);
  * each CaptionDataClipTrackItem has Start/End in Premiere ticks, 254,016,000,000 per
    second (a missing Start means 0), and points at a Block;
  * the Block's FormattedTextData is base64 flatbuffer data holding the text as a
    length-prefixed UTF-8 string next to the font name. Its base64 is line-wrapped.
  * Premiere DE-DUPLICATES identical data: a block may carry only BinaryHash="..." with
    the data stored once on another element with the same hash. Missing that left one of
    Bangie's 225 captions empty on the first attempt.

Check the result against the burnt-in export at a few timestamps; then, if the app plays a
different cut, carry it across with tools/retime-subs.py.

Usage: gzip -dc project.prproj > project.xml
       prproj-captions.py <project.xml> <out-dir>      -> out-dir/track-0.srt, track-1.srt, ...
"""
import base64, os, re, struct, sys

TICKS = 254016000000
xml = open(sys.argv[1], encoding='utf-8', errors='replace').read()
out = sys.argv[2]
os.makedirs(out, exist_ok=True)

objects = {}
for m in re.finditer(r'<(\w+) ObjectID="(\d+)"[^>]*>(.*?)</\1>', xml, re.S):
    objects[m.group(2)] = (m.group(1), m.group(3))


def strings(raw):
    """Every length-prefixed UTF-8 string in a flatbuffer blob."""
    found = []
    for i in range(0, len(raw) - 4):
        n = struct.unpack_from('<I', raw, i)[0]
        if 1 <= n <= 2000 and i + 4 + n <= len(raw):
            s = raw[i + 4:i + 4 + n]
            if (i + 4 + n == len(raw) or raw[i + 4 + n] == 0) and all(b >= 0x20 or b in (9, 10, 13) for b in s):
                try:
                    found.append(s.decode('utf-8'))
                except UnicodeDecodeError:
                    pass
    return found


# Premiere de-duplicates identical binaries: a block may carry only BinaryHash="..." with no
# data, and the data sits once on another element with the same hash. (Bangie's profile,
# caption 77, "So that is what we have been using right up until today...".)
by_hash = {h: re.sub(r'\s+', '', d) for h, d in re.findall(r'BinaryHash="([^"]+)">([^<]+)<', xml)
           if d.strip()}


def text_of(block_id):
    kind, body = objects.get(block_id, ('', ''))
    b = re.search(r'<FormattedTextData Encoding="base64"[^>/]*>([^<]*)<', body)
    data = re.sub(r'\s+', '', b.group(1)) if b else ''
    if data:
        pass
    else:
        h = re.search(r'<FormattedTextData Encoding="base64" BinaryHash="([^"]+)"/>', body)
        data = by_hash.get(h.group(1)) if h else None
    if not data:
        return None
    raw = base64.b64decode(data)
    cands = [s for s in strings(raw) if s not in ('LucidaConsole',) and not re.fullmatch(r'[A-Za-z-]+', s)]
    return max(cands, key=len) if cands else ''


def stamp(t):
    ms = round(t * 1000)
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f'{h:02d}:{m:02d}:{s:02d},{ms:03d}'


# tracks in document order; each track's items are referenced from its body
track_ids = [m.group(1) for m in re.finditer(r'<CaptionDataClipTrack ObjectUID="([^"]+)"', xml)]
for n, m in enumerate(re.finditer(r'<CaptionDataClipTrack ObjectUID="[^"]+"[^>]*>(.*?)</CaptionDataClipTrack>', xml, re.S)):
    body = m.group(1)
    refs = re.findall(r'<TrackItem Index="\d+" ObjectRef="(\d+)"/>', body)
    cues = []
    for r in refs:
        kind, item = objects.get(r, ('', ''))
        if kind != 'CaptionDataClipTrackItem':
            continue
        st = re.search(r'<Start>(\d+)</Start>', item)
        en = re.search(r'<End>(\d+)</End>', item)
        blk = re.search(r'<BlockVectorItem Index="0" ObjectRef="(\d+)"/>', item)
        a = int(st.group(1)) / TICKS if st else 0.0
        b = int(en.group(1)) / TICKS if en else a
        txt = text_of(blk.group(1)) if blk else ''
        cues.append((a, b, (txt or '').replace('\r\n', '\n').replace('\r', '\n').strip()))
    cues.sort()
    path = os.path.join(out, f'track-{n}.srt')
    with open(path, 'w', encoding='utf-8', newline='\n') as fh:
        for k, (a, b, t) in enumerate(cues, 1):
            fh.write(f'{k}\n{stamp(a)} --> {stamp(b)}\n{t}\n\n')
    empty = sum(1 for c in cues if not c[2])
    print(f'track {n}: {len(cues)} cues, {cues[0][0]:.2f}s -> {cues[-1][1]:.2f}s, empty text: {empty}')
    print(f'   first: {cues[0][2][:80]!r}\n   last:  {cues[-1][2][:80]!r}  -> {path}')
