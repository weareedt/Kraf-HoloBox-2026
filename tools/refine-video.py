#!/usr/bin/env python
"""
Refine a talk/stage clip whose backdrop is grey: lift the backdrop to WHITE (240), grade
the artist. Built for Bangie (22 Oct 2026); the output is what tools/transcode.mjs then
remuxes into the app unchanged.

The lift is the project's own (tools/transcode.mjs liftFilter, used for Maznah and Johnny):
a soft difference matte against a plate of the empty backdrop, and out = in + (WHITE -
plate) on the backdrop only, so clean wall lands on 240 whatever its vignette, shadows keep
their depth, and the plate's colour cast is neutralised. Two additions:

  * The plate can change over time: plate(t) = A + (B - A) * clip((t - T0)/(T1 - T0), 0, 1).
    Bangie's walk-in is two shots joined by a dissolve (3.38-3.80 s), each with its own
    backdrop, so its plate cross-fades with it. In the dissolve itself the frame is a mix
    of two shots that neither plate describes, and the top-right corner dips ~20 levels for
    ~0.3 s; a higher brightness threshold (--br0 9) was tried and changed it by 3 levels.
  * The FOREGROUND is graded: white balance from the backdrop's measured cast (the camera's
    warmth on her is the same warmth that is on the wall), plus mild contrast and
    saturation. The backdrop is not graded -- it is lifted to a neutral 240.

Plates: a few empty frames where the clip has them; otherwise tools/make-plate.py
--degree 6 (Bangie's vignette needs the higher order). Her supplied empty.png was NOT
used: it carries horizontal smears that would print into every frame.

Output: 1296x2304 H.264 CRF 17, BT.709-tagged -- the app's spec, so the pipeline remuxes it.
Lifting at full 4K was measured at 0.8 fps on this machine; at 1296x2304 a fixed-plate clip
runs at ~11 fps (a talk takes 30-40 minutes).

Usage:
  refine-video.py <clip> <out> --plate A.png [--plate-b B.png --t0 S --t1 S]
                  [--still SECONDS] [--audio] [--scale 1296:2304] [--br0 N] [--no-grade]
"""
import argparse, os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ffmpeg_path import ffmpeg, ffprobe  # noqa: E402

WHITE = 240
LIFT = dict(BR0=5, BR1=26, DK0=60, DK1=120, CH0=4, CH1=16)   # as tools/transcode.mjs
# Foreground grade. WB gains neutralise the wall's measured cast (R 192 / G 183 / B 179 on
# the standing set, the same ratios within 1% on the seated one).
GRADE = dict(rr=0.955, gg=1.0, bb=1.02, contrast=1.06, saturation=1.10, gamma=1.0)


def ramp(a, b):
    return f"lut=c0='if(lte(val,{a}),0,if(gte(val,{b}),255,255*(val-{a})/({b}-{a})))'"


def graph(scale, t0, t1, grade):
    k = LIFT
    s = f'scale={scale}:flags=lanczos'
    w = f'clip({WHITE}-val,0,255)'
    g = grade
    # A fixed plate skips the per-pixel expression blend, which is the slow part.
    if t1 > t0:
        plate = (f"[1:v]{s},format=gbrp[pa];\n[2:v]{s},format=gbrp[pb];\n"
                 f"[pa][pb]blend=all_expr='A+(B-A)*clip((T-{t0})/({t1}-{t0}),0,1)':shortest=1,split=2[pm0][po0];")
    else:
        plate = f"[1:v]{s},format=gbrp,split=2[pm0][po0];"
    return f"""[0:v]{s},split=3[base][tolift][vm0];
{plate}
[pm0]format=yuv444p[pm];
[po0]lutrgb=r='{w}':g='{w}':b='{w}',format=gbrp[off];
[vm0]format=yuv444p,split=2[vy][vc];
[pm]split=2[py][pc];
[vy]extractplanes=y,split=2[VY1][VY2];
[py]extractplanes=y,split=2[PY1][PY2];
[VY1][PY1]blend=all_mode=subtract:shortest=1,{ramp(k['BR0'], k['BR1'])}[mB];
[PY2][VY2]blend=all_mode=subtract:shortest=1,{ramp(k['DK0'], k['DK1'])}[mD];
[vc]extractplanes=u+v[VU][VV];
[pc]extractplanes=u+v[PU][PV];
[VU][PU]blend=all_mode=difference:shortest=1[DU];
[VV][PV]blend=all_mode=difference:shortest=1[DV];
[DU][DV]blend=all_mode=lighten,{ramp(k['CH0'], k['CH1'])}[mC];
[mB][mD]blend=all_mode=lighten[m1];
[m1][mC]blend=all_mode=lighten,gblur=sigma=2.0,negate[Mbg];
[tolift]format=gbrp[tl];
[tl][off]blend=all_mode=addition:shortest=1,format=gbrp[lifted];
[lifted][Mbg]alphamerge[lf];
[base]format=gbrp,colorchannelmixer=rr={g['rr']}:gg={g['gg']}:bb={g['bb']},eq=contrast={g['contrast']}:saturation={g['saturation']}:gamma={g['gamma']},format=gbrp[bs];
[bs][lf]overlay=format=auto,format=yuv420p[out]"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('clip'); ap.add_argument('out')
    ap.add_argument('--plate', required=True); ap.add_argument('--plate-b')
    ap.add_argument('--t0', type=float, default=0); ap.add_argument('--t1', type=float, default=0)
    ap.add_argument('--still', type=float); ap.add_argument('--audio', action='store_true')
    ap.add_argument('--scale', default='1296:2304')
    ap.add_argument('--no-grade', action='store_true')
    ap.add_argument('--br0', type=int, help='brightness-above-plate threshold (default 5); the walk-in uses 9 against grain in its shot change')
    a = ap.parse_args()
    if a.br0 is not None:
        LIFT['BR0'] = a.br0

    dur = float(subprocess.run([ffprobe(), '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', a.clip],
                               capture_output=True, text=True, check=True).stdout.strip())
    grade = dict(GRADE, rr=1, bb=1, contrast=1, saturation=1) if a.no_grade else GRADE
    plate_b = a.plate_b or a.plate
    # Plates are looped for EXACTLY the clip's length at its frame rate, so T lines up with
    # the clip's timestamps and no stream runs forever (blend's framesync waits for all).
    inputs = []
    if a.still is not None:
        inputs += ['-ss', str(a.still), '-t', '0.1']
        pdur = '0.1'
    else:
        pdur = str(dur)
    inputs += ['-i', a.clip,
               '-loop', '1', '-framerate', '50', '-t', pdur, '-i', a.plate,
               '-loop', '1', '-framerate', '50', '-t', pdur, '-i', plate_b]
    t0, t1 = a.t0, a.t1
    if a.still is not None and t1 > t0:
        # a still's clock starts at 0: shift the transition window to match
        t0, t1 = t0 - a.still, t1 - a.still
    cmd = [ffmpeg(), '-v', 'error', '-y', *inputs, '-filter_complex', graph(a.scale, t0, t1, grade),
           '-map', '[out]']
    if a.still is not None:
        cmd += ['-frames:v', '1', '-pix_fmt', 'rgb24', a.out]
    else:
        cmd += ['-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p',
                '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
                '-movflags', '+faststart']
        cmd += (['-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k'] if a.audio else ['-an'])
        cmd += ['-shortest', a.out]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(r.stderr)


main()
