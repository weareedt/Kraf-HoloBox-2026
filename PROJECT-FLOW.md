# Kraf HoloBox — how the project works

Start here. This explains what the thing is, how a visitor moves through it, and how content
gets from a camera card onto the screen.

- **`README.md`** — the deep reference. Why each decision was made, with the measurements
  behind it. Long, and worth skimming before any video work.
- **`HANDOVER.md`** — per-artist status, what is outstanding, and what to do first.
- **this file** — the flow, start to finish.

---

## 1. What it is

An offline touchscreen exhibit for **Muzium Kraf Kuala Lumpur**, running on a Windows laptop
that drives a roughly 2 m **portrait transparent-LCD showcase** — a "holo box". A real craft
object sits inside the case; the screen in front of it shows the artist and their work, so
the two read as one display.

It replaces an earlier Unity build. Everything is local: no internet, no server, no accounts.

- **Runtime:** Electron (bundled Chromium, version-pinned), with Google Chrome as a fallback
- **Design canvas:** 1080 × 1920 portrait
- **Launch:** double-click `start.bat`
- **Exit:** `Esc` from the main menu, or `Alt+F4`

---

## 2. What a visitor sees

```
MAIN MENU  — a self-driving carousel of artist cards
    |
    |  tap a card
    v
ARTIST STAGE  — the artist walks in, then loops idle on a white backdrop
    |
    +--> Profil            the artist talks about themselves (subtitled)
    +--> Terangkan Produk  the artist talks about the craft (subtitled)
    +--> Terokai Produk    explore the object: 3D model, turntable, or photographs
    +--> Pembuatan         step-by-step making-of videos
```

Every panel returns to the stage. **Three minutes of no touch returns to the main menu**, and
the countdown is suspended while a talk or a step video is playing, so a long video never
gets interrupted.

**The buttons are built from what the artist actually has.** An artist with no process videos
simply never grows a Pembuatan button — there is no empty state to design, and no code change
needed. That is the single most important idea in the project.

| Manifest has | Button appears |
|---|---|
| `video.profile` | Profil |
| `video.explain` | Terangkan Produk |
| `products[]` non-empty | Terokai Produk |
| `steps[]` non-empty | Pembuatan |

---

## 3. Artists are never uniform

**There is no shared template and there never will be.** Each artist is briefed individually
and the manifest describes that artist. Do not try to normalise them — the code is built to
absorb the differences.

Currently five:

| # | Artist | Craft | Product type |
|---|---|---|---|
| 1 | Samat | Wau (kite) | 3D model (FBX) |
| 2 | Norhaiza | Ukiran Halus (keris) | two turntables |
| 3 | Bangie | Tenunan Pua (weaving) | five photographs |
| 4 | Maznah | Anyaman Mah Meri (basketry) | turntable with hotspots |
| 5 | Johnny | Parang Ilang (blacksmith) | two turntables, uncropped, backdrop repainted |

Even the stage differs: most artists walk in once and then loop an idle clip, but Maznah has
no loopable idle, so her walk and dance alternate via an explicit `stageCycle` block.

---

## 4. How content reaches the screen

```
  outer assets/            <- masters land here (PSD, PNG, Premiere exports, camera files)
       |                      THIS FOLDER IS NOT IN THE REPO — see section 6
       |  npm run prepare-assets      (tools/transcode.mjs)
       v
  content/artists/<id>/    <- generated: graded video, WebP frames, subtitles, posters
       |
       |  content/content.json        the manifest, hand-edited
       v
  web/                     <- plain ES modules, no build step. Edit, reload, done.
```

**Adding or changing an artist is a content operation, not a code change.** No artist is
named anywhere in the JavaScript.

1. Drop the media into `outer assets/`
2. Add entries to the job tables at the top of `tools/transcode.mjs`, then
   `npm run prepare-assets`
3. Add one object to the `artists` array in `content/content.json`

`content/content.json` carries `_note_*` keys throughout — those are comments, and they are
worth reading. Nearly every non-obvious number in it was **measured rather than chosen**, and
the note says so.

---

## 5. Running it

```
npm install                   once — pulls Electron (needs Node >= 18)
start.bat                     the whole operating procedure
npm start                     the Electron app directly
npm run serve                 server only, then open http://127.0.0.1:8765
npm run prepare-assets        rebuild content/ from ../outer assets/
```

`http://127.0.0.1:8765/?cursor=on` shows the mouse pointer, which the kiosk hides.

| Key | Effect |
|---|---|
| `Esc` | any panel → main menu; from the main menu → quits |
| `F11` | fullscreen ⇄ 608 × 1080 portrait window |
| `Alt+F4` | quit |

### Tools you will need for media work

`ffmpeg` and `ffprobe`. Install with `winget install Gyan.FFmpeg`. Every tool finds them
automatically — PATH first, then the winget package folder — or you can point at them with
`KRAF_FFMPEG` / `KRAF_FFPROBE`.

Python 3 is needed for the tools in `tools/*.py`. They use **no third-party packages** — no
numpy, no PIL — because none were available on the original machine. If you add something,
keep that constraint or say so loudly.

---

## 6. What is NOT in this repository

| | Where it is | Why |
|---|---|---|
| **the video** — `content/artists/*/video/*.mp4`, `steps/*.mp4` | **`HoloBox-media` on Google Drive** | **4.9 GB, 32 files** (the subtitles and caption cards beside them ARE in the repo) |
| `outer assets/` — PSDs, PNGs, Premiere projects, camera masters | shared separately on Google Drive | ~35 GB |
| `_source/` — old Unity archive, pipeline caches | original machine | 4.7 GB |
| `node_modules/` | `npm install` | regenerable |

The repository is about **59 MB**: code, configuration, the manifest, UI artwork and the
docs.

### Where to get the two Drive copies

Both live on the EDT shared drive, in
**Shared drives › EDT PROJECT MASTER › EDT_2026 › KRAFTANGAN HOLOBOX › 04. PROJECTS**
(https://drive.google.com/drive/folders/10UXAlQP0QCr8Lr2t1KoAQ5T5MCfKBfQf). Ask EDT for access if a link will not open: they are not public files.

| | Link | Size | Updated |
|---|---|---|---|
| **`HoloBox-media.zip`** — the video, subtitles and caption cards, laid out like this repo | https://drive.google.com/file/d/1EfFQQ6eYLqWL2Ne0skg1237mAU0qu1C2/view?usp=drive_link | ~5.0 GB unzipped, 50 files | 22 Oct 2026 |
| **`outerassets/`** — the drop folder (masters, PSDs, Premiere projects) | the `outerassets` folder inside `04. PROJECTS`, link above | ~35 GB | kept in sync from the original laptop |

Unzip `HoloBox-media.zip` so that `HoloBox-media\` sits **beside** this repo, then copy its
`content` folder in as described below. Put `outerassets` beside the repo too, renamed to
`outer assets` (with the space), or point the pipeline at it with `--stage=` / `KRAF_STAGE`.

**`outer assets/` must sit beside the repo, not inside it.**

```
<anywhere>\
  HoloBox\          <- this repo
  outer assets\     <- the drop folder, a SIBLING
  HoloBox-media\    <- the video, a sibling too
```

`tools/transcode.mjs` resolves `../outer assets` from the repo root. When the project was
moved into a deeper folder once, that path stopped resolving and every job reported
`! missing` while the script still **exited 0** — a successful-looking run that built
nothing. The script now fails loudly instead, and `--stage=<dir>` or the `KRAF_STAGE`
environment variable overrides the location if you must put it elsewhere.

### Installing the video — do this first

Without it the exhibit loads but no clip ever plays. **The app checks on startup** and tells
you on screen exactly which files are missing, so you will not be left guessing.

It also checks each file's **size** against `content/media-sizes.json`. A copy that was
interrupted is worse than one that is absent: the file is there, the check used to pass, and
the visitor got a screen with a back button and no picture. This happened once — Johnny's
`explain.mp4` arrived 164 KB over length and would not decode a single frame. If the startup
screen says a file is the wrong size, delete it and copy it again. (A length test is not a
checksum; hashing 4.9 GB on every boot would be far too slow for a kiosk.)

`HoloBox-media` mirrors this project's folder structure on purpose, so nothing has to be
sorted by hand:

```
HoloBox-media/content/artists/samat/video/walk.mp4     ->   HoloBox/content/artists/samat/video/walk.mp4
```

Copy the **`content`** folder out of `HoloBox-media` into your `HoloBox` folder and merge:

```bat
robocopy "...\HoloBox-media\content" "...\HoloBox\content" /E
```

```bash
cp -r ".../HoloBox-media/content/." ".../HoloBox/content/"
```

Then reload. `HoloBox-media/README.md` has the same instructions and a file manifest.

> These are **generated** files, not masters. With the `outer assets` drop folder you can
> rebuild every one of them with `npm run prepare-assets` — the Drive copy just saves you
> hours of encoding.

**You can clone this and read everything, but you cannot rebuild media without
`outer assets/`.** Ask for the Drive link before starting any video, backdrop or turntable
work. The pipeline expects it one level above the repo:

```
KRAF/
  HoloBox/          <- this repo
  outer assets/     <- the drop folder
```

If yours lives elsewhere, point at it rather than moving it:

```
node tools/transcode.mjs --stage="D:/path/to/outer assets"
```

**Pushing to GitHub does not back up the masters.** They exist on one machine plus the Drive
copy. That is worth a second physical disk.

---

## 7. House rules

These are not style preferences. Each one is here because ignoring it cost real time.

**Measure, don't assume.** Probe media with `ffprobe` before writing job entries. Pixel-scan
a mock-up rather than reading coordinates off it. Check loop seams with the `ssim` filter.
The dangerous failures on this project were never crashes — they were *plausible* output:
"plate up to date" while grading against the wrong backdrop; "no new material found" on a
clip that had grown by 35 seconds; 26 PNG frames written successfully, all byte-identical.

**Cache keys must include their inputs.** A cache key that does not is a silent wrong answer,
not a stale file.

**When a filter produces suspiciously uniform output, dump the intermediate mask and measure
it** before touching any threshold.

**Check the loop on anything that loops.** For a turntable, the step from the last frame back
to the first must be the same size as every other step. Nothing else reveals a bad loop — it
is invisible until someone swipes the object on the real panel.

`README.md` holds the full catalogue of traps: S-Log3 footage, `rotation=90` side data,
`blend` framesync needing `shortest=1`, additive versus multiplicative backdrop lifts, and
why a colour key cannot separate a rosewood sheath from the wooden stand it rests on.

---

## 8. Before it goes on the real panel

1. Play a clip fullscreen and confirm `chrome://gpu` reports accelerated video decode. If
   Windows is rotating a landscape panel to portrait, the zero-copy path can drop out — the
   panel should report natively as portrait.
2. Put a CSS `#FCFCFF` area against a paused video frame and check no rectangle edge shows.
3. Watch the walk → idle handoff for a white or black frame.
4. Confirm pinch does not zoom the page and swipes do not navigate back.
5. Leave it running overnight — memory flat, parked on the menu.

**Kiosk machine:** auto-login; sleep, hibernate and screensaver off; Windows Update active
hours locked; notifications off; `start.bat` in Startup. If you ship the Chrome fallback
rather than Electron, **pin Chrome's version or disable its updater** — otherwise this runs
for eight months and dies on a Tuesday.
