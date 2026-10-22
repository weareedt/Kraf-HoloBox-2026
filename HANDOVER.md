# KRAF kiosk — handover

**For:** whoever picks this up next.
**What it is:** an offline HTML touchscreen exhibit for Muzium Kraf Kuala Lumpur's ~2 m
portrait transparent-LCD showcase, running in Electron on a Windows laptop. It replaces an
earlier Unity build.

This file is the map: how to run it, where things live, what state each artist is in, and
what is still outstanding. **`README.md` is the reference** — it explains *why* things are
the way they are and records the measurements behind every decision. When the two disagree,
this file is newer.

---

## 1. Run it

Double-click **`start.bat`**. That is the whole operating procedure.

| Key | Effect |
|---|---|
| **Esc** | any panel → main menu; **from the main menu → quits** |
| **F11** | fullscreen ⇄ 608×1080 portrait window |
| **Alt+F4** | quit |

For development:

```
npm install            once — pulls Electron 33.4.11 (needs Node >= 18)
npm start              the Electron app
npm run serve          server only, then open http://127.0.0.1:8765 in a browser
npm run prepare-assets        rebuild content/ from outer assets/
npm run prepare-assets:force  same, ignoring the "up to date" checks
```

`http://127.0.0.1:8765/?cursor=on` shows the mouse pointer, which the kiosk hides.

`start.bat` prefers the bundled Electron and falls back to Chrome. **Ship Electron**, not
Chrome: its Chromium is pinned and cannot update itself mid-exhibition. README → *Runtime*.

---

## 2. Read this before you touch anything

### Where everything lives

The repository is **`HoloBox/`** and nothing above it. The masters sit *beside* it, outside
the repo, so that the project can go to GitHub without dragging 35 GB along:

```
CLAUDE project/KRAF/
  HoloBox/          <- THIS REPO. 9.3 GB on disk, ~59 MB of it tracked by git
  outer assets/     <- 35 GB of supplied masters. NOT in the repo, never pushed
```

| | Size | In git? |
|---|---|---|
| `web/`, `server/`, `electron/`, `tools/`, `content/*.json`, docs | ~59 MB | **yes** — this is the repo |
| `content/artists/*/video/`, `steps/*.mp4` | 4.3 GB | no — rebuilt by the pipeline |
| `node_modules/` | 276 MB | no — `npm install` |
| `_source/` — old Unity masters, pipeline caches | 4.7 GB | no |
| `../outer assets/` — every supplied master | **35 GB** | no, and it is not even inside |

771 files and 58.7 MB are actually tracked, with nothing over GitHub's 100 MB per-file hard
limit. That was measured against the real tree, not assumed from the `.gitignore`.

**If you clone this from GitHub you cannot run `npm run prepare-assets`,** because its inputs
live in `../outer assets/` (and `_source/raw/` for Samat and Norhaiza), neither of which is in
the repo. You also will not have the prepared video until someone sends you `content/` or you
rebuild it. You can still:

- run and demo the exhibit,
- edit `content/content.json` — layout, timings, hotspots, button wording, which products
  appear,
- edit anything in `web/`.

You cannot re-encode video, re-key a backdrop, regenerate a turntable or add a new artist's
media without the drop folder. **If your job involves any of that, ask for `outer assets/`
before you start** — it is a separate transfer and it is large.

The pipeline finds it by going one level up from the repo. If your copy lives somewhere else,
point at it rather than moving it:

```
node tools/transcode.mjs --stage="D:/path/to/outer assets"
set KRAF_STAGE=D:/path/to/outer assets        (or export, on a shell)
```

It now **exits with an error** if the drop folder is missing. Before, the default resolved to
a path inside the project; when the folder moved out, every job reported `! missing` and the
run still exited successfully, which is the worst kind of failure this project produces.

### The masters are not backed up by GitHub

Pushing the repo backs up ~59 MB of code and configuration. It does **not** back up the 35 GB
of masters in `../outer assets/`, nor the 4.7 GB in `_source/`, and `content/` cannot
substitute — those are compressed, graded, keyed derivatives.

Since 20 Oct 2026, `outer assets/` is copied to the EDT shared drive by
`KRAF\sync-outer-assets.bat`, which sits beside the repo, not in it:

```
D:\CLAUDE project\KRAF\outer assets
  -> G:\Shared drives\EDT PROJECT MASTER\EDT_2026\KRAFTANGAN HOLOBOX\04. PROJECTS\outerassets
```

It runs one way and only adds: new and changed files go up, and **nothing is ever deleted on
the shared drive**, so a delete on the laptop cannot wipe the backup. Re-run it after adding
masters. It needs Google Drive for desktop running, and the upload carries on in the
background after the script finishes, so check the Drive tray icon before you trust it.
**`_source/` is still on one machine only.**

### Never hand-edit `content/`

It is generated. Change the source in `../outer assets/`, then run `npm run prepare-assets`.
The one exception is `content/content.json`, which *is* the hand-edited manifest — that file
is meant to be edited directly and is the main thing you can safely change without the drop
folder. Keep its `_note_*` keys; several are load-bearing explanations of odd-looking values.

### The panel is a transparent LCD, which inverts two instincts

Verified on the real hardware, and worth knowing before you grade anything:

- **White is not lit, so a white background already reads as empty.** The object appears to
  float inside the case with no keying at all. Keying white to alpha buys nothing there and
  costs edge quality on a soft silhouette. The earlier sequences are keyed anyway, because
  they were built before this was known and they look correct either way.
- **Black is the colour that definitely shows.** This is the one that bites. An alpha channel
  flattened to `yuv420p` on encode turns transparent padding into solid black bars across the
  case — the opposite of invisible.

Grey is the bad case: Bangie's footage sits on a grey backdrop, so the panel glows grey
instead of reading as the artist floating.

### Do not "improve" supplied artwork

If frames arrive with their own alpha, honour it. If they arrive with the table, the rotator
disc and the photographer's hands in shot, that is what ships until someone says otherwise.
Cropping or keying delivered frames unasked has been rejected more than once.

---

## 3. Layout

```
CLAUDE project/KRAF/
  outer assets/      the drop folder — masters go here first (35 GB, OUTSIDE the repo)
  HoloBox/           <- the repository starts here
    start.bat        double-click launcher
    package.json     scripts; Electron is the only dependency
    electron/        main.cjs (window, kiosk hardening), preload.cjs (quit bridge)
    server/server.js zero-dependency static server, port 8765, Range/206 support
    web/             the app itself — plain ES modules, no build step
      app.js         screen router, stage cycle, idle timer wiring
      app.css        all styling; design canvas is 1080×1920
      index.html
      screens/       menu, products, process (Pembuatan), hotspots
      viewers/       model (three.js/FBX), sequence (turntable), image, controls
      lib/           seamless-player, srt parser, loader, idle-timer
      vendor/three/  three.js r170, vendored and PINNED — leave it alone
    content/         GENERATED (4.4 GB, mostly git-ignored)
      content.json   the manifest — hand-edited, drives everything
    tools/           the asset pipeline (see §6)
    _source/         extracted masters from the old Unity archive (4.7 GB, not in git)
    README.md        the deep reference
```

**The repo is `HoloBox/` and nothing above it.** `outer assets/` is a sibling, not a child —
that is deliberate, so the project can be pushed without 35 GB of masters.

**No build step.** `web/` is served as-is. Edit a file, reload the page.

---

## 4. The architecture you need to know

**Artists are not uniform, and never will be.** There is no shared template. Each is briefed
individually and the manifest describes what *that* artist has. The code builds the UI from
capabilities, so an artist with no process videos simply never grows a Pembuatan button —
there is no empty state to design.

| Manifest has | Buttons shown |
|---|---|
| `video.profile` | Profil |
| `video.explain` | Terangkan Produk |
| `products[]` non-empty | Terokai Produk |
| `steps[]` non-empty | Pembuatan |

**Adding or changing an artist is a content operation, not a code change.** No artist is
named anywhere in the JavaScript.

1. Drop the media into `outer assets/`.
2. Add entries to the job tables at the top of `tools/transcode.mjs`, then
   `npm run prepare-assets`.
3. Add one object to the `artists` array in `content/content.json`.

> Steps 1 and 2 need the `outer assets/` drop folder, which is **not** in the Drive copy
> (§2). Step 3 alone works on what you have, and is enough to change how an existing artist
> behaves — reorder the menu, retime the stage cycle, move hotspots, relabel buttons, or hide
> a product by removing it from `products`.

The manifest carries `_note_*` keys throughout — those are comments, read them. Nearly every
non-obvious number in it was measured rather than chosen, and the note says so.

**The stage cycle** defaults to `[walk, idle]` looping on the idle, which is what most
artists need and requires no manifest entry. Maznah is the exception: she has no loopable
idle, so her walk and dance alternate via an explicit `stageCycle` block. README → *The stage
cycle*.

---

## 5. Where each artist stands

Status as signed off on 20 Oct 2026:

| # | Artist | Craft | Has | Status |
|---|---|---|---|---|
| 1 | Samat | Wau | Profil +srt, 1 product (3D model), 4 steps | **done** |
| 2 | Norhaiza | Ukiran Halus | Profil +srt, 2 turntables, 10 steps +srt | **done** |
| 3 | Bangie | Tenunan Pua | Profil, Terangkan Produk, 5 image products | **needs the most** — blocked on the museum's translation |
| 4 | Maznah | Anyaman Mah Meri | Profil +srt, Terangkan +srt, turntable with 3 hotspots | almost done — new Terokai Produk design, infotext |
| 5 | Johnny | Parang Ilang | Profil +srt, Terangkan +srt, 2 parang turntables with close-ups | mostly done — title block, infotext, blank frame 35 |

Measured 19 Oct 2026, not recalled: every `.srt` in the project was checked for coverage and
none has a gap over 12 s, so no talk has an unwritten passage left. The turntables were
checked for jumps and the looping clips for how well they close. Re-run those checks with
`tools/` after any re-cut — the numbers below came from them.

### Samat and Norhaiza — done

Both are accepted as finished. Two measured imperfections remain and were judged acceptable,
recorded here so nobody rediscovers them as new bugs:

- Samat's walk→idle seam scores 0.871 SSIM, so the stage twitches once as he arrives. His
  idle loop itself is the best of the set (0.998).
- Norhaiza's keris-2 turntable jumps at 2.1-2.3x the median step between frames 26/27,
  27/28, 36/37 and at the wrap 75->00. Keris-1 was repaired with `tools/close-loop.py`. Her
  two keris info blocks are generated placeholders.

Reopen either only if the museum asks.

### Bangie — the one needing most attention

**Her talks are in Iban.** Nothing can be edited or subtitled until **the museum supplies a
full translation** of both clips. Whisper's Malay model is no use here, and nobody on the
team can translate Iban, so that is the blocker for everything else on this list:

- **Re-edit the video** once the translation says what is being said where.
- **Subtitles** for Profil and Terangkan Produk. None exist yet, so the band stays off until
  a `.srt` appears. Time them to the audio as for the others (§6), with the museum's text
  as the words.
- **Infotext** for Terangkan Produk (see *Infotext* below). The current `Text1.png` on a
  5 s/5 s loop is a placeholder for the artwork *and* the timing.
- Her **idle loop does not close**: 0.900 SSIM where Johnny and Norhaiza score 0.99, a
  visible jump every 8.9 s. Fix it in the re-edit, or crossfade at the loop point. Her
  walk→idle seam scores the same 0.900.
- Her **footage is on a grey backdrop**, so the transparent panel will glow grey rather than
  reading as the artist floating. A grading or re-shoot issue, not something the page can fix.
- Her title block is a placeholder ("Motif ??? / Teknik ???").

### Maznah — almost done

Talks, subtitles, stage cycle and turntable all work. Two things are left:

- **Terokai Produk redesign, in progress.** Done 21 Oct 2026: the glow-ring markers became
  the lettered **A/B/C buttons** (top, side, bottom; ochre, 48 px) with a pulsing brown halo, and each
  zoom view now carries its **caption cards**, which scale in one by one every time it opens.
  README → *Product hotspots* has the details and the measured positions. Further pieces of
  the new design to follow, one at a time.
- **Infotext** during Terangkan Produk (see below). Waiting on the artwork and timings.

### Johnny — mostly done

Videos, subtitles, menu card and name plate are done and tested. He runs on the shared
Profil and Terangkan buttons.

- **Terokai Produk, first pass done (21 Oct 2026).** Two turntables, with sheath and bare
  blade, switched by the rail like Norhaiza's keris. Drag to turn, no zoom. Frames are never
  keyed to transparency or cropped; their photographed backdrop is **repainted opaque to the
  page's #EFEFEF** by `tools/replace-backdrop.py`, every frame checked, so the parang sits on
  the panel with no box. **ParangOnly35.png is blank as delivered** and is skipped (50 of 51
  frames). Ask for a re-export. README → *Johnny's parang turntables*.
  **Close-ups done (22 Oct 2026):** lettered A/B/C markers with captions, as on Maznah's
  basket — three on the sheathed parang, two on the blade. Still to come:
  - a designed title block: the title and meta are placeholder text for now.
- **Infotext** during Terangkan Produk (see below). Waiting on the artwork and timings.

### Infotext — planned, not built yet

Briefed 20 Oct 2026. **Not implemented: build it once the assets arrive.**

*Infotext* is a set of reference images ("supers") shown while an artist talks in
**Terangkan Produk**: pictures of whatever they are describing at that moment.

- **Who has it:** Maznah, Bangie and Johnny only. Samat and Norhaiza have none, and need no
  empty state, because the feature is driven by the manifest like everything else.
- **Assets:** several `.png` images per artist. For now there is only a basic placeholder.
- **Timing:** each image has its own start time and duration, e.g. *appears at 18 s, stays
  4 s, then hides*, measured against the explain video's own clock.
- **Position:** one fixed spot on screen, the same for every image and every artist. Images
  just appear and hide. No movement, and no layout per image.

**What already exists to build on:** `mountOverlay()` in `web/app.js` drives Bangie's
placeholder from the `explain.overlay` block in `content/content.json`. It already shows an
image over the talk, runs off the video's `currentTime` (so it stays in step if playback
stalls, with no timers to cancel), and is cleaned up when the visitor leaves. What it lacks
is a **list** of images with a start and duration each: today it is one image on a repeating
show/hide cycle. The natural extension is a manifest array along these lines, with the
overlay updating to whichever entry covers the current time:

```json
"infotext": [
  { "image": "artists/maznah/video/info-01.png", "atMs": 18000, "showMs": 4000 }
]
```

Keep it a content operation (rule 1): no artist ids in the code, and an artist without the
array simply shows nothing. Get the timings from the person who briefs the artwork rather
than guessing from the audio, and check them against the subtitles once built.

---

## 6. The tools

All in `tools/`. `transcode.mjs` is the pipeline; the Python scripts are one-off helpers that
are kept because the problems recur.

**All of these need source media that is not in the Drive copy** (§2). They are documented
here so that whoever does get the drop folder knows what already exists and does not rebuild
it from scratch.

| Tool | Use it for |
|---|---|
| `transcode.mjs` | **the pipeline.** Job tables at the top: `ARTWORK`, `MODELS`, `SEQUENCES`, `ARTISTS`, backdrop-lift jobs. Idempotent |
| `merge-translation.py` + `split-cues.py` | **subtitles — the current method.** See below |
| `make-plate.py` | reconstruct a backdrop plate when no empty frame exists |
| `refine-stills.py` | grade ARW stills and key their backdrop to white |
| `close-loop.py` | synthesise the missing frame when a turntable does not come back round |
| `replace-backdrop.py` | repaint a turntable's backdrop to one flat colour, opaque, leaving the object's pixels untouched and checking every frame. Driven by `backdropFrom` in `transcode.mjs` |
| `media-sizes.mjs` | record each video's exact byte size into `content/media-sizes.json`, so the startup check can spot a damaged copy. Re-run and commit when the masters change |
| `retime-subs.py` | carry existing subtitles across a re-cut |
| `script-to-subs.py` | **superseded** — spreads a known script across measured speech |

### Subtitles: transcribe, do not spread

Subtitle Edit is installed with Whisper. Use **Const-me** with `large.bin` — it runs on the
RTX 2080 and does a 2½-minute talk in about a minute:

```
cd "%APPDATA%\Subtitle Edit\Whisper\Const-me"
main.exe -m Models/large.bin -l ms -osrt --prompt "<proper nouns>" -f talk.wav
```

Then `merge-translation.py` pairs a hand-written English translation with those measured
timings, and `split-cues.py` breaks long segments into readable cues.

Four things that will catch you, all learned the hard way:

- **Transcribe in Malay, translate by hand.** Whisper's own `--translate` mangles craft and
  Iban terms.
- **Prime `--prompt`** with proper nouns from the teleprompter PDF, or *kraf* comes back as
  "krab" and *Adiguru* as "adik guru".
- **Do not pass `-ml`.** It blanks every timestamp. Split afterwards instead.
- **Check the last cue against the audio.** Whisper hallucinates a "thank you" outro over
  trailing silence. It did this on both of Johnny's talks.

> The teleprompter PDFs are a *terminology* reference, not a record of what was said. Johnny
> paraphrases his, skips whole passages and points at the object instead of reciting. The
> first version of his subtitles was built by spreading the PDF across his speech and was
> confidently wrong. Always work from the audio.

---

## 7. Habits that keep this project out of trouble

**Measure, don't assume.** This is the one rule that has paid for itself repeatedly. Probe
media with `ffprobe` before writing job entries; pixel-scan mockups rather than reading
coordinates off them; check loop seams with the `ssim` filter. The dangerous failures on this
project were not crashes — they were *plausible* output: "plate up to date" while grading
against the wrong backdrop, "no new material found" on a clip 35 seconds longer.

**Cache keys must include their inputs.** A cache key that does not is a silent wrong answer,
not a stale file.

**Write scripts with an editor, not bash heredocs.** Heredocs mangle backslashes and quotes.
Build ffmpeg filtergraphs inside Python and pass them via `subprocess.run([...])` with no
shell — several hours were lost to a quoting bug that looked like a bad threshold.

**When a filter produces suspiciously uniform output, dump the intermediate mask and measure
it** before touching any threshold.

README has the full catalogue of traps — S-Log3 footage, `rotation=90` side data, `blend`
framesync needing `shortest=1`, additive vs multiplicative backdrop lifts. Skim it before
doing video work; every entry is there because it cost a day.

---

## 8. Before it goes on the real panel

1. Play a clip fullscreen and confirm `chrome://gpu` reports accelerated video decode. If
   Windows is rotating a landscape panel to portrait, the zero-copy path can drop out — the
   panel should report natively as portrait.
2. Put a CSS `#FCFCFF` area against a paused video frame and check no rectangle edge shows.
3. Watch the walk→idle handoff for a white or black frame.
4. Confirm pinch does not zoom the page and swipes do not navigate back.
5. Leave it running overnight — memory flat, parked on the menu.

**Kiosk machine:** auto-login; sleep, hibernate and screensaver off; Windows Update active
hours locked; notifications off; `start.bat` in Startup. **Pin Chrome's version or disable
its updater** if you ship the Chrome fallback — otherwise this runs for eight months and dies
on a Tuesday.

---

## 9. First things to do

1. **Run it.** `npm install` if `node_modules/` was not included, then `start.bat`. Confirm
   all five artists load, both talks play with subtitles, and the turntables spin. That tells
   you the Drive copy arrived intact.
2. **Decide whether you need `outer assets/`** (§2). If your work touches video, backdrops,
   turntables or a new artist, request that transfer now rather than discovering the gap
   mid-task.
3. **Check the masters backup.** `outer assets/` syncs to the shared drive (§2); `_source/`
   still exists on one machine only.
4. Chase the museum for **Bangie's full Iban translation**. Her re-edit, subtitles and
   infotext all wait on it, so start early.
5. Collect the outstanding artwork: **Maznah's new Terokai Produk design**, **Johnny's
   Terokai Produk brief**, and the **infotext PNGs and timings** for Maznah, Bangie and
   Johnny. Then build infotext (§5).
