#!/usr/bin/env node
/**
 * KRAF — one-time asset preparation pass.
 *
 * Reads the raw Unity StreamingAssets masters from _source/raw/ and produces the
 * web-ready tree under content/artists/<id>/.
 *
 * THIS SCRIPT DOES NOT RE-ENCODE. It remuxes. That decision came from measuring the
 * masters rather than assuming, and the measurements killed most of the usual reasons
 * to transcode:
 *
 *   - Already faststart.  Every master has moov@28, ahead of mdat. There is no
 *                         first-frame stall to fix.
 *   - Already CFR 25.     r_frame_rate == avg_frame_rate, with a clean regular
 *                         30-frame GOP. Seeking and looping are already cheap.
 *   - Already bt709...    but ONLY the landscape step videos. The three portrait
 *                         clips report color_space=unknown.
 *
 * That last one is the single real defect, and it matters here more than usual: the
 * artist is shot against a near-white backdrop (measured ~#FCFCFF) shown on a
 * semi-transparent panel. If Chrome picks a different matrix than the grade assumed,
 * the backdrop shifts and the video's rectangle becomes visible against the page.
 *
 * Fixing it needs metadata, not pixels — so we rewrite the SPS VUI colour fields with
 * the h264_metadata bitstream filter and stream-copy everything else. Zero generation
 * loss, seconds instead of an hour.
 *
 * The one stream we do drop: walk/idle audio, which measures -91 dB (digital silence).
 * Dropping it removes any loop-click and lets both clips autoplay as muted, which
 * sidesteps Chrome's autoplay policy for the two clips that matter most.
 *
 * Idempotent: an output newer than its input is skipped. Pass --force to rebuild.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, '_source', 'raw', 'StreamingAssets');
const OUT = join(ROOT, 'content', 'artists');

/* The drop folder sits OUTSIDE the project, beside it:
 *
 *     CLAUDE project/KRAF/
 *       HoloBox/        <- this repo, the thing that goes to GitHub
 *       outer assets/   <- 35 GB of masters, deliberately not in the repo
 *
 * It used to live inside the project, and the move silently broke every job here: the
 * default resolved to HoloBox/outer assets, which does not exist, so every source came
 * back "! missing" and the run still exited successfully. Override with KRAF_STAGE or
 * --stage=... when the masters are somewhere else (another drive, a colleague's copy).
 */
const stageArg = process.argv.find((a) => a.startsWith('--stage='))?.slice(8);
const STAGE = resolve(stageArg ?? process.env.KRAF_STAGE ?? join(ROOT, '..', 'outer assets'));
const FORCE = process.argv.includes('--force');

if (!existsSync(STAGE)) {
  console.error(`\n  ERROR: drop folder not found\n    ${STAGE}\n\n` +
    `  Point at it with --stage="D:/path/to/outer assets" or set KRAF_STAGE.\n` +
    `  Without it every job reports "! missing" and nothing is rebuilt.\n`);
  process.exit(1);
}

/* ---------- locate ffmpeg ------------------------------------------------ */

function findBinary(name) {
  const probe = spawnSync(name, ['-version'], { encoding: 'utf8' });
  if (!probe.error) return name;
  const wingetRoot = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages');
  if (existsSync(wingetRoot)) {
    for (const pkg of readdirSync(wingetRoot)) {
      if (!/ffmpeg/i.test(pkg)) continue;
      for (const build of readdirSync(join(wingetRoot, pkg))) {
        const candidate = join(wingetRoot, pkg, build, 'bin', `${name}.exe`);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  throw new Error(`${name} not found. Install with:  winget install Gyan.FFmpeg`);
}

const FFMPEG = findBinary('ffmpeg');
const FFPROBE = findBinary('ffprobe');

/* ---------- helpers ------------------------------------------------------ */

const run = (bin, args) => spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
const mb = (bytes) => (bytes / 1048576).toFixed(1).padStart(7) + ' MB';

function probe(file) {
  const r = run(FFPROBE, [
    '-v', 'error', '-show_entries',
    'stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames,color_space',
    '-show_entries', 'format=duration,size', '-of', 'json', file,
  ]);
  const j = JSON.parse(r.stdout || '{}');
  const v = (j.streams ?? []).find((s) => s.codec_type === 'video') ?? {};
  const a = (j.streams ?? []).find((s) => s.codec_type === 'audio');
  const [num, den] = String(v.r_frame_rate ?? '25/1').split('/').map(Number);
  return {
    width: +v.width, height: +v.height,
    fps: Math.round(num / (den || 1)),
    frames: +(v.nb_frames ?? 0),
    tagged: v.color_space && v.color_space !== 'unknown',
    hasAudio: Boolean(a),
    duration: +(j.format?.duration ?? 0),
    size: +(j.format?.size ?? 0),
  };
}

/** Average colour of a background patch — used to match the page to the video. */
function backdropOf(file, at = 5) {
  const png = join(ROOT, '_source', '.backdrop.png');
  const r = run(FFMPEG, ['-v', 'error', '-y', '-ss', String(at), '-i', file,
    '-vf', 'crop=200:200:40:40,scale=1:1:flags=area', '-frames:v', '1',
    '-pix_fmt', 'rgb24', png]);
  if (r.status !== 0 || !existsSync(png)) return null;
  const buf = readFileSync(png);
  let i = 8, idat = Buffer.alloc(0);
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    if (buf.subarray(i + 4, i + 8).toString() === 'IDAT')
      idat = Buffer.concat([idat, buf.subarray(i + 8, i + 8 + len)]);
    i += 12 + len;
  }
  const raw = inflateSync(idat);
  const hex = (n) => n.toString(16).padStart(2, '0').toUpperCase();
  return `#${hex(raw[1])}${hex(raw[2])}${hex(raw[3])}`;
}

/** SRT normaliser: strip UTF-8 BOM, CRLF -> LF. Keeps <i> markup intact. */
/* Subtitle cues that are too fast to read are widened into the silence around them.
 *
 * Norhaiza's supplied file had 20 of its 128 cues above 20 characters per second against a
 * median of 10.8, the worst being 51 characters held for 0.80 s — about 64 ch/s, roughly six
 * times her normal pace and simply not readable. Samat's had the same fault in two places.
 *
 * Only DEAD AIR is used: a cue grows into the gap after it and then the gap before it, never
 * past a neighbour, always leaving MIN_GAP so two cues cannot touch. The speech it belongs to
 * is untouched, so nothing drifts out of sync — the line just appears a little earlier and
 * lingers a little longer. Norhaiza's file has 88.5 s of such dead air.
 *
 * The sources are masters under _source/, so this happens at build time rather than by
 * editing them.
 */
const SRT_MAX_RATE = 20;      // characters per second
const SRT_MIN_GAP = 0.08;     // seconds kept between neighbouring cues
const SRT_MAX_LEAD = 0.9;     // never start a cue more than this before its own speech
const SRT_MIN_SHOW = 1.0;     // a cue never shrinks below this when lending time
const SRT_MAX_STEAL = 0.8;    // and a shared boundary never moves further than this

function parseSrtCues(text) {
  const out = [];
  for (const block of text.replace(/\r\n/g, '\n').trim().split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length < 2) continue;
    const i = /^\d+$/.test(lines[0].trim()) ? 1 : 0;
    if (!lines[i]?.includes('-->')) continue;
    const t = (s) => {
      const m = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/.exec(s);
      return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000 : null;
    };
    const [a, b] = lines[i].split('-->').map(t);
    if (a === null || b === null) continue;
    out.push({ a, b, body: lines.slice(i + 1) });
  }
  return out;
}

const srtStamp = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:`
    + (s % 60).toFixed(3).padStart(6, '0').replace('.', ',');
};

const cueNeed = (c) => c.body.join(' ').length / SRT_MAX_RATE;
const cueRate = (c) => c.body.join(' ').length / (c.b - c.a);

function relaxCues(cues) {
  // Pass 1 — take the dead air. Costs nothing: the cue simply appears a little earlier and
  // lingers a little longer, over silence.
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const need = cueNeed(c);
    if (c.b - c.a >= need) continue;

    c.b = Math.min(i + 1 < cues.length ? cues[i + 1].a - SRT_MIN_GAP : c.b + need,
                   c.a + need);
    if (c.b - c.a < need) {
      const floor = Math.max(i > 0 ? cues[i - 1].b + SRT_MIN_GAP : 0, c.a - SRT_MAX_LEAD);
      c.a = Math.max(floor, c.b - need);
    }
  }

  /* Pass 2 — borrow from a neighbour that has time to spare.
   *
   * After pass 1 the worst cues are still unreadable (42 ch/s against a median of 11)
   * because they are boxed in by neighbours rather than by silence. A neighbour sitting at
   * 6 ch/s has slack; moving the shared boundary helps the fast cue a lot and costs the
   * slow one little.
   *
   * This does shift a boundary away from the speech by a fraction of a second, which is
   * ordinary subtitling practice and far better than a line nobody can finish reading. The
   * guards keep it honest: never push a neighbour past the target rate itself, never leave
   * one shorter than SRT_MIN_SHOW, and never move a boundary more than SRT_MAX_STEAL.
   */
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    if (cueRate(c) <= SRT_MAX_RATE) continue;

    for (const side of ['next', 'prev']) {
      if (cueRate(c) <= SRT_MAX_RATE) break;
      const n = side === 'next' ? cues[i + 1] : cues[i - 1];
      if (!n) continue;
      const slack = (n.b - n.a) - Math.max(cueNeed(n), SRT_MIN_SHOW);
      const take = Math.min(slack, SRT_MAX_STEAL, cueNeed(c) - (c.b - c.a));
      if (take <= 0.01) continue;
      if (side === 'next') { n.a += take; c.b += take; } else { n.b -= take; c.a -= take; }
    }
  }

  // Pass 3 — guarantee no two cues are ever on screen together. This also repairs defects
  // already present in the supplied files: Maznah's product talk ships with a 20 ms overlap
  // around one of its "### NEW SCRIPT ###" markers.
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].b > cues[i + 1].a - SRT_MIN_GAP) {
      cues[i].b = Math.max(cues[i].a + 0.3, cues[i + 1].a - SRT_MIN_GAP);
    }
  }
  return cues;
}

function convertSrt(src, dst) {
  let text = readFileSync(src, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n/g, '\n');

  const cues = parseSrtCues(text);
  let note = '';
  if (cues.length) {
    const fast = cues.filter((c) => c.body.join(' ').length / (c.b - c.a) > SRT_MAX_RATE).length;
    const overlaps = cues.filter((c, i) => i && cues[i - 1].b > c.a).length;
    if (fast || overlaps) {
      relaxCues(cues);
      text = cues.map((c, n) =>
        `${n + 1}\n${srtStamp(c.a)} --> ${srtStamp(c.b)}\n${c.body.join('\n')}\n`).join('\n');
      const still = cues.filter((c) => c.body.join(' ').length / (c.b - c.a) > SRT_MAX_RATE).length;
      note = (fast ? `, ${fast} too fast -> ${still} left` : '')
           + (overlaps ? `, ${overlaps} overlap fixed` : '');
    }
  }
  writeFileSync(dst, text.trimEnd() + '\n', 'utf8');
  return { cues: cues.length || (text.match(/-->/g) ?? []).length, note };
}

/**
 * Remux: stream-copy the video, optionally stamping BT.709 into the H.264 SPS VUI.
 *
 * `h264_metadata` rewrites the bitstream headers in place — no decode, no re-encode.
 * The container-level `-color_*` flags are set too so the MOV `colr` atom agrees with
 * the bitstream; Chrome reads the container first, but a disagreement between the two
 * is exactly the kind of thing that bites on one machine and not another.
 *
 * values: 1 = BT.709 for primaries, transfer and matrix.
 */
function remux(src, dst, { silent, retag }) {
  const meta = probe(src);
  const args = [
    '-v', 'error', '-stats', '-y', '-i', src,
    '-map', '0:v:0',
    ...(silent || !meta.hasAudio ? [] : ['-map', '0:a:0', '-c:a', 'copy']),
    '-c:v', 'copy',
    ...(retag
      ? ['-bsf:v', 'h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0']
      : []),
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-movflags', '+faststart',
    dst,
  ];
  const r = run(FFMPEG, args);
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${src}\n${r.stderr}`);
  return meta;
}

/* ---------- artwork + model staging --------------------------------------
 * "outer assets/" is the drop folder: new artwork and models land there, and this
 * step copies them into the served content tree under stable names. Keeping it here
 * rather than doing it by hand means a fresh checkout can rebuild everything.
 *
 * `key: "0xRRGGBB"` keys a colour to transparency on the way in — the museum's logo
 * ships on an opaque white box, which would show as a pale rectangle against the
 * #FCFCFF backdrop. `vf` passes an arbitrary ffmpeg filter chain for the odd case.
 * ------------------------------------------------------------------------- */

// Shared UI and Samat's art live in "outer assets/images/"; each later artist has its own
// folder (e.g. "outer assets/norhaiza/"). Bangie's came from the editor as an export
// tree, so his path is named once here rather than repeated on every row.
const ZUL = 'premiere file/bangie/Edited';
const MZN = 'premiere file/maznah/export for claude';
const MZV = 'premiere file/maznah/product rotate/view preview';
const JHN = 'premiere file/johnny';

const ARTWORK = [
  { from: 'images/1 Button Back.png',          to: '_shared/ui/btn-back.png' },
  { from: 'images/2 Button Empty.png',         to: '_shared/ui/btn-empty.png' },
  { from: 'images/5 Button Plus.png',          to: '_shared/ui/btn-plus.png' },
  { from: 'images/6 Button Minus.png',         to: '_shared/ui/btn-minus.png' },
  { from: 'images/6 Button Reset.png',         to: '_shared/ui/btn-reset.png' },
  { from: 'images/7 Button Separate.png',      to: '_shared/ui/btn-separate.png' },
  { from: 'images/10 Button Combine.png',      to: '_shared/ui/btn-combine.png' },
  { from: 'images/11 Button Profile.png',      to: '_shared/ui/btn-profile.png' },
  { from: 'images/12 Button Product.png',      to: '_shared/ui/btn-product.png' },
  { from: 'images/13 Button Step.png',         to: '_shared/ui/btn-step.png' },
  /* Delivered inside Bangie's and Maznah's folders, byte-identical in both. Johnny
   * has no artwork of his own yet, so one copy becomes the shared default. */
  { from: `${MZN}/Button Product Explain.png`, to: '_shared/ui/btn-explain.png' },
  { from: 'images/8 Title.png',                to: '_shared/title.png' },
  { from: 'images/9 Logo.png',                 to: '_shared/logo.png', key: '0xFFFFFF' },
  { from: 'images/4 Samat MainMenu.png',       to: 'samat/menu/card.png' },
  { from: 'images/3 Samat Button MainMenu.png', to: 'samat/menu/nameplate.png' },

  // --- Norhaiza -----------------------------------------------------------
  { from: 'images/15 Norhaiza MainMenu.png',        to: 'norhaiza/menu/card.png' },
  { from: 'images/14 Norhaiza Button MainMenu.png', to: 'norhaiza/menu/nameplate.png' },
  { from: 'images/16 Keris Type 1.png',             to: 'norhaiza/products/keris-1/icon.png' },
  { from: 'images/17 Keris Type 2.png',             to: 'norhaiza/products/keris-2/icon.png' },
  // Title/detail blocks are IMAGES, designed by the museum. These two start life as
  // placeholders generated for the build; replace the files in outer assets and re-run.
  { from: 'images/18 Keris 1 Title.png',            to: 'norhaiza/products/keris-1/info.png' },
  { from: 'images/19 Keris 2 Title.png',            to: 'norhaiza/products/keris-2/info.png' },

  // Product thumbnail. Only surfaces in the rail (2+ products) or behind a missing
  // model, so it is a convenience rather than load-bearing. Cropped from the old
  // Unity screenshot, avoiding that build's own UI on the right-hand side.
  {
    from: 'screenshots/13_SamatProduct.png',
    to: 'samat/products/wau-bulan/thumb.webp',
    vf: 'crop=740:920:62:400,scale=560:-1:flags=lanczos,colorkey=0xFFFFFF:0.12:0.06,format=rgba',
  },

  // --- Bangie ---------------------------------------------------------------
  // He ships his own stage buttons, because two of the three are labels no other
  // artist has ("Terangkan Produk", "Terokai Produk"). Same 1198x370 artwork as the
  // shared set, so they drop straight in via the per-artist `ui` override.
  { from: `${ZUL}/Bangie MainMenu.png`,        to: 'bangie/menu/card.png' },
  { from: `${ZUL}/Bangie Button MainMenu.png`, to: 'bangie/menu/nameplate.png' },
  { from: `${ZUL}/Button Profile.png`,         to: 'bangie/ui/btn-profile.png' },
  { from: `${ZUL}/Button Product Explain.png`, to: 'bangie/ui/btn-explain.png' },
  { from: `${ZUL}/Button Product Explore.png`, to: 'bangie/ui/btn-product.png' },
  // "Supers" card shown over the Product Explain video. Placeholder: the real
  // caption design is not settled, so the schedule and the artwork are both dummies.
  { from: `${ZUL}/Text1.png`,                  to: 'bangie/video/explain-supers.png' },
  // One designed title block, shared by all five views of the cloth.
  { from: `${ZUL}/Title Product Explore.png`,  to: 'bangie/products/tenunan-pua/info.png' },

  // Switcher thumbnails. Bare crops of the cloth — no frame, no glow — so they take
  // the products rail's plain-tile path rather than the artwork-button path.
  ...Array.from({ length: 5 }, (_, i) => ({
    from: `${ZUL}/Zoom${i}.png`,
    to: `bangie/products/tenunan-pua/thumb-${i}.webp`,
    args: ['-quality', '92'],
  })),

  /* The five views of the cloth. These are the reason this table grew an `args`
   * field: the masters are 27-33 megapixels each (Image4 is 4680x7032), which is
   * ~126 MB of decoded RGBA apiece and ~545 MB if all five were ever resident.
   *
   * They are only ever drawn into a 745x1445 design-pixel box, so even a 4K panel
   * cannot show more than ~1490x2890 real pixels. Capping the long edge at 2400
   * keeps a comfortable margin over that and drops each image to ~15 MB decoded. */
  ...['Image0 TenunanPua', 'Image1', 'Image2', 'Image3', 'Image4'].map((name, i) => ({
    from: `${ZUL}/${name}.png`,
    to: `bangie/products/tenunan-pua/view-${i}.webp`,
    vf: "scale='min(1400,iw)':'min(2400,ih)':force_original_aspect_ratio=decrease:flags=lanczos",
    args: ['-quality', '90'],
  })),

  // --- Maznah ---------------------------------------------------------------
  { from: `${MZN}/21 Maznah MainMenu.png`,        to: 'maznah/menu/card.png' },
  { from: `${MZN}/20 Maznah Button MainMenu.png`, to: 'maznah/menu/nameplate.png' },
  { from: `${MZN}/Button Profile.png`,            to: 'maznah/ui/btn-profile.png' },
  { from: `${MZN}/Button Product Explain.png`,    to: 'maznah/ui/btn-explain.png' },
  // Staged ready for when the Terokai Produk assets arrive. Until `products` has
  // entries in content.json the button is not built, so these sit unused.
  { from: `${MZN}/Button Product Explore.png`,    to: 'maznah/ui/btn-product.png' },
  { from: `${MZN}/Title Product Explore.png`,     to: 'maznah/products/bakul/info.png' },
  { from: `${MZN}/Text1.png`,                     to: 'maznah/video/explain-supers.png' },

  /* Terokai Produk hotspots: the pulsing marker and the three zoom-in views it opens.
   * The marker is a white glow ring on transparent, so it is tinted in CSS rather than
   * baked — that is what lets it animate between two colours.
   *
   * "view Right.png" arrived already corrected; Top and Bottom were raw ARW and were put
   * through tools/refine-stills.py first, which is why they come from refined/. All three
   * are capped at 2000px on the long edge: they are shown full-screen on a 1080-wide
   * design canvas, so beyond that is memory with nothing to show for it. */
  { from: `${MZV}/ButtonHighlight.png`,           to: 'maznah/products/bakul/hotspot.png' },
  /* The three zoom-in views arrive portrait, 1334x2000, already graded, on opaque white —
   * and they STAY opaque. They are shown as a card laid over the turntable, so the white
   * is what hides the spinning basket behind them. Keying it to alpha was tried and is
   * wrong here: the turntable then shows through the gaps in the weave. */
  ...['top', 'bottom', 'right'].map((id) => ({
    from: `${MZV}/view ${id[0].toUpperCase()}${id.slice(1)}.png`,
    to: `maznah/products/bakul/zoom-${id}.webp`,
    args: ['-quality', '92'],
  })),

  // --- Johnny -------------------------------------------------------------
  // Menu card and name plate, delivered late. Both match the sizes the other four artists
  // use exactly (749x1080 card, 903x468 plate), so his card finally carries his name and
  // the carousel row lines up without the aspect-matched placeholder crop.
  // The supplied filenames both read "Button MainMenu"; the dimensions are what tell them
  // apart, so they are mapped by size rather than by name.
  { from: `${JHN}/23 Johnny Button MainMenu.png`, to: 'johnny/menu/card.png' },
  { from: `${JHN}/22 Johnny Button MainMenu.png`, to: 'johnny/menu/nameplate.png' },

];

const MODELS = [
  { from: 'old/Wau/Wau.fbx',          to: 'samat/products/wau-bulan/fbx/Wau.fbx' },
  { from: 'old/Wau/WauSeparated.fbx', to: 'samat/products/wau-bulan/fbx/WauSeparated.fbx' },
  { fromDir: 'old/Wau/texture',       toDir: 'samat/products/wau-bulan/fbx/texture' },
];

/* ---------- turntable sequences -----------------------------------------
 * Pre-rendered 360-degree product turns, e.g. Norhaiza's keris.
 *
 * The source frames ship as 1080x1920 on OPAQUE WHITE. On the transparent-LCD panel a
 * pure-white frame shows as a pale rectangle against the artist's backdrop (Norhaiza's
 * is #F4F4F9, which is darker than white), so the white is keyed to alpha.
 *
 * `similarity` was chosen by test, not by eye: 0.12 and above punch holes through the
 * bright specular highlights on Keris 1's silver sheath. 0.06 keeps the metal intact;
 * the faint near-white fringe it leaves is invisible on a near-white backdrop.
 *
 * Every frame is then cropped to the UNION box across the whole turn (measured with
 * cropdetect over the keyed alpha, so no frame is ever clipped). That cuts decoded
 * memory from ~601 MB to ~350 MB per keris, which matters: the viewer keeps a whole
 * turn decoded so scrubbing is smooth.
 * ------------------------------------------------------------------------- */

const SEQUENCES = [
  /* "Keris 1 closed" is "Keris 1" plus ONE synthesised frame at the join, built by
   * tools/close-loop.py. The delivered capture never comes back round: every step is about
   * 5.9 units apart except the wrap, which is 11.7 — a double step, felt as a jolt once per
   * revolution and hit head on when swiping left. Nothing was lost in the build; the source
   * has all 76 of its frames, numbered without a gap. Re-run close-loop.py if the source is
   * ever replaced. */
  { from: 'old/norhaiza/products/Keris 1 closed', pattern: 'Keris-%02d.png', to: 'norhaiza/products/keris-1/frames' },
  { from: 'old/norhaiza/products/Keris 2', pattern: 'KerisDua%02d.png', to: 'norhaiza/products/keris-2/frames' },
  /* Maznah's Sungu Duri basket: 126 frames of a full turn, exported from the colour-
   * corrected turntable (see tools/retime-subs.py's sibling note on that grade). They
   * arrive on opaque white, so the same white-to-alpha key applies — otherwise the basket
   * would sit in a visible white box against the panel's #EFEFEF page.
   * `pad: 3` because the frame numbers run past 99. */
  { from: 'premiere file/maznah/product rotate/pngseq', pattern: 'Bakul%03d.png',
    to: 'maznah/products/bakul/frames', pad: 3 },

];
const KEY_SIMILARITY = 0.06;
const KEY_BLEND = 0.04;

function stageSequences() {
  if (!SEQUENCES.length) return;
  console.log('\n=== turntables ===');
  for (const s of SEQUENCES) {
    const srcDir = join(STAGE, s.from);
    const dstDir = join(OUT, s.to);
    if (!existsSync(srcDir)) { console.log(`  ! missing  ${s.from}/`); continue; }

    const frames = readdirSync(srcDir).filter((f) => /\.png$/i.test(f)).sort();
    const count = frames.length;
    const pad = s.pad ?? 2;
    const last = join(dstDir, `frame-${String(count - 1).padStart(pad, '0')}.webp`);
    const newestSrc = Math.max(...frames.map((f) => statSync(join(srcDir, f)).mtimeMs));
    if (!FORCE && existsSync(last) && statSync(last).mtimeMs > newestSrc) {
      console.log(`  = ${s.to}  (${count} frames, up to date)`);
      continue;
    }
    mkdirSync(dstDir, { recursive: true });

    const key = `colorkey=0xFFFFFF:${KEY_SIMILARITY}:${KEY_BLEND},format=rgba`;

    /* Pass 1: union bounding box over every frame. The key is used here only to turn
     * "not background" into an alpha channel that cropdetect can measure; the frame it
     * produces is thrown away.
     *
     * The obvious alternative, `negate,cropdetect`, does not work: on white-background
     * frames it reported boxes that shrank as it went (108:84:572:396) when the real
     * content is 138x1212. Measuring the alpha is the path the other sequences already
     * rely on, so it is the one to trust. */
    const probeRun = run(FFMPEG, ['-hide_banner', '-framerate', '25', '-start_number', '0',
      '-i', join(srcDir, s.pattern),
      '-vf', `${key},alphaextract,cropdetect=limit=10:round=4:reset=0`,
      '-f', 'null', '-']);
    const crops = (probeRun.stderr.match(/crop=\d+:\d+:\d+:\d+/g) ?? []);
    const crop = crops.at(-1)?.slice(5);
    if (!crop) { console.log(`  ! could not measure ${s.from}`); continue; }

    // Pass 2: crop to the union box and write WebP.
    const r = run(FFMPEG, ['-v', 'error', '-y', '-framerate', '25', '-start_number', '0',
      '-i', join(srcDir, s.pattern),
      '-vf', `${key},crop=${crop}`,
      '-c:v', 'libwebp', '-pix_fmt', 'yuva420p',
      '-quality', '90', '-lossless', '0',
      '-start_number', '0', join(dstDir, `frame-%0${pad}d.webp`)]);
    if (r.status !== 0) { console.log(`  ! failed ${s.to}\n${r.stderr}`); continue; }

    const [w, h] = crop.split(':').map(Number);
    writeFileSync(join(dstDir, 'sequence.json'), JSON.stringify({
      count, pad, width: w, height: h, crop,
      keySimilarity: KEY_SIMILARITY,
      note: 'generated by tools/transcode.mjs — do not edit',
    }, null, 2));
    const bytes = readdirSync(dstDir).filter((f) => f.endsWith('.webp'))
      .reduce((n, f) => n + statSync(join(dstDir, f)).size, 0);
    console.log(`  > ${s.to}  ${count} frames  ${w}x${h}  ${mb(bytes).trim()}` +
      `  (~${Math.round(count * w * h * 4 / 1048576)} MB decoded)`);
  }
}

/* ---------- backdrop lift ------------------------------------------------
 * Maznah's walk/idle/dance arrived ungraded: a grey studio backdrop with a heavy
 * vignette (measured #978E8B in the corners to #D1CAC4 at bottom centre). Her profile
 * and product clips were already graded to a flat white, and these three have to match.
 *
 * A COLOUR KEY CANNOT DO THIS, and the measurement says so plainly. Saturation' on the
 * idle clip: backdrop median 7, her headdress straw median 5. The thing we must keep is
 * LESS saturated than the thing we must remove. Luma is no better — her straw skirt and
 * the backdrop are both L~180. Pushing a key hard enough to clear the backdrop eats her
 * face and the headdress; that was tried and photographed before this was written.
 *
 * What works is a DIFFERENCE MATTE against a plate of the empty backdrop. The walk clip
 * opens on ~70 empty frames, so the plate is free — averaging 32 of them removes sensor
 * noise. Then the SIGN of the difference separates her from her own shadow:
 *
 *   brighter than the plate   -> her straw and headdress   (+20..40)
 *   much darker than it       -> her hair and shorts       (-80..-150)
 *   chroma shifted            -> her skin and bark cloth
 *   moderately darker, neutral-> her cast SHADOW (-10..-44), which is backdrop
 *
 * An unsigned matte cannot make that last distinction and leaves a grey smudge beside
 * her hip.
 *
 * THE LIFT IS ADDITIVE, NOT A CLIP, and that is the part that took two attempts. Clipping
 * the backdrop to pure white inside a hard-thresholded matte looks perfect on a still and
 * SHATTERS ON MOVEMENT: a motion-blurred headdress horn is a blend, pixel =
 * a*straw + (1-a)*backdrop, so it barely differs from the plate, the threshold calls it
 * backdrop, and the horn breaks into white speckles. Measured on the dance's fastest frame
 * (t=29.56s), it is obvious.
 *
 * Instead:  out = in + (WHITE - plate), with WHITE - plate precomputed as a static image.
 *
 *   clean backdrop -> exactly WHITE, whatever the vignette was (measured spread falls
 *                     from 31 levels to 7)
 *   a shadow of depth d -> WHITE - d, so the shadow SURVIVES rather than being erased
 *   a mis-matted pixel  -> merely brightened, not destroyed
 *
 * and the ramps are wide rather than hard, so a blurred pixel gets partial alpha roughly
 * proportional to its coverage — which is what compositing wants, and keeps the horn
 * continuous. The morphological close is gone for the same reason: it re-thresholded soft
 * gradients back into fragments.
 *
 * WHITE IS 240, NOT 255, AND THAT IS DELIBERATE. Her dance was exported at 5.5 Mbit/s for
 * 2160x3840 at 50fps — about a quarter of what that format needs, and half what her own
 * walk (11.2) and idle (9.0) got. At that bitrate the headdress breaks into DCT blocks
 * whenever she moves fast; the fragments are in the SOURCE PIXELS, plainly visible in the
 * ungraded clip, so no amount of matte work removes them (deblock and hqdn3d were both
 * tried and changed nothing). Lifting the backdrop to pure white simply stops hiding them.
 * Landing on 240 keeps the contrast between those blocks and the backdrop low enough that
 * they stop reading as a ghost, and costs nothing that matters: on a white box 240 still
 * reads as white. A higher-bitrate re-export of the dance is the only real fix.
 *
 * Both inputs are scaled to the OUTPUT size before the matte is built. Doing the matte
 * at full 4K was tried and is identical to the eye but runs at 0.8 fps — about 55 minutes
 * for her three clips, which is far too slow to iterate on a grade. At 1296x2304 the
 * headdress straw is still 9-15 px wide, so nothing the matte needs is lost. The two blur
 * radii below are the 4K values scaled by the same 0.6 factor.
 *
 * NOTE the `shortest=1` on every blend that takes a plate stream. The plate is fed with
 * `-loop 1`, so it never ends, and blend's framesync default is to run until ALL inputs
 * are EOF — which means the graph keeps emitting frames forever after the clip finishes.
 * `-shortest` on the output does NOT save you here, because there is only one output
 * stream for it to compare. Without this the walk clip encoded to 26 MB and climbing.
 * ------------------------------------------------------------------------- */

const LIFT = {
  // Soft, roughly PROPORTIONAL ramps. For a motion-blurred pixel the difference from the
  // plate is roughly proportional to its coverage, which is exactly the alpha compositing
  // wants, so wide ramps keep a blurred horn continuous. Narrow ones shattered it.
  BR0: 5,  BR1: 26,    // brighter than plate -> her pale straw
  DK0: 60, DK1: 120,   // darker than plate -> her hair/shorts, NOT her shadow (max 44)
  CH0: 4,  CH1: 16,    // chroma shift -> her skin; below 4 the backdrop's own noise shows
  WHITE: 240,          // what clean backdrop lands on. See the note on ghosting below.
};

const ramp = (a, b) => `lut=c0='if(lte(val,${a}),0,if(gte(val,${b}),255,255*(val-${a})/(${b}-${a})))'`;

/**
 * Inputs: 0 = the clip, 1 = the backdrop plate, 2 = the offset image (WHITE - plate).
 *
 * The lift is ADDITIVE and happens in RGB. In YUV it would add to the chroma planes too
 * and the whole frame comes out magenta; per-channel in RGB also neutralises the
 * backdrop's slight colour cast, since the plate is not exactly grey.
 */
function liftFilter(scale) {
  const k = LIFT;
  const s = `scale=${scale}:flags=lanczos`;
  return `[0:v]${s},split=3[base][tolift][vm0];
[1:v]${s},format=yuv444p[pm];
[2:v]${s},format=gbrp[off];
[vm0]format=yuv444p,split=2[vy][vc];
[pm]split=2[py][pc];
[vy]extractplanes=y,split=2[VY1][VY2];
[py]extractplanes=y,split=2[PY1][PY2];
[VY1][PY1]blend=all_mode=subtract:shortest=1,${ramp(k.BR0, k.BR1)}[mB];
[PY2][VY2]blend=all_mode=subtract:shortest=1,${ramp(k.DK0, k.DK1)}[mD];
[vc]extractplanes=u+v[VU][VV];
[pc]extractplanes=u+v[PU][PV];
[VU][PU]blend=all_mode=difference:shortest=1[DU];
[VV][PV]blend=all_mode=difference:shortest=1[DV];
[DU][DV]blend=all_mode=lighten,${ramp(k.CH0, k.CH1)}[mC];
[mB][mD]blend=all_mode=lighten[m1];
[m1][mC]blend=all_mode=lighten,gblur=sigma=2.0,negate[Mbg];
[tolift]format=gbrp[tl];
[tl][off]blend=all_mode=addition:shortest=1,format=gbrp[lifted];
[lifted][Mbg]alphamerge[lf];
[base]format=gbrp[bs];
[bs][lf]overlay=format=auto,format=yuv420p[out]`;
}

const BACKDROP_LIFT = [{
  /* Re-exported at ~100 Mbit/s, which is what finally cleared the headdress. The first
   * pass came from a 5.5 Mbit/s export and no amount of matte work could recover it.
   *
   * These are new cuts, and both now open AND close on an empty backdrop: the walk is
   * "walk in, stand, walk out" and the dance is "walk in, dance, walk out". That is what
   * lets the stage run them back to back with no fade — see `stageCycle` in content.json.
   *
   * The plate comes from the DANCE, not the walk: its empty head runs 3.5s against the
   * walk's 0.5s, so there are far more clean frames to average. The two backdrops were
   * checked corner by corner and agree to within one level, so one plate serves both. */
  id: 'maznah',
  root: join(STAGE, 'premiere file', 'maznah', 'high bitrate'),
  plateFrom: 'Dance.mp4',
  plateSeconds: 0.64,          // 32 frames at 50fps, deep inside its 3.5s empty head
  scale: '1296:2304',
  clips: [
    { from: 'Walk.mp4',  to: 'video/walk.mp4',  label: 'walk' },
    { from: 'Dance.mp4', to: 'video/dance.mp4', label: 'dance' },
  ],
}, {
  /* Her two talks, re-exported at ~105 Mbit/s like the walk and dance.
   *
   * They need their OWN plate and cannot capture one: she is seated in frame from the
   * first frame to the last, and the only unoccupied frames are dip-to-white transitions
   * between takes. The seated setup is also lit about 12% darker than the standing one,
   * so the walk/dance plate does not transfer — a single scale factor fits it only to
   * within 6.5%, and plate error goes straight into the output.
   *
   * So the plate is reconstructed by fitting the backdrop and extrapolating behind her
   * (tools/make-plate.py); the residual on clean backdrop is ~1.8 levels.
   *
   * Unlike walk and dance these carry speech, so `audio` keeps it. */
  id: 'maznah',
  root: join(STAGE, 'premiere file', 'maznah'),
  scale: '1296:2304',
  platePoly: [30, 90, 160, 260],
  plateFrom: 'Maznah profile high bitrate.mp4',
  clips: [
    { from: 'Maznah profile high bitrate.mp4', to: 'video/profil.mp4', label: 'profil', audio: true },
  ],
}, {
  id: 'maznah',
  root: join(STAGE, 'premiere file', 'maznah'),
  scale: '1296:2304',
  platePoly: [15, 45, 75, 120],
  plateFrom: 'Maznah product high bitrate.mp4',
  clips: [
    { from: 'Maznah product high bitrate.mp4', to: 'video/explain.mp4', label: 'explain', audio: true },
  ],
}, {
  /* Johnny Anak Berangan. Easier than Maznah in every respect that matters here: he is
   * standing in all four clips with the same framing, and the backdrop measures within
   * 2-4 levels across them, so ONE captured plate serves the lot — no polynomial fit
   * needed. His walk opens on about a second of empty studio, which is where it comes from.
   *
   * walk and idle carry a room-tone track that is dropped; the stage is silent for every
   * artist. The two talks keep theirs. */
  id: 'johnny',
  root: join(STAGE, 'premiere file', 'johnny', 'high bitrate'),
  plateFrom: 'johnny walk.mp4',
  plateSeconds: 0.64,          // 32 frames at 50fps, inside the ~1s empty head
  scale: '1296:2304',
  clips: [
    { from: 'johnny walk.mp4',           to: 'video/walk.mp4',    label: 'walk' },
    { from: 'johnny Idle.mp4',           to: 'video/idle.mp4',    label: 'idle' },
    { from: 'johnny Profile.mp4',        to: 'video/profil.mp4',  label: 'profil',  audio: true },
    { from: 'johnny Product explain.mp4', to: 'video/explain.mp4', label: 'explain', audio: true },
  ],
}];

function stageBackdropLift(only) {
  if (!BACKDROP_LIFT.length) return;
  console.log('\n=== backdrop lift ===');
  for (const job of BACKDROP_LIFT) {
    if (only && job.id !== only) continue;
    // Keyed by the clip it comes from. Without this, changing plateFrom silently
    // reuses the previous artist plate and the lift is computed against the wrong
    // backdrop — which is exactly what happened when these clips were re-exported.
    const plateKey = (job.platePoly ? 'poly-' : '') + job.plateFrom.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const plate = join(ROOT, '_source', `.plate-${job.id}-${plateKey}.png`);
    // keyed by WHITE: changing the lift must invalidate the cached offset image
    const offset = join(ROOT, '_source', `.offset-${job.id}-${LIFT.WHITE}.png`);
    const plateSrc = join(job.root, job.plateFrom);
    if (!existsSync(plateSrc)) { console.log(`  ! missing  ${job.plateFrom}`); continue; }

    if (FORCE || !existsSync(plate) || !existsSync(offset)) {
      let r;
      if (job.platePoly) {
        // This clip never shows an empty frame, so the backdrop is reconstructed by
        // fitting it and extrapolating behind her. See tools/make-plate.py.
        r = spawnSync('python', [join(ROOT, 'tools', 'make-plate.py'), plateSrc, plate,
          ...job.platePoly.map(String)], { encoding: 'utf8' });
        if (r.status === 0) {
          for (const line of (r.stdout ?? '').trim().split('\n')) console.log(`    ${line.trim()}`);
        }
      } else {
        r = run(FFMPEG, ['-v', 'error', '-y', '-t', String(job.plateSeconds),
          '-i', plateSrc, '-vf', 'tmix=frames=32', '-frames:v', '1', '-update', '1', plate]);
      }
      if (r.status !== 0) { console.log(`  ! plate failed\n${r.stderr}`); continue; }
      // WHITE - plate, per channel. Adding this to the clip lands clean backdrop on
      // WHITE everywhere and keeps a shadow of depth d at WHITE - d.
      const inv = `clip(${LIFT.WHITE}-val,0,255)`;
      const r2 = run(FFMPEG, ['-v', 'error', '-y', '-i', plate,
        '-vf', `format=rgb24,lut=r='${inv}':g='${inv}':b='${inv}'`, '-frames:v', '1', offset]);
      if (r2.status !== 0) { console.log(`  ! offset failed\n${r2.stderr}`); continue; }
      console.log(`  > plate    ${job.platePoly ? 'fitted from' : 'from the empty head of'} ${job.plateFrom}  (+ offset to ${LIFT.WHITE})`);
    } else {
      console.log(`  = plate    up to date`);
    }

    for (const c of job.clips) {
      const src = join(job.root, c.from);
      const dst = join(OUT, job.id, c.to);
      if (!existsSync(src)) { console.log(`  ! missing  ${c.from}`); continue; }
      mkdirSync(dirname(dst), { recursive: true });
      if (!FORCE && existsSync(dst) && statSync(dst).mtimeMs > statSync(src).mtimeMs) {
        console.log(`  = ${c.label.padEnd(6)} up to date`);
        continue;
      }
      process.stdout.write(`  > ${c.label.padEnd(6)} lifting + scaling… `);
      const t0 = Date.now();
      const r = run(FFMPEG, ['-v', 'error', '-y', '-i', src,
        '-loop', '1', '-i', plate, '-loop', '1', '-i', offset,
        '-filter_complex', liftFilter(job.scale), '-map', '[out]', '-shortest',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p',
        '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
        '-movflags', '+faststart',
        // the talks carry speech and must keep it; walk and dance are silent by design
        ...(c.audio ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k'] : ['-an']),
        dst]);
      if (r.status !== 0) { console.log(`FAILED\n${r.stderr}`); continue; }
      console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s  -> ${mb(statSync(dst).size).trim()}`);
    }
  }
}

function stageArtwork() {
  if (!existsSync(STAGE)) { console.log('  (no "outer assets" folder - skipping artwork)'); return; }
  console.log('\n=== artwork ===');

  for (const a of ARTWORK) {
    const src = join(STAGE, a.from);
    const dst = join(OUT, a.to);
    if (!existsSync(src)) { console.log(`  ! missing  ${a.from}`); continue; }
    if (!FORCE && existsSync(dst) && statSync(dst).mtimeMs > statSync(src).mtimeMs) {
      console.log(`  = ${a.to}`); continue;
    }
    mkdirSync(dirname(dst), { recursive: true });
    const filter = a.vf ?? (a.key ? `colorkey=${a.key}:0.10:0.04,format=rgba` : null);
    if (filter || a.args) {
      const r = run(FFMPEG, ['-v', 'error', '-y', '-i', src,
        ...(filter ? ['-vf', filter] : []), ...(a.args ?? []), dst]);
      if (r.status !== 0) { console.log(`  ! filter failed ${a.to}\n${r.stderr}`); continue; }
      const note = a.key ? `keyed ${a.key}` : filter ? 'filtered' : 're-encoded';
      console.log(`  > ${a.to}  (${note}, ${mb(statSync(dst).size).trim()})`);
    } else {
      copyFileSync(src, dst);
      console.log(`  > ${a.to}`);
    }
  }

  for (const m of MODELS) {
    if (m.fromDir) {
      const sdir = join(STAGE, m.fromDir);
      const ddir = join(OUT, m.toDir);
      if (!existsSync(sdir)) { console.log(`  ! missing  ${m.fromDir}/`); continue; }
      mkdirSync(ddir, { recursive: true });
      let n = 0;
      for (const f of readdirSync(sdir)) { copyFileSync(join(sdir, f), join(ddir, f)); n++; }
      console.log(`  > ${m.toDir}/  (${n} files)`);
    } else {
      const src = join(STAGE, m.from);
      const dst = join(OUT, m.to);
      if (!existsSync(src)) { console.log(`  ! missing  ${m.from}`); continue; }
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      console.log(`  > ${m.to}  ${mb(statSync(dst).size).trim()}`);
    }
  }
}

/* ---------- job table ----------------------------------------------------
 * Adding an artist means adding an entry here and one object in content.json.
 *
 *   silent: true   asserted from measurement (-91 dB), not assumption
 *   retag:  true   this source reports color_space=unknown and needs BT.709 stamped;
 *                  the step videos already carry correct tags, so they are left alone
 * ------------------------------------------------------------------------- */

const ARTISTS = [{
  id: 'samat',
  raw: 'Samat',
  jobs: [
    { from: 'SamatWalk.mp4',     to: 'video/walk.mp4',   silent: true,  retag: true,  label: 'walk' },
    { from: 'SamatIdle.mp4',     to: 'video/idle.mp4',   silent: true,  retag: true,  label: 'idle' },
    { from: 'SamatProfile.mp4',  to: 'video/profil.mp4', silent: false, retag: true,  label: 'profil' },
    { from: 'step/StepWau1.mp4', to: 'steps/01.mp4',     silent: false, retag: false, label: 'step 1' },
    { from: 'step/StepWau2.mp4', to: 'steps/02.mp4',     silent: false, retag: false, label: 'step 2' },
    { from: 'step/StepWau3.mp4', to: 'steps/03.mp4',     silent: false, retag: false, label: 'step 3' },
    { from: 'step/StepWau4.mp4', to: 'steps/04.mp4',     silent: false, retag: false, label: 'step 4' },
  ],
  subs: [{ from: 'Samat-ProfileSub.txt', to: 'video/profil.srt' }],
  posters: [
    // Menu card portrait, cropped from the idle clip rather than a screenshot.
    // The crop is tuned to the card's aspect so the figure fills it instead of
    // floating small inside a full 1080x1920 frame.
    { from: 'video/idle.mp4', at: 3, to: 'menu/portrait.webp', crop: '640:1120:220:400' },
    { from: 'steps/01.mp4',   at: 2,  to: 'steps/01.webp' },
    { from: 'steps/02.mp4',   at: 2,  to: 'steps/02.webp' },
    { from: 'steps/03.mp4',   at: 2,  to: 'steps/03.webp' },
    { from: 'steps/04.mp4',   at: 2,  to: 'steps/04.webp' },
  ],
  backdropFrom: 'video/idle.mp4',
}, {
  /* Norhaiza's masters come from "outer assets/norhaiza", not the Unity archive, so
   * this artist declares its own `root`. Same measured traits as Samat: portrait clips
   * untagged (retag), walk/idle audio silent at -91 dB (drop), steps already BT.709.
   * One difference: his step videos are 50 fps, not 25 — remuxing preserves that. */
  id: 'norhaiza',
  root: join(STAGE, 'old', 'norhaiza'),
  jobs: [
    { from: 'video/walk.mp4',   to: 'video/walk.mp4',   silent: true,  retag: true,  label: 'walk' },
    { from: 'video/idle.mp4',   to: 'video/idle.mp4',   silent: true,  retag: true,  label: 'idle' },
    { from: 'video/profil.mp4', to: 'video/profil.mp4', silent: false, retag: true,  label: 'profil' },
    ...Array.from({ length: 10 }, (_, i) => ({
      from: `steps/Step${i + 1}.mp4`, to: `steps/${String(i + 1).padStart(2, '0')}.mp4`,
      silent: false, retag: false, label: `step ${i + 1}`,
    })),
  ],
  subs: [
    { from: 'video/profile.txt', to: 'video/profil.srt' },
    ...Array.from({ length: 10 }, (_, i) => ({
      from: `steps/StepSub_${i + 1}.txt`, to: `steps/${String(i + 1).padStart(2, '0')}.srt`,
    })),
  ],
  posters: Array.from({ length: 10 }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    return { from: `steps/${n}.mp4`, at: 2, to: `steps/${n}.webp` };
  }),
  backdropFrom: 'video/idle.mp4',
}, {
  /* Third artist. Measured, and different from the first two in every respect that
   * matters to this script:
   *
   *   - 1296x2304, not 1080x1920. Same 9:16, so it fills the design canvas exactly;
   *     no letterbox, and the extra pixels are free detail on a 4K panel.
   *   - 50 fps throughout, not 25.
   *   - ALREADY bt709-tagged, so nothing needs retagging (retag: false everywhere).
   *   - walk and idle carry NO audio stream at all, rather than a silent one, so the
   *     `silent` flag is belt-and-braces; remux() drops nothing that is not there.
   *   - No Pembuatan steps and no subtitle files of any kind, so `subs` and `posters`
   *     are simply absent — the stage menu is built from what exists, so he gets three
   *     buttons instead of Samat's three and Norhaiza's three-with-steps.
   *
   * He also has a fourth long clip, Product Explain, which is a talk like the profile
   * but with a caption card scheduled over it. To this script it is just another remux.
   */
  id: 'bangie',
  root: join(STAGE, ZUL),
  jobs: [
    { from: '1 - Walk.mp4',           to: 'video/walk.mp4',    silent: true,  retag: false, label: 'walk' },
    { from: '2 - Idle.mp4',           to: 'video/idle.mp4',    silent: true,  retag: false, label: 'idle' },
    { from: '3 - Profil.mp4',         to: 'video/profil.mp4',  silent: false, retag: false, label: 'profil' },
    { from: '4 - ProductExplain.mp4', to: 'video/explain.mp4', silent: false, retag: false, label: 'explain' },
  ],
  backdropFrom: 'video/idle.mp4',
}, {
  /* Fourth artist. Only her two TALK clips are remuxed here — walk, idle and dance are
   * produced by stageBackdropLift above, which grades and scales them, so they are
   * deliberately absent from this table.
   *
   * Measured: 2160x3840 at 50 fps, colour-UNTAGGED (so retag, like Samat and Norhaiza
   * and unlike Bangie). Her profile and product clips were graded to flat white before
   * they reached us; the other three were not, which is the whole reason the lift exists.
   *
   * She is also the first artist with a SECOND idle — a dance — and the first whose
   * stage runs a full cycle rather than a single looping clip. See `stageCycle` in
   * content.json: walk in, idle twice, dance, and the dance ends with her walking off
   * exactly where the walk begins (measured SSIM 0.987), so the cycle closes on itself.
   */
  id: 'maznah',
  root: join(STAGE, 'premiere file', 'maznah'),
  /* Nothing to remux: both talks are produced by stageBackdropLift above, which grades,
   * scales and re-encodes them. Only the subtitles are staged here.
   *
   * ENGLISH ONLY. `profile BM.txt` and `product BM.txt` sit beside these and are
   * deliberately not used.
   *
   * These come from subs-new/, which tools/retime-subs.py produced by carrying the old
   * translation across to the re-cut videos. They are a STARTING POINT: every surviving
   * line is placed by audio match, lines whose audio was cut are gone, and the stretches
   * of new speech are marked with a placeholder for someone who can hear them. */
  jobs: [],
  subs: [
    { from: 'subs-new/profile EN.srt',         to: 'video/profil.srt' },
    { from: 'subs-new/product explain EN.srt', to: 'video/explain.srt' },
  ],
  backdropFrom: 'video/walk.mp4',
}, {
  /* Johnny. Every clip is produced by stageBackdropLift above, so there is nothing to
   * remux; this entry exists for the subtitles, the placeholder menu portrait and the
   * measured backdrop.
   *
   * THE MENU PORTRAIT IS A PLACEHOLDER cropped from his idle. No card, name plate or
   * button artwork has been delivered for him yet — he inherits the shared buttons, and
   * the menu will look plain beside the other four until his artwork arrives. */
  id: 'johnny',
  root: join(STAGE, 'premiere file', 'johnny'),
  jobs: [],
  subs: [
    { from: 'subs/profile EN.srt', to: 'video/profil.srt' },
    { from: 'subs/product EN.srt', to: 'video/explain.srt' },
  ],
  posters: [
    /* Cropped at the delivered cards' own aspect (749x1080 = 0.694), NOT at whatever
     * frames him best: `.artist-card__art` fixes the width at 430px and lets the height
     * follow, so a portrait of a different shape makes his card taller than the other
     * four and the carousel row stops lining up. Measured from the built 1296x2304 idle —
     * he stands head at y448, feet at y2010, body spanning x56..x932. */
    { from: 'video/idle.mp4', at: 4, to: 'menu/portrait.webp', crop: '1137:1640:0:400' },
  ],
  backdropFrom: 'video/walk.mp4',
}];

/* ---------- run ---------------------------------------------------------- */

const only = process.argv.find((a) => a.startsWith('--artist='))?.split('=')[1];
let totalIn = 0, totalOut = 0;
const report = [];

stageArtwork();
stageSequences();
stageBackdropLift(only);

for (const artist of ARTISTS) {
  if (only && artist.id !== only) continue;
  console.log(`\n=== ${artist.id} ===`);

  for (const job of artist.jobs) {
    const src = join(artist.root ?? join(RAW, artist.raw), job.from);
    const dst = join(OUT, artist.id, job.to);
    if (!existsSync(src)) { console.log(`  ! missing  ${job.from}`); continue; }
    mkdirSync(dirname(dst), { recursive: true });

    const inSize = statSync(src).size;
    if (!FORCE && existsSync(dst) && statSync(dst).mtimeMs > statSync(src).mtimeMs) {
      const outSize = statSync(dst).size;
      totalIn += inSize; totalOut += outSize;
      report.push([job.label, inSize, outSize, 'skipped']);
      console.log(`  = ${job.label.padEnd(8)} up to date`);
      continue;
    }

    process.stdout.write(`  > ${job.label.padEnd(8)} remuxing… `);
    const t0 = Date.now();
    const meta = remux(src, dst, job);
    const outSize = statSync(dst).size;
    totalIn += inSize; totalOut += outSize;
    report.push([job.label, inSize, outSize,
      `${meta.width}x${meta.height} ${meta.fps}fps${job.retag ? ' +bt709' : ''}`]);
    console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s  ${mb(inSize)} -> ${mb(outSize)}`);
  }

  for (const sub of artist.subs ?? []) {
    const src = join(artist.root ?? join(RAW, artist.raw), sub.from);
    const dst = join(OUT, artist.id, sub.to);
    if (!existsSync(src)) { console.log(`  ! missing  ${sub.from}`); continue; }
    mkdirSync(dirname(dst), { recursive: true });
    const r = convertSrt(src, dst);
    console.log(`  > subtitle ${sub.to}  (${r.cues} cues${r.note})`);
  }

  for (const p of artist.posters ?? []) {
    const src = join(OUT, artist.id, p.from);
    const dst = join(OUT, artist.id, p.to);
    if (!existsSync(src)) { console.log(`  ! missing  ${p.from}`); continue; }
    if (!FORCE && existsSync(dst)) { console.log(`  = poster   ${p.to} up to date`); continue; }
    mkdirSync(dirname(dst), { recursive: true });
    const vf = p.crop ? ['-vf', `crop=${p.crop}`] : [];
    const r = run(FFMPEG, ['-v', 'error', '-y', '-ss', String(p.at), '-i', src,
      ...vf, '-frames:v', '1', '-c:v', 'libwebp', '-quality', '88', dst]);
    if (r.status !== 0) { console.log(`  ! poster failed ${p.to}`); continue; }
    console.log(`  > poster   ${p.to}  ${mb(statSync(dst).size).trim()}`);
  }

  if (artist.backdropFrom) {
    const f = join(OUT, artist.id, artist.backdropFrom);
    if (existsSync(f)) {
      const c = backdropOf(f);
      console.log(`  > backdrop ${c}   <-- put this in content.json as "backdrop"`);
    }
  }
}

console.log('\n' + '-'.repeat(58));
for (const [label, i, o, note] of report)
  console.log(`  ${label.padEnd(9)} ${mb(i)} -> ${mb(o)}   ${note}`);
console.log('-'.repeat(58));
console.log(`  ${'TOTAL'.padEnd(9)} ${mb(totalIn)} -> ${mb(totalOut)}` +
  `   (${(100 - (totalOut / totalIn) * 100).toFixed(0)}% smaller)`);
