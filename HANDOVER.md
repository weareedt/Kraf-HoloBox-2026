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
substitute — those are compressed, graded, keyed derivatives. Those folders exist on one
machine. Get them onto a second physical disk; that is the largest single risk on the project
and pushing to GitHub does not reduce it.

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

| # | Artist | Craft | Has | Outstanding |
|---|---|---|---|---|
| 1 | Samat | Wau | Profil +srt, 1 product (3D model), 4 steps | walk→idle seam pops (0.871); product thumbnail is a screenshot crop |
| 2 | Norhaiza | Ukiran Halus | Profil +srt, 2 turntables, 10 steps +srt | keris-2 jumps 4× a turn; two info blocks are generated placeholders |
| 3 | Bangie | Tenunan Pua | Profil, Terangkan Produk, 5 image products | **several — see below** |
| 4 | Maznah | Anyaman Mah Meri | Profil +srt, Terangkan +srt, turntable with 3 hotspots | nothing known |
| 5 | Johnny | Parang Ilang | Profil +srt, Terangkan +srt, menu card and name plate | no Terokai Produk |

Measured 19 Oct 2026, not recalled: every `.srt` in the project was checked for coverage and
none has a gap over 12 s, so no talk has an unwritten passage left. The turntables were
checked for jumps and the looping clips for how well they close. Re-run those checks with
`tools/` after any re-cut — the numbers below came from them.

### Bangie — the one needing most attention

- **His idle loop does not close.** 0.900 SSIM where Johnny and Norhaiza score 0.99 — a
  visible jump every 8.9 s, in front of a visitor deciding what to tap. Needs a re-cut or a
  crossfade at the loop point. His walk→idle seam scores the same 0.900.
- **His footage is on a grey backdrop**, so the transparent panel will glow grey rather than
  reading as the artist floating. A grading or re-shoot issue, not something the page can fix.
- No subtitles supplied for either long clip; the band stays off until a `.srt` appears.
- His supers card and title block are both placeholders (`Text1.png`, "Motif ??? / Teknik ???").

### Samat — the walk-in pops into the idle

His idle loop itself is the best of the set (0.998), but the last frame of his WALK scores
only 0.871 against the first frame of that idle, so the stage twitches once as the visitor
arrives. Less corrosive than Bangie's, which repeats every 8.9 s, but it is the first thing
anyone sees of him. A re-cut of the walk's tail, or a short crossfade at that one seam.

### Norhaiza — keris-2 jumps four times a turn

Her first keris was repaired: `tools/close-loop.py` synthesised the one frame its capture
never shot, and it now steps evenly with a 1.3x wrap. **The second keris still has four**,
measured at 2.1-2.3x the median step — between frames 26/27, 27/28, 36/37, and at the wrap
75->00. The same tool fixes one missing frame at a join; three jumps in the middle of a turn
are more likely a capture that skipped, and worth re-exporting from the source before
patching frame by frame.

### Johnny — no Terokai Produk

Videos, subtitles, menu card and name plate are done and tested. He runs on the shared
Profil and Terangkan buttons.

**He has no Terokai Produk panel.** A first attempt was built from turntable captures of the
parang and then removed; it is to be redone from scratch to a fresh brief. Nothing of it is
left in the repo — no manifest `products`, no frames, no pipeline entries — so his menu
simply shows two buttons. Adding the panel later is the ordinary content operation: drop the
frames into the drop folder, add a `SEQUENCES` entry, and add a `products` array to his
manifest object. The button appears on its own, because the menu derives it from whether the
artist has any enabled products.

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
3. **Get the masters onto a second disk.** They exist on one machine only, and the Drive copy
   does not include them.
4. Chase the museum for **Bangie's re-cut idle** and **Bangie's subtitles** — both are
   blocked on someone else, so they are worth starting early.
5. Re-export **Norhaiza's keris-2** turntable, which jumps four times a revolution. Needs the
   drop folder.
