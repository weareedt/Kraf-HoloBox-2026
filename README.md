# KRAF — Muzium Kraf Kuala Lumpur kiosk

Offline HTML touchscreen experience for the museum's ~2 m portrait transparent-LCD
showcase. Replaces the previous Unity build ("KRAF-StellarLink").

> **New here? Read `PROJECT-FLOW.md` first.** This file is the deep reference — why each
> decision was made and the measurements behind it.

> **The video is not in this repository.** 4.9 GB across 32 files, shared as `HoloBox-media`
> on Google Drive. Copy its `content` folder into this project and merge; the structure
> mirrors this one so every file lands where it belongs. The app checks on startup and names
> anything missing. See `PROJECT-FLOW.md` → *What is NOT in this repository*.

## Running it

Double-click **`start.bat`**. **Alt+F4** exits, **F11** toggles fullscreen ⇄ a 608×1080
portrait window.

```
start.bat              the only thing anyone needs to touch
npm start              the Electron app directly (dev)
npm run serve          just the server, to open in a browser (dev)
```

Dev tip: `http://127.0.0.1:8765/?cursor=on` shows the mouse cursor, which the kiosk hides.

### Runtime: Electron, with Chrome as a fallback

`start.bat` runs the bundled **Electron** app if `node_modules/` is installed, and falls back
to Google Chrome if not. Both run the identical web app — same server, same `web/` files.

Electron is the one to ship, for reasons that are all operational rather than technical:

| | Electron | Chrome |
|---|---|---|
| Chromium version | bundled, pinned, cannot self-update | updates itself; can break the exhibit on a Tuesday |
| Browser UI | none at all | Translate bar, restore-session bubbles, address bar in some modes |
| Window control | exact size, guaranteed F11 | fights the browser for keys; `--kiosk` swallows F11 entirely |
| Dependency | none — Chrome need not be installed | Chrome must be present and findable |
| Display sleep | held awake by the app | needs Windows power settings changed |

The web stack itself was never the risk: three.js loads the FBX, `<video>` plays the footage,
everything is local and offline. The risk was *Chrome as the runtime*, and that is what
Electron removes. Nothing about the content pipeline changes.

If you ever want a single distributable `.exe`, add `electron-builder`; the app is already
structured for it (`main` → `electron/main.cjs`).

**`ELECTRON_RUN_AS_NODE`**: some hosts (VS Code especially) export this, which silently makes
Electron run as plain Node so no window ever appears. `start.bat` clears it.

---

## The `outer assets/` drop folder

**It lives OUTSIDE this repo, beside it:**

```
CLAUDE project/KRAF/
  HoloBox/          <- this repo, the thing that goes to GitHub
  outer assets/     <- 35 GB of masters, deliberately not in the repo
```

New artwork, models and footage go in **`outer assets/`** first. `npm run prepare-assets`
copies and converts them into the served `content/` tree under stable names, so the whole
asset pipeline is reproducible instead of being a pile of manual copies.

`tools/transcode.mjs` resolves it one level up from the repo, and **exits with an error if it
is not there**. Override with `--stage="D:/path/to/outer assets"` or `KRAF_STAGE` if the
masters live elsewhere. The guard exists because the drop folder used to be *inside* the
project: when it moved out, the default silently resolved to a path that did not exist, every
job printed `! missing`, and the run still exited successfully.

Layout: shared UI and Samat's art in **`outer assets/images/`**; each later artist in their own
folder (**`outer assets/norhaiza/`**). An artist whose masters do not come from the old Unity
archive declares its own `root` in the job table.

**Placeholders to replace:** `outer assets/norhaiza/menu/18 Keris 1 Info.png` and
`19 Keris 2 Info.png` are the keris title blocks, generated as stand-ins and marked
"PLACEHOLDER - replace me". Drop the designed images over them (same names) and run
`npm run prepare-assets`.

**Johnny has no artwork at all yet** — no menu card, no name plate, no stage buttons. He runs on
the shared buttons and on a placeholder portrait cropped from his own idle clip, so his card is
the only one in the carousel with no name printed on it. To finish him: drop `card.png` and
`nameplate.png` into `outer assets/premiere file/johnny/menu/`, add them to his `posters`/
`ARTWORK` entries, and add `menuCard` and `menuPlate` to his manifest object.

The job tables live at the top of `tools/transcode.mjs`:

- `ARTWORK` — UI images and menu art. `key: "0xFFFFFF"` keys a colour to transparency on
  the way in (the supplied logo ships on an opaque white box, which would otherwise show
  as a pale rectangle against the `#FCFCFF` backdrop). `vf` passes any ffmpeg filter chain.
- `MODELS` — FBX files and their texture folders.
- `ARTISTS` — the video/subtitle remux jobs.

Everything is idempotent; `npm run prepare-assets:force` rebuilds from scratch.

## Adding an artist

This is a **content operation, not a code change**. No artist is named anywhere in the
JavaScript.

1. Drop the artist's media into `outer assets/`.
2. Add entries to the job tables in `tools/transcode.mjs`, then `npm run prepare-assets`.
3. Add one object to the `artists` array in `content/content.json`.

That's it. The menu, the stage buttons, the carousel and the product rail all build
themselves from what the manifest says the artist has.

### Everything is optional

Only `id`, `name`, `video.walk` and `video.idle` are required. The stage button column is
derived from what's present — verified, not assumed:

| Manifest says | Buttons shown |
|---|---|
| profile + products + steps | Profil · Produk · Pembuatan |
| `"steps": []` | Profil · Produk |
| no `products` key | Profil · Pembuatan |
| `products[0].enabled: false` | Profil · Pembuatan |
| profile only | Profil |
| profile + explain + products, no steps | Profil · Terangkan Produk · Terokai Produk (Bangie) |
| profile + explain, `products` absent | Profil · Terangkan Produk (Johnny — his product assets are not ready, and the button will appear by itself when they land) |

An artist with no process videos simply never grows a Pembuatan button. There is no empty
state to design, because the button does not appear.

### Per-artist buttons and wording

`artist.ui` and `artist.strings` are layered over the shared `ui` / `strings` blocks, key by
key. Bangie uses both: she ships her own three stage buttons, because two carry labels no
other artist has, and relabels `products` to "Terokai Produk" so the accessible name matches
what is printed on the artwork. An artist who supplies neither keeps the shared set — Johnny
does, because no artwork has been delivered for him at all.

That is also why `explain` now lives in the **shared** `ui` block rather than only in Bangie's
and Maznah's overrides: an artist with a second talk and no artwork of their own still gets a
button. It cannot affect Samat or Norhaiza, because the stage builds its buttons from what the
artist *has*, and neither of them has an `explain` video.

### Talk videos (`profile`, `explain`)

Both are the same screen. A talk is a one-shot clip that holds the idle countdown, may carry
subtitles, and returns to the idle stage when it ends. `explain` exists because Bangie has a
second to-camera clip about the work rather than about himself; it sits between Profil and
the product panel.

`video.<clip>.overlay` puts a "supers" card over the picture on a repeating schedule:

```jsonc
"overlay": { "image": "…/explain-supers.png", "width": 900,
             "showMs": 5000, "hideMs": 5000, "startAtMs": 0 }
```

It is driven from the **video's own currentTime**, not a wall clock, so it stays in step if
playback stalls and there are no timers to cancel on the way out. Bangie's is a placeholder
in both respects — the artwork is `Text1.png` and the 5s/5s cycle is a stand-in. Maznah's
Terangkan Produk has real captions instead, so it runs a subtitle band and no supers.

### The main menu is a carousel

`web/screens/menu.js`. Same idiom as the Pembuatan carousel — absolutely-positioned cards and
a transform each — with three things that screen does not need. There is deliberately **no dot
row**: the menu is an attract loop, not a document with pages to count.

- **It wraps.** The card left of the first artist is the *last* artist, so the strip never
  hits an end. Each card's offset is the signed shortest distance round the ring, not
  `i − index`. This is why the menu no longer shrinks cards as the roster grows: with four
  artists the grid had them down to 380 px in two rows, and the carousel keeps the centre
  card at 430 px however many there are.
- **It drives itself**, at two different speeds, through the same code path — so a drift step
  and a tap are the same movement, just timed differently. Self-driving uses a **5.3 s** glide
  per artist with `linear` easing that spans the whole interval, so the strip is always gently
  in motion rather than snapping and sitting still. A tap, a swipe or settling after a touch
  uses **420 ms**. It only runs while the menu is the visible screen.
- **It has two looks**, and switching between them is itself animated. Left alone it shows
  *every* artist at full size and full opacity, packed as closely as they go — a showcase
  gliding past. The moment somebody touches it, the selected artist is lifted out of the row:
  neighbours drop to 0.68 scale and 0.72 opacity, and the row tightens. The change of look
  rides along with the movement, so the row opens out as the drift resumes.

#### The spacing is derived, not chosen

The card artwork measures **418 px of visible width** at full size — and it is the *name
plate*, not the portrait, that is widest. Both carry transparent glow margins, so the element
box is wider than anything you can see; measuring the box would give the wrong answer. From
that one number:

| | | |
|---|---|---|
| auto | two cards at full size | 418 + 22 px gap = **440** |
| manual | one full, one at 0.68 | 209 + 142 + 9 px gap = **360** |

Anything smaller overlaps. Verified in the running app: 22 px and 9 px of clear space between
visible edges, in both modes.

#### A card with no name plate

`menuCard` and `menuPlate` are both optional: the art falls back to `menuPortrait`, and the
plate is skipped entirely if its file is missing. Johnny ships this way, because no card or
name plate has been delivered for him — his card is a bare portrait with no name on it.

The trap is that **`.artist-card__art` fixes the width at 430 px and lets the height follow**,
so the portrait's aspect ratio sets the card's height. The delivered cards are all 749×1080
(0.694 → 620 px tall); a portrait cropped to frame the artist nicely came out at 0.567, which
would have made his card 758 px tall and knocked the carousel row out of line. His placeholder
is therefore cropped **at the cards' aspect, not at whatever frames him best**.
- **Tapping is two-stage** — see below. A tap on a side card only brings it to the middle;
  only a tap on the card already centred, with the carousel stopped, opens that artist.

#### Why it is a repeated track, not a ring of cards

The obvious build — one DOM element per artist, each given a position on a ring — **cannot
loop properly**, and that is worth recording because it was tried twice.

Three visible slots plus a staging slot either side need five positions. Four artists cannot
fill five, so one card always had to jump from the left edge to the right edge. Hiding that
jump is possible (fade it out, move it at opacity 0) but the exit still reads wrong: the card
*vanishes where it stands* instead of sliding away, and an earlier attempt that suppressed the
transition for one frame did not even manage that — restoring the transition inside a
`requestAnimationFrame` races the style recalculation of the transform set in the same block,
so the browser animated the jump anyway. That is why the fly-across appeared during the slow
drift and not during brisk manual taps.

So the strip is built from **repeated copies** of the artist list — `max(3, ceil(9/n))` of
them, 12 cards for four artists — long enough that the visible window never reaches either
end. Sliding is then just the window moving along the strip: every card moves exactly one slot
per step, out to the left and in from the right, and nothing ever jumps.

The loop is closed by shifting the window back one whole copy when it drifts too far. Because
the strip repeats with period `n`, that shift is pixel-for-pixel identical on screen, so it is
applied with transitions off and is genuinely invisible.

Three things that are load-bearing:

- **An instant layout must be committed before anything animates off it** (`void
  cards[0].offsetWidth`), or the browser coalesces the two and animates from the old position
  — which is the loop shift becoming visible as a long slide.
- **The card's `transform` belongs to the carousel**, so the press feedback scales an inner
  wrapper. An `:active { transform: scale(...) }` on the card itself would drop the translate
  and stack every card in the middle of the screen.
- **A touch has to pin the current position before retiming.** Changing `transition-duration`
  does not retime a transition already running, so a touch during the glide would leave the
  strip creeping for the rest of it. `settle()` re-lays-out at the current fractional offset
  with transitions off, then runs to the nearest artist at the manual speed. The scale and
  opacity curves are piecewise-linear in `|d|` precisely so that, under `linear` easing, the
  browser's interpolation equals the function and pinning reproduces exactly what is on screen.

#### Choosing an artist takes two taps while it is moving

A card that merely *looks* like a neighbour may already be the selected one, because the
selection runs ahead of the glide. Tapping it would open an artist the visitor never chose —
which is exactly what happened in testing.

So the first touch while drifting **never opens anything** — its click is swallowed. It does
still honour *which* card it landed on:

| touch, while drifting | result |
|---|---|
| on a side card | that artist comes to the middle |
| anywhere else | the nearest artist comes to the middle |

Choosing then takes a second, deliberate tap: on the centre to open that artist, on a side
card to bring it in. Once stopped it behaves normally until 3 s of stillness restarts the
drift.

Verified by sampling every animation frame and flagging any *visible* card whose x increases:
during a forward step every visible card must move left, so rightward motion is the artefact.
Across ~1,600 frames of auto drift and manual stepping there are none, and the visible span
reaches ±713 px — proof that cards slide fully out and in rather than fading in place.

### The stage cycle

What the stage plays is an ordered list, not a clip plus a loop. Most artists are the
degenerate case — `[walk, idle]`, repeating from index 1 — and that is what `stageCycle()`
in `app.js` builds when the manifest says nothing, so Samat, Norhaiza and Johnny need
no entry at all. (Bangie has one since 22 Oct 2026, to cross-dissolve an idle that does not
loop; see *Bangie's refined footage*.) Johnny's measured seams are 0.990 both for walk END → idle START and for the
idle's own loop — better than the 0.977 median of an ordinary one-frame step inside a clip, so
there is nothing for a crossfade to hide.

Maznah needs the general form. Her stage is **the walk and the dance alternating** — the two
together *are* her idle. Both clips open and close on an empty backdrop (walk in, stand, walk
out / walk in, dance, walk out), so the cycle is built out of arrivals and departures:

```jsonc
"stageCycle": {
  "steps": [{ "clip": "walk" }, { "clip": "dance" }],
  "loopFrom": 0,
  "resumeFrom": 0     // she walks back in; there is no standing clip to drop her into
}
```

One entry per play rather than a repeat count, so **every join stays individually tunable**.
Hers need no tuning at all, because empty-to-empty joins are invisible:

| Join | SSIM | |
|---|---|---|
| walk → dance | 0.979 | empty to empty, hard cut |
| dance → walk | 0.983 | empty to empty, hard cut |

For calibration, an ordinary one-frame step inside a clip scores a median of 0.977 — so both
joins are *better matched than a single frame of normal motion*, and need no fade. `blendMs`
cross-dissolves *into* a step and exists for the case where a future re-cut breaks that; `0`
(the default) is a hard cut, which is what the seamless player is for.

An earlier cut of this stage used a separate standing `idle` clip, played twice between the
walk and the dance. It was abandoned because none of those joins matched: the idle never
returned to its own opening pose (best loop point 0.8215, against 0.8174 for leaving it
uncut), so idle→idle and idle→dance both had to be cross-dissolved. Re-cutting the clips so
that each one *starts and ends on an empty frame* removed the problem entirely rather than
hiding it — which is the better fix, and worth remembering for the next artist.

One thing to watch: the empty heads and tails are dead time on the floor. Measured, the walk
is empty for its first 0.5s and last 1.0s, the dance for its first **3.5s** and last 1.0s —
so the box stands empty for about 4.5s between her walking out of the walk and back into the
dance, and 1.5s the other way round. Trimming the dance's head is a one-line change if that
pause reads as too long.

### Subtitles

`"srt": null` (or omitted) means **no subtitle layer** — either the video has them burned
into the picture, as Samat's four step videos do, or it has none. Set a path and the band
turns on for that video only. It is a per-step field, so an artist can mix both.

### Products

`type` selects the renderer; `controls` is independent of it, so a slider bound to
`rotation` drives a 3D model exactly as well as an image sequence.

- `"type": "model"` → three.js + FBXLoader (`web/viewers/model-viewer.js`)
- `"type": "sequence"` → pre-rendered turntable (`web/viewers/sequence-viewer.js`), e.g. Norhaiza's keris
- `"type": "image"` → one hi-res photograph (`web/viewers/image-viewer.js`), e.g. Bangie's cloth

`artist.productsLayout` names a CSS block for the panel's geometry (currently `"explore"`).
The panels genuinely differ — the Wau and the keris are objects centred in the free space
between the buttons, while Bangie's cloth is a full-height picture with its title top-right —
so this is a stylesheet block plus one string, not a new screen.

#### Five views of one object

Bangie's Tenunan Pua is five `image` products, not one product with five variants. Each view
is its own product, so the existing switcher rail gives the pressed/disabled behaviour and the
swap fade for free. The five images are progressively closer crops, which is why the panel
declares `"controls": []` — the zoom **is** the switch, and there is nothing to pinch.

---

## The Wau model — four things that were not obvious

The Wau is in and working. These were all established by probing the real files, and any of
them will silently break the kite if changed. There is a diagnostic page at
`/fbx-probe.html` (not linked from the app) that dumps meshes, clips, materials and texture
requests for any FBX — use it when the next artist's model arrives.

1. **Textures are referenced by bare filename** (`layer5 wau.png`), so without
   `model.resourcePath` pointing at the texture folder they resolve against the site root
   and 404. Filenames contain spaces; that is fine, they are URL-encoded.

2. **The `alphaMap` is a lie.** FBXLoader wires the *colour* texture in as the alpha map as
   well (`map.image === alphaMap.image`). alphaMap samples the **green channel**, so on a
   painted kite it crushes alpha to near zero and the entire mesh disappears. The PNGs carry
   real cutout alpha in a palette `tRNS` chunk, which `map` already provides. Hence
   `material.dropAlphaMap: true`.

3. **Textures arrive after the loader resolves.** `loadAsync()` returns before the images
   decode, and a texture with no image samples as alpha 0 — so anything drawn in that window
   is discarded. The viewer waits for the images before showing the model.

4. **One clip is not enough.** Blender exported every object × every action — 25 clips for 5
   objects — and each clip drives a single object. Playing clip 0 animates one layer and
   leaves the rest frozen. `animation.clips: "self-matched"` keeps only the clips whose
   object and action agree (`Layer 1|Layer 1Action`) and plays all five together.

The meshes are flat planes, so `material.doubleSide: true` forces every material
double-sided and the scene lights from front and back — the kite has to read correctly from
behind as well as in front.

### Materials are unlit

`material.unlit: true` swaps every material to `MeshBasicMaterial`. The textures are
painted artwork with the shading already in them, so lighting them again only adds
specular sheen the craftsman never put there and makes the kite darken as it turns away
from the key light. Unlit shows each texel exactly as painted, from both faces, at any
angle, and costs less to render.

### Turntable products (Norhaiza's keris)

`type: "sequence"` uses `web/viewers/sequence-viewer.js` — the same interface as the 3D viewer,
so the products screen and the control binder treat both identically.

- **Drag scrubs frames and loops.** The source is a full 360° turn, so the last frame sits next
  to the first and the wrap is seamless — one full turn of drag lands back on frame 0 exactly.
  (A viewer *can* declare `rotationLimits` to clamp instead; `controls.js` then clamps its own
  state so there is no dead zone after dragging past an end.)
- **Switcher buttons show pressed / unpressed.** The icon for the keris on screen is darker and
  at 90% size, and is *disabled*, so it cannot be tapped; only the other icon is live. The
  states swap on every switch. `select()` also ignores a request for the product already on
  screen — before this, tapping the active keris re-mounted it and the panel blinked.
- **Every mount starts on frame 0**, so switching keris (a re-mount) and leaving the panel (a
  dispose) both reset the frame with no extra bookkeeping. Switching paints the new keris in
  ~40 ms.
- **Memory.** One 76-frame turn is ~350 MB decoded even after cropping. Only the keris on screen
  is resident; `dispose()` calls `close()` on every bitmap rather than waiting for GC. Frame 0
  is painted before the rest load, so the panel never opens blank.
- `sequence.fitHeight` sets the size (0.68 matches the old app).

The source frames ship on **opaque white**, which would show as a pale box on the panel. The
build keys white to alpha at **similarity 0.06 — chosen by test**: 0.12 and above punch holes
through the specular highlights on Keris 1's silver sheath. It then crops every frame to the
union box over the whole turn (via `cropdetect` on the keyed alpha, so no frame is clipped).

### Maznah's Sungu Duri turntable

The same `sequence` viewer as Norhaiza's keris, with one product instead of two — so the
switcher rail never appears and the panel is the turntable alone. It **loops**: no
`rotationLimits` is declared, so dragging past the last frame wraps round to the first,
which is what a full 360° turn wants and what the keris does too.

126 frames at 1000x1150, exported from the colour-corrected product video. They arrive on
**opaque white**, so the same white-to-alpha key applies — without it the basket would sit
in a visible white box against the panel's #EFEFEF page. Keying was checked across
similarity values: holes start appearing inside the weave by 0.16, and the shared 0.06 is
clean. Cropping to the union box over the whole turn takes each frame from 1000x1150 to
**784x876**, which is what keeps the decoded set to ~345 MB rather than ~580 MB.

`fitHeight` is **0.37**, measured off the museum's own mark-up rather than chosen: an outline
drawn over a screenshot came to 24.8% of the canvas height, which is 0.37 of the 1280 px
viewport. The rendered basket measures 24.0% — close enough to call it a match.

**Drag to turn, nothing else.** Pinch-to-zoom was removed on 21 Oct 2026 at the museum's
request. The lettered A/B/C close-ups (below) are how a visitor sees detail. Removing the
`pinch` control removes every zoom path, because the desktop stand-ins (wheel and Ctrl+drag)
only exist for products that declare `pinch`.

Frame numbers run past 99, so the sequence declares `pad: 3` and the pattern is
`frame-{i:03}.webp`.

### Johnny's parang turntables — opaque, uncropped, backdrop repainted

Two turns of the same Parang Ilang, switched by the rail exactly as Norhaiza's keris are:
**with its sheath** (66 frames) and **the bare blade** (50 of the 51 delivered; see below).
The rail buttons are the supplied `FullParang Button.png` / `ParangOnly Button.png`, 316x357
with their own glow — the same size as the keris buttons, so they take the rail's
artwork-button path unchanged. Drag to turn, looping; no pinch and no zoom buttons. His stage
gains a Terokai Produk button using the artwork Bangie and Maznah share, so his three buttons
match.

**Never keyed to transparency, never cropped.** The keris and the basket go through a white key
and a union-box crop; these go through `asSupplied: true` on their `SEQUENCES` entries, which
keeps each 1080x2048 frame whole and opaque. Every frame measured alpha 255 (all 117), so they
encode as plain `yuv420p` WebP; the pipeline re-checks this each build and refuses to encode a
sequence carrying any transparency, because flattening real alpha turns it black, the colour
that shows on the panel. Memory is ~557 MB decoded for the sheathed turn and ~422 MB for the
blade, against ~350 MB for a cropped keris; only the parang on screen is ever resident.

**The backdrop is repainted to the page colour** (`backdropFrom: 'johnny'`, asked for on
21 Oct 2026). As photographed, each frame was a mottled grey photo rectangle with swirl marks
on a painted near-white surround, so the parang sat in a visible box on the #EFEFEF panel.
`tools/replace-backdrop.py` repaints everything that is not parang in Johnny's `backdrop` from
content.json. The frame stays opaque, and the drop-folder PNGs are only read: their checksums
were verified unchanged after the build. The repainted frames are cached in
`_source/.backdrop/` and rebuilt when the sources, the colour or the tool change.

How it protects the parang, and what each step was learned from:

- **Protect first, paint second.** Seed on pixels that are certainly parang (darker than 225, or
  coloured: chroma over 20, which is what holds the pale rattan); grow only into neighbours
  still distinctly not backdrop (darker than 238 or chroma over 13). Measured on the frame with
  the worst backdrop: the wall never goes below luma 240, the blade never above ~207.
- **Close the mask by 12 px.** The bare blade's spine is a pierced silver filigree almost as
  light as the wall. Without closing, only its dark piercings survived the thresholds, were
  dropped as dust, and the whole decorated spine was painted over — caught by checking, not by
  eye (ParangOnly 22 lost 381 px of piercings). Closing joins them to the blade. The cost: a few
  tiny pockets of original backdrop in tight concavities keep their colour, a few levels lighter.
- **Fill holes,** so highlights enclosed by the blade survive however light they are.
- **Drop anything touching the frame border** (the parang never reaches it). The photo
  rectangle's darker left edge on sheathed frames 25-30 had been kept as a second "parang" of
  37-66k px and showed as a light strip down the side.
- **Feather on the backdrop side only.** Every parang pixel is copied exactly. Blending the
  parang's own outer ring was tried first and softened its true edge by 100-200 px a frame.

**Every frame is checked, and the build fails if a check fails:** every parang pixel
byte-identical to the source; every backdrop pixel not touching it exactly the fill colour; at
least one parang left. Size jumps, extra components and removed specks are reported per frame
in `report.json`. Independently of the tool, each repainted frame was also compared with its
source for any pixel that changed by more than the backdrop could have (luma over 30): the
blade lost 0 px across 50 frames; the sheathed turn lost 112 px across 66, all of it a fixed
speck of dust on the backdrop and a mark in frame 00's corner. Contrast-stretched contact
sheets of all frames show a flat field around every parang. In the app, the frame's corners
decode to exactly 239,239,239, so there is no box.

**ParangOnly35.png is blank as delivered** — every pixel 253, no parang. Shipped as supplied, the
turn flashed an empty frame between 34 and 36 (the 3.7-4.2x step measured earlier). The build
skips it (`skip: [35]`, manifest `count` 50), so 34 -> 36 is one double step. When a
re-export arrives, remove `skip` and set the count back to 51.

Other measured unevenness, left as delivered: a 3.4x step at sheathed 30->31 (on inspection
the photographed backdrop changing brightness, now painted out anyway), and wraps of 2.4x and
2.6x, a slightly larger turn that is mild in use.

`fitHeight` is 0.95 of the viewport for the **whole** uncropped frame, which puts the parang,
about 68% of the frame's height, near the keris's size.

**The blade was shot off-centre.** Measured over all 50 repainted frames, its middle averages
x 627 of the 1080-wide frame (608..654), 87 px right of centre; the sheathed turn averages 543
and needs nothing. Since the frames are not cropped, the viewer centres the object rather
than the frame via `sequence.centreX` (source pixels; absent = the frame's middle). It shifts
the canvas by `(frameWidth/2 - centreX)` scaled to the drawn size, multiplied by zoom so the
object stays anchored when a product does zoom. Checked in the app: both parangs now land on
the same free-space centre.

Titles and meta are placeholders until a designed title block arrives.

**Close-ups (22 Oct 2026), Maznah's pattern unchanged.** Each parang declares its own
`hotspots`, and the products screen re-mounts them on every switch, so the rail swaps the
markers with the parang and no code was needed. Sheathed: A head (*Hulu*), B rattan binding
on the hilt (*Temurak*), C binding on the sheath (*Pusat Bedus*). Blade: A near the hilt
(*Butuh Kunding* motif), B the blade. The markers are the same A/B/C artwork as Maznah's, at
68 px rather than her 48, because that is their size in the museum's mock-ups. Their centres
were measured off those mock-ups (the ochre squares, scaled by the app page's width to 1080),
the caption positions off the Photoshop layouts by their straight strokes (every height
matched its PNG to within 2 px). The zoom views are 1334x2000 and opaque, like hers, so
`zoomSize` and the view box are shared. Checked in the app: each of the five markers opens
its view with its caption at the measured spot, scaling in over 0.2 s.

### Product hotspots (`web/screens/hotspots.js`)

Pulsing markers over a product, each opening a close-up. Maznah's basket has three — top,
side and bottom — and a tap anywhere closes the view again.

```jsonc
"hotspotArt": "…/hotspot.png",      // fallback marker, for a spot with no `button`
"hotspotSize": 48,
"zoomSize": [1334, 2000],           // the zoom images' native size; `info` x/y are in it
"hotspots": [
  { "id": "top", "label": "Bahagian atas", "x": 536, "y": 799, "image": "…/zoom-top.webp",
    "button": "…/btn-a.png",
    "info": [ { "image": "…/info-top-1.png", "x": 48, "y": 996 } ] }
]
```

`x` and `y` are the marker's **centre in design-canvas pixels** — the same numbers you read
off a screenshot, which is how these were set: the museum drew circles over a screengrab and
the positions were measured out of that image rather than nudged by eye. The markers are
fixed to the canvas, not to the turntable, so they stay put as the basket spins.

Three things are deliberate:

- **Every zoom image is mounted up front**, at opacity 0, and the overlay is never
  `display: none`. A hidden or not-yet-created `<img>` has nothing on the compositor, so the
  first tap would show a blank panel for as long as the decode took. Opacity and
  `pointer-events` do the hiding instead, so the fade always has a picture to fade to.
- **A marker is either finished artwork or a mask.** Since 21 Oct 2026 Maznah's markers are
  the museum's lettered squares, A, B and C running top to bottom (`button` on each spot).
  They are drawn as images at `hotspotSize` 48 (halved from 96 on request), with a rounded
  halo swelling out from behind while the face itself breathes 1 → 1.1. The halo runs from
  the caption cards' deep-brown stroke (#5E2207) out to the buttons' own ochre (#B6823D,
  measured off the recoloured artwork). It was amber against the first, dark-brown buttons;
  once the buttons went ochre, amber no longer stood apart, and dark is what reliably shows
  on the transparent panel. The halo is sized in proportion to the button, so changing
  `hotspotSize` scales the pulse with it. A spot with no `button` falls back
  to `hotspotArt`, the older white glow ring used as a `mask-image` over a coloured box, which
  is what lets its colour animate. An `<img>` could only have been faded.
- **The overlay paints nothing.** It is transparent and exists only to catch the tap that
  closes the view. Giving it a background — white or the page colour — was tried, and it makes
  opening a hotspot look like moving to another panel rather than laying a picture over the
  one you are on. The page, its title and the back button all stay visible behind it.
- **The zoom views stay OPAQUE**, which follows from that. The card's own white is what hides
  the spinning turntable underneath it. Keying the white to alpha was tried and is wrong here:
  the basket then shows through the gaps in the weave. (The turntable frames *are* keyed —
  different job, different answer.)

Their size is **730 x 1092, centred**, taken from the museum's own placement rather than
chosen: their mock-up is a 608x1080 document — the app's windowed size — in which the view
sits at 411 x 615, so 1080/608 scales it to 730 x 1092 on the design canvas. The box matches
the artwork's 0.667 aspect, so there is nothing to letterbox. At that size the card covers all
three markers, so they do not pulse around an open view.

The pulse is one CSS keyframe animation — 0.7s of movement then 0.3s of rest, looping, with
`ease-in-out` between each stop so the grow and the shrink both soften at the ends. Scale runs
1 → 1.2 and the colour crosses between `--hot-a` (#F59E23) and `--hot-b` (#C2691A). Because it
is keyframes rather than script, it keeps its timing whatever the main thread is doing. The
three markers are staggered 0.22s apart, or they pulse in lockstep and read as one flashing
block rather than three separate invitations.

#### Caption cards on the zoom views (`info`)

Each view can carry caption PNGs: the bottom view has two, the others one. The view and its
cards share one box that is laid out at the image's **native size** (`zoomSize`, 1334x2000)
and scaled down as a unit into the 730 x 1092 view box. So a card's `x`/`y` is its top-left
in the zoom image's own pixels, exactly as read off the museum's Photoshop layout, and the
cards stay registered to the picture whatever the view box becomes.

The positions were **measured, not eyeballed**: from screenshots of the layouts, the
document's on-screen width gave the zoom, and each card was found by its straight top and
bottom strokes. A colour mask alone does not work, because the weave contains the same brown.
Every measured card height matched its PNG to within 2 px, which is the cross-check.

On every open the cards scale in **0 → 1, linear, 0.2 s each, one after another**, from their
own centres (`INFO_MS` in `hotspots.js`), and play **once**: a single iteration, then they
hold at full size. Measured in the browser: the first card 0.08 → 0.83 over 48-188 ms, the
second 0.25 → 1 over 282-421 ms, both still at 1 three seconds later. This is the Web
Animations API rather than a CSS class, because it has to restart on every open: the
previous run is cancelled first, so going back and forth always replays it from scale 0. The cards sit above the picture and ignore taps, so tapping a card
still closes the view.

The artwork is staged from `outer assets/images/` (`button a/b/c.png`,
`zoom-<view> info<n>.png`) by `tools/transcode.mjs`, which renames it without spaces:
`btn-a.png`, `info-bottom-2.png` and so on.

### Zooming while you build it

A mouse has one pointer, so **pinch cannot be performed on a desktop** — which makes the
zoom impossible to check anywhere except the panel itself. Two additions give the same
control from a keyboard and mouse:

| | |
|---|---|
| wheel | zoom in / out |
| Ctrl + drag up/down | zoom in / out |

Both are additions, not replacements. Pinch is untouched, and they are only wired up for
products that already declare `pinch`, so nothing gains a zoom it was not given. On the
panel they are inert: a touchscreen sends no wheel events and has no Ctrl key.

Ctrl+drag also suppresses rotation for as long as Ctrl is held — otherwise testing the
zoom would spin the product at the same time.

### Single-image products (Bangie's Tenunan Pua)

An `<img>`, not a canvas: the browser decodes off-thread, downscales with its own filter, and
frees the pixels when the element goes. `decode()` is awaited so the swap fade only lifts onto
a picture that is ready to paint.

The masters are **27–33 megapixels each** (Image4 is 4680×7032) — about 126 MB of decoded RGBA
apiece, ~545 MB if all five were ever resident. They are only ever drawn into a 739×1461
design-pixel box, so even a 4K panel cannot show more than ~1490×2890 real pixels. The build
caps the long edge at **2400**, which keeps a comfortable margin and drops each to ~15 MB
decoded and ~1 MB on disk. Only the view on screen is resident.

### The Explore panel's geometry was measured, not judged

Every number in the `[data-layout="explore"]` CSS block came from scanning the museum's own
mockup (`Preview Product Explore (UI placement).png`) for ink, not from eyeballing it — and
eyeballing it got two of them wrong. The thumbnails look landscape and are actually **103 px
square**; the first one measures 93 px tall only because the mockup draws it in the *pressed*
state, which is the same 0.9 scale the keris rail uses. If the mockup changes, re-measure.

### Per-artist backdrop

Norhaiza's footage measures **#F4F4F9**, noticeably darker than Samat's #FCFCFF, which is exactly
why `backdrop` is per artist. The pipeline prints the measured value for each artist.

Bangie is the case that shows the limit of a single colour. Her studio backdrop is a **mid grey
with a vertical vignette** — ~#928E8A at the top, ~#B0A9A4 at the bottom — not a near-white flat
field. It never shows *behind* the video, because her footage is 1296×2304, exactly the 9:16
design canvas, so it fills the frame edge to edge; `backdrop` therefore only covers the instant
before a clip paints, and is set to white to match her Explore panel. But on the transparent
panel that grey is what the box will glow, so the artist will not read as floating the way
Samat and Norhaiza do. **That is a grading issue in the footage, not something the page can fix.**

### Lifting a grey backdrop to white (Maznah)

Her walk, idle and dance arrived ungraded — a grey studio backdrop with a heavy vignette,
measured #978E8B in the corners to #D1CAC4 at bottom centre — while her profile and product
clips had already been graded to a flat white and had to be matched.

**A colour key cannot do this, and the measurement says so plainly.** On the idle clip,
saturation′ (max−min of RGB) is **7** for the backdrop and **5** for her headdress straw:
the thing that must be kept is *less* saturated than the thing being removed. Luma is no
better — her straw skirt and the backdrop are both L≈180. Pushing a key hard enough to clear
the backdrop eats her face and the headdress. That was tried, photographed, and abandoned.

What works is a **difference matte** against a plate of the empty backdrop. The walk clip
opens on ~70 empty frames before she enters, so the plate is free; averaging 32 of them
removes sensor noise. Then the **sign** of the difference separates her from her own shadow:

| | vs. plate | verdict |
|---|---|---|
| her straw and headdress | **brighter** by 20–40 | subject |
| her hair and shorts | **darker** by 80–150 | subject |
| her skin and bark cloth | chroma shifted | subject |
| her cast shadow | darker by 10–44, neutral | backdrop |

An unsigned `|frame − plate|` matte cannot make that last distinction and leaves a grey smudge
beside her hip; raising its threshold to remove the smudge blows out her face. The signed
form separates all four cleanly.

#### The lift is additive, not a clip — and that is the part that took two attempts

The first version clipped the backdrop to pure white inside a **hard-thresholded** matte. It
is perfect on a still frame and **shatters on movement**: a motion-blurred headdress horn is a
blend, `pixel = a·straw + (1−a)·backdrop`, so it barely differs from the plate, the threshold
calls it backdrop, and the horn breaks into white speckles. On the dance's fastest frame
(t=29.56 s, found by scoring consecutive-frame SSIM) it is unmissable.

The fix is two changes:

```
out = in + (WHITE − plate)        WHITE = 240, the offset precomputed as a static image
```

- clean backdrop lands on exactly `WHITE` whatever the vignette was — measured spread falls
  from **31 levels to 7**
- a shadow of depth `d` lands on `WHITE − d`, so **the shadow survives** (measured 218–222
  against a 238–239 ground) instead of being erased
- a mis-matted pixel is merely brightened, not destroyed

#### Why WHITE is 240 and not 255

Headroom, so her cast shadow survives on the backdrop instead of being clipped away with it.
At 240 the shadow measures 218–222 against a 238–239 ground — clearly visible, at its full
original depth — and on a white box 240 still reads as white.

It also used to be doing a second job. The first cut of her walk/idle/dance was exported at
**5.5 Mbit/s for 2160×3840 at 50fps**, roughly a quarter of what that format needs, and at
that bitrate the headdress broke into DCT blocks on every fast move. Those fragments were in
the source pixels — `deblock` (weak and strong), `hqdn3d`, and widening the brightness ramp
from 5–26 to 14–40 all changed nothing, because the matte was classifying them correctly;
they really did differ from the plate. Lifting to pure white simply stopped hiding them.
**Re-exporting at ~100 Mbit/s fixed it completely**, which is the lesson: when a key exposes
something ugly, check the source bitrate before tuning the key.

**Both cached intermediates are keyed by what they depend on** — the offset image by `WHITE`,
the plate by the clip it is averaged from. This is not tidiness: when these clips were
re-exported and `plateFrom` moved to the dance, the run reported "plate up to date" and
quietly lifted the new footage against the *old* backdrop. A cache key that does not include
its inputs is a silent wrong answer, not a stale file.

and the ramps are **wide rather than hard**, so a blurred pixel gets partial alpha roughly
proportional to its coverage — which is exactly what compositing wants, and keeps the horn
continuous. The morphological close was removed for the same reason: it re-thresholded soft
gradients straight back into fragments.

Two traps worth knowing. The offset must be applied in **RGB**: in YUV it lands on the chroma
planes too and the whole frame comes out magenta.

> **Pin the RGB on the blend's OUTPUT side, not just its inputs.** This caught us a second
> time, long after the note above was written. ffmpeg negotiates pixel formats *backwards*
> from what the next filter wants, so `format=rgb24` on both inputs is necessary but not
> sufficient — with `format=yuv420p` immediately after the blend, the blend itself still ran
> in YUV. Measured on the backdrop: `blend,format=yuv420p` gives **rgb(255,117,255)**, while
> `blend,format=rgb24,format=yuv420p` gives rgb(247,250,247). A graph that ends in RGB (a PNG
> sequence, say) never shows the bug, which is why the frame exporter was fine while the
> video exporter rendered fully magenta.

And every `blend` that takes the `-loop 1`
plate needs `shortest=1`, because blend's framesync runs until *all* inputs are EOF and the
looped plate never ends — `-shortest` on the output cannot save you with a single output
stream. Without it the 4-second walk clip encoded to 26 MB and climbing.

The thresholds live in one `LIFT` object in `tools/transcode.mjs`. The chroma term is the
delicate one: at 4–16 her face survives, at 10–22 it blows out, and below 4 the backdrop's
own noise starts showing through.

#### The same lift, reused unchanged (Johnny)

Johnny's four clips went through this pipeline with **no new thresholds at all**, which is the
first evidence that the `LIFT` numbers generalise rather than being fitted to Maznah. His case
is easier in every respect that matters:

- all four clips share one backdrop within **2–4 levels**, so a single captured plate grades the
  whole set rather than needing one per clip
- his walk opens on ~1 s of empty backdrop, so the plate is free — no polynomial reconstruction
- he stands in all four with identical framing, and all four arrived at 105–115 Mbit/s, so none
  of the bitrate trouble above applies

Measured on the output: backdrop **236–240** with a 6–8 level spread, and the shattering check
(bright pixels enclosed by dark ones — the signature that broke Maznah's headdress) finds **16
stray pixels out of 52,098 dark ones, 0.03%**, on his fastest frame.

### Product footage is S-Log3 — it needs converting, not a contrast slider

Maznah's product turntable (`outer assets/premiere file/maznah/product rotate/`) was shot on a
Sony: `major_brand=XAVC`, 10-bit 4:2:2 HEVC at 212 Mbit/s. Every pixel of it sits between luma
68 and 141 with saturation ≈0 — the **S-Log3** signature, and why it looks flat and grey. The
correct fix is the published S-Log3 inverse to scene linear followed by the Rec.709 OETF:

```
cv = val × 1023/255
linear = cv ≥ 171.21 ? 10^((cv−420)/261.5) × 0.19 − 0.01 : (cv−95) × 0.01125 / 76.21
out    = linear < 0.018 ? 4.5 × linear : 1.099 × linear^0.45 − 0.099
```

A saturation boost stands in for the S-Gamut3.Cine → Rec.709 matrix. Unlike her own clips a
plain **saturation key works here**, because the wall is perfectly neutral and the basket is
vividly dyed; the dark knot on top is caught by a brightness term instead. The recipe is
`scratchpad/bakul.sh`.

Three things that cost time and are worth knowing before touching this footage again:

- The raw carries **`rotation=90` side data**, so it decodes as 2160×3840 portrait even though
  the stream says 3840×2160. Forcing it into a landscape `scale` silently squashes it, and
  every crop measured off that squashed frame is wrong.
- Hands enter the shot to start and stop the turntable. The clean window is **t = 11 s to
  37 s**; measure it by matte coverage in a right-edge strip rather than by scrubbing.
- `Bakul.mp4`, the 2.42 s cut, is an **8-bit** export of the 10-bit log master compressed to
  1 MB. Stretching 8-bit log bands badly, and the banding is strong enough that the key
  mistakes it for subject. Work from the raw.

### Reconstructing a backdrop plate (`tools/make-plate.py`)

The difference matte needs a **plate**: the backdrop with nobody in front of it. Her walk
and dance give one for free — both open on several seconds of empty studio. Her two talks
never do: she is seated in frame from the first frame to the last, and the only unoccupied
frames are dip-to-white transitions between takes.

The seated setup is also lit about **12% darker** than the standing one, so the walk/dance
plate cannot simply be reused. That was tested rather than assumed: a single scale factor
fits the two backdrops only to within 6.5%, and plate error goes straight into the output.

So the plate is reconstructed. A studio cyclorama under soft light is a smooth,
low-frequency field with no detail in it — exactly what a low-order 2-D polynomial
describes. The script masks out everything that is obviously not clean backdrop
(saturated, or dark), fits a degree-4 polynomial per channel to what remains, then marks
pixels sitting **below** that fit as her cast shadow, adds them to the mask and refits.

That last step is the one that matters: leave the shadow in the plate and the matte sees no
difference where it falls, so the lift erases the very shadow it is meant to preserve.

The fit residual on clean backdrop is printed — **1.8 levels median, 5.9 at p95** here. If
that number is ever large, the backdrop is not polynomial and this approach should not be
trusted.

### Cues too fast to read are widened at build time

Norhaiza's supplied profile had 20 of its 128 cues above 20 characters per second against a
median of 10.8 — the worst holding **51 characters for 0.80 s, about 64 ch/s**, roughly six
times her speaking pace. Samat's had the same fault. This is what showed up on the panel as
"a long line that was too quick".

`convertSrt` in `tools/transcode.mjs` fixes it on the way in, because the sources are
masters under `_source/` and should not be edited. Three passes:

1. **Take the dead air.** The cue grows into the gap after it, then the gap before it, never
   past a neighbour. This costs nothing — the line appears slightly earlier and lingers over
   silence. Norhaiza's file has 88.5 s of such gaps.
2. **Borrow from a neighbour with slack.** After pass 1 the worst cues are still boxed in by
   other cues rather than by silence. A neighbour sitting at 6 ch/s can give up time without
   becoming hard to read itself. Guards: never push the neighbour past the target rate, never
   leave a cue shorter than `SRT_MIN_SHOW`, never move a boundary by more than
   `SRT_MAX_STEAL`.
3. **Guarantee no overlap.** Also repairs defects already in the supplied files — Maznah's
   product talk shipped with a 20 ms overlap, around what was then a `### NEW SCRIPT ###`
   marker. Those markers have since been transcribed and filled.

| | before | after |
|---|---|---|
| Norhaiza profile, worst cue | 63.8 ch/s | **21.0** |
| Samat profile, worst cue | 42.2 ch/s | **28.2** |
| cues over 30 ch/s, all 16 files | 7 | **0** |

Some cues stay above the 20 ch/s target and that is correct: when a translated line is long
and the spoken segment is short, the only remaining fixes are shortening the text or letting
the subtitle overrun the speech. Neither belongs in an automatic pass.

### Carrying subtitles across a re-cut (`tools/retime-subs.py`)

When a talk is re-edited, the old translation is still correct for everything that survived.
Re-typing it risks losing the museum's wording.

> **Transcription is available now — prefer it.** When this was written there was no
> speech-to-text on the machine, which is what forced the envelope-matching below and the
> script-spreading in `script-to-subs.py`. Subtitle Edit has since been installed with
> Whisper and the `large` model (see **Transcribing the talks** below), so a new or re-cut
> talk should be transcribed from its own audio rather than matched or spread. These two
> tools remain for the case where the audio is unusable.

So the two soundtracks are matched instead. The script builds a loudness envelope of each,
correlates the old audio around every cue against the new audio, and moves the cue to where
its audio now sits. A cue whose audio is gone is dropped. Stretches of new speech that no
surviving cue covers are written out as explicit placeholders.

Results for Maznah's re-cut:

| | re-timed | dropped | new-script gaps |
|---|---|---|---|
| profile (274s → 310s) | 59 of 62 | 3 | 5, totalling ~39s |
| product (181s → 138s) | 33 of 46 | 13 | 3, totalling ~14s |

Those totals agree with the length changes, which is the sanity check that the alignment is
real rather than noise.

**The output is a starting point, not a finished file.** Every cue carries its correlation,
and anything below 0.85 is listed for a spot check. The placeholders say what they are and
can only be filled by someone who can hear the new lines.

Two bugs worth remembering, both of which silently produced *plausible* output:

- Flagging new material by "speech above a high percentile" missed 34 seconds of it, because
  the threshold sat above her quieter delivery. It is now a quarter of the way from the room's
  noise floor up to speech level.
- Requiring an **unbroken** run of speech found nothing at all, because the pauses between
  words break every run. The speech mask is now closed over 0.6s before runs are measured.

Both looked like "no new material found", which is exactly the kind of wrong answer to be
suspicious of when the clip got 35 seconds longer.

### Timing a known script against a recording (`tools/script-to-subs.py`)

> **Superseded for Johnny.** This produced his first subtitles and they were wrong, for a
> reason the method cannot detect: **he does not read the prompter.** He paraphrases it, drops
> whole passages and adds others, so spreading the script across his speech mislabels the
> audio no matter how well the spread is measured. See **Transcribing the talks** below for
> what replaced it. The tool is still correct for a genuine prompter read.

The opposite problem to the one above. Johnny's two talks arrived with **no subtitles at all**,
but with the teleprompter PDFs he read from — so the words were assumed known and only the
timings missing.

The method, for a single speaker reading a prompter at a steady pace:

1. build a loudness envelope and mark which parts are speech
2. measure how much **speech** time the recording contains, ignoring the pauses
3. give each cue a share of that speech time proportional to its character count
4. map those shares back to wall-clock, so the pauses fall between cues on their own
5. snap cue boundaries onto the pauses he actually took, where one is within 0.45s

Step 4 is what makes it work on a block-by-block prompter read: the long gaps between blocks
are skipped rather than handed to a cue, so cues do not drift the way they would if the script
were spread evenly across the running time.

| | cues | speech | boundaries snapped | median rate |
|---|---|---|---|---|
| profile (141.1s) | 34 | 124.5s | 6 of 33 | 13.2 chars/s |
| product (165.7s) | 46 | 138.7s | 3 of 45 | 13.0 chars/s |

**The median reading rate is the honesty check.** The method assumes a constant speaking rate,
so if the alignment had drifted, cues either side of the drift would show up as rate outliers.
Both files came in at 13 chars/s with no cue outside 0.45×–1.9× of it, and cue 3→4 of the
profile landed exactly on the measured 13.3s+2.4s pause.

Two parameters have to stay in the right relation, and getting it wrong looks like success:

- **`PAD` must stay below half the shortest pause worth preserving.** At 0.6s it closed his
  0.8–0.9s pauses, reported 95% speech, and collapsed step 4 back into a plain even spread. It
  is 0.25s.
- **Pause anchors are detected on the *raw* envelope, not the padded one.** Padding exists to
  stop word gaps counting as pause, so by construction it has already closed the shorter real
  pauses — detecting on the padded array found 8 pauses and snapped 1 boundary, where the raw
  envelope finds 19 and snaps 6.

A snap that would squeeze a cue below `MIN_CUE` is skipped: it is either the wrong pause, or
the right pause for a boundary that cue does not own.

### Transcribing the talks (`tools/merge-translation.py`, `tools/split-cues.py`)

**This is the method to use for any new or re-cut talk.** Everything above it exists because
there was no speech-to-text on this machine; there is now.

Subtitle Edit is installed, and with it three Whisper engines under
`%APPDATA%\Subtitle Edit\Whisper\`. Only two are usable: **Const-me** carries `large.bin`
(3 GB) and `medium.bin` and runs on the RTX 2080, and **Cpp** carries `medium.bin`.
Purfview's faster-whisper is installed but its `_models` folder is **empty**. Const-me with
`large` transcribes both of Johnny's talks in about two minutes:

```
main.exe -m Models/large.bin -l ms -osrt --prompt "<proper nouns>" -f talk.wav
```

Four things that matter:

- **Transcribe in Malay, translate by hand.** Whisper's own `--translate` is loose with craft
  terms and Iban words. Transcribing in `ms` and writing the English against that transcript
  keeps *kunding*, *gagung*, *pusat bedus*, *lemetak* and *Adiguru Kraf* intact.
- **Prime `--prompt` with the proper nouns** from the teleprompter PDF. Without it they come
  back as "krab" for *kraf*, "adik guru" for *Adiguru*, "Anabrangan" for *Anak Berangan*.
- **Do not pass `-ml`.** The max-length splitting does not redistribute timings — every cue
  comes back `00:00:00,000 --> 00:00:00,000`. Take the natural segments and split them with
  `split-cues.py`, which does redistribute.
- **Check the last cue against the audio.** Whisper hallucinates an outro over trailing
  silence. Both talks ended with a "thank you" that is not in the recording: the profile's sat
  at 140–141 s where RMS is 77, the product's at 164–166 s at RMS 62. `merge-translation.py`
  takes `--segments N` to drop them, and prints what it dropped.

`merge-translation.py` pairs the hand-written English with the transcript's measured timings
and **refuses to run if the counts differ**, because an off-by-one would shift every later
subtitle and still produce a plausible file. `split-cues.py` then breaks long segments at
sentence and clause boundaries, sharing each segment's time by character count — an
approximation that cannot accumulate, because every segment's bounds are the measured ones.

The improvement is visible in the reading rate, which is the same honesty check as before:

| | cues | median | spread |
|---|---|---|---|
| profile, spread from the PDF | 34 | 13.2 ch/s | 8.8–24.0 |
| profile, from the audio | 30 | 12.6 ch/s | **10.3–14.7** |
| product, from the audio | 33 | 11.2 ch/s | **8.8–14.0** |

**What the transcript showed.** He does not read the prompter, so the first subtitles were
confidently wrong: he says "sejak 1992" where the PDF says *at the age of eighteen*, adds "dan
dari ilham saya sendiri", never mentions the Lanang Iban Community post at all, and in the
product talk **points at the parang** — "yang ini kita buat daripada besi dan ukirannya kita
panggil kunding" — instead of reciting the *nyabor / mandau / baih / malak* passage, which he
skips entirely. No amount of careful timing could have rescued the wrong words.

When splitting on words, split into **balanced** chunks rather than greedily filling to the
limit. Greedy filling turned an 86-character sentence into a 79-character cue followed by a
0.46 s cue reading "Ilang."

### Refining the Bakul stills (`tools/refine-stills.py`)

Nine Sony **ARW raws** of the basket and its unwoven strips. ffmpeg cannot decode ARW, but
each file carries a **full-resolution 7008×4672 embedded JPEG** — the camera's own rendering,
which is better behaved than a raw development whose parameters we would have to guess. The
script pulls it out by scanning for the JPEG SOI/EOI markers, so it needs no raw library.

Three measured corrections, in this order:

1. **Crop the studio floor.** Six of the nine frames have a wooden floor band down the left
   edge. It is saturated, so a background key *keeps* it — it has to go before anything else.
   It is found by column coverage: a floor column is "not backdrop" down almost its whole
   height, a column through the subject is not. The edge is slightly defocused, so coverage
   drops below the threshold while a 3–9 px sliver remains; the crop is over-extended by 1% of
   the width, which costs nothing on a 7008 px frame.
2. **Match the grade, per image.** The stills measure darker and flatter than the turntable
   frames they sit beside — subject luma p50 **57 vs 81**, saturation **29 vs 42**. Gamma and
   saturation are solved from each image's own measurements, because the nine differ from each
   other as much as they differ from the target (gamma ranges 1.13 to 1.81). Saturation is
   measured *after* the gamma, since gamma changes it too. All nine land on luma 78–80 and
   saturation 41–45.
3. **Backdrop to white.** The backdrop is neutral (saturation 2–4) and the dyed strips are not,
   so a saturation key works here, with a brightness term to hold the dark parts of the weave —
   the same shape as the turntable video's.

The target numbers come from `product rotate/pngseq`, which is itself exported from the
corrected turntable, so the stills and the product panel agree.

Output: `outer assets/premiere file/maznah/images/refined/`, 10 PNGs, 98 MB. Re-run the
script over the whole `images/` folder to pick up new raws; it is idempotent.

### Bangie's refined footage (22 Oct 2026)

Her video sources are now new cuts from `premiere file/bangie/highbitrate/` (walk-in 12.54 s,
idle 7.62 s, Profil 468.04 s, Terangkan Produk 508.96 s), refined by `tools/refine-video.py`
into `highbitrate/refined/`, which the pipeline remuxes without re-encoding. The originals
are only read (checksums verified unchanged).

**The grey backdrop is fixed.** Same backdrop lift as Maznah and Johnny: a soft difference
matte against a plate of the empty wall, then `(240 - plate)` added to the wall only, so
clean backdrop lands on 240 whatever its vignette and her cast shadows keep their depth. The
measured page colour is now #F2F2F2 (theirs: #EFEFEF). Backdrop spread across nine spots
after refining: standing 13, Profil 8, Terangkan Produk 7 levels; theirs measure 13-19.

Plates, and what each taught:

- **The walk-in is two shots** joined by a dissolve at 3.38-3.80 s, each with its own
  backdrop. Its first frames are empty, so they are the plate for shot one; the standing
  shot's plate takes over, and the plate cross-fades with the dissolve. During the dissolve
  the frame mixes two shots that neither plate describes: the top-right corner dips ~20
  levels for ~0.3 s.
- **The idle and both talks never show an empty frame**, so their plates are fitted
  (`tools/make-plate.py --degree 6`). Degree 4, which served Maznah, left Bangie's standing
  backdrop with a 26-level spread (top-left corner at 218); degree 6 brings it to 13 with no
  seams, because the error stays a smooth gradient. A hybrid tried in between (real wall
  where visible, fit behind her) left visible seams where the two met, and was dropped.
- **The supplied `empty.png` was not used**: it carries horizontal smears that the lift would
  print into every frame.

**She is graded, the wall is not.** The camera's warm cast (the wall measured R192/G183/B179
where it should be neutral) is taken out of her with matching channel gains, plus contrast
1.06 and saturation 1.10. Her hair, glasses and the jacket's grey-and-white pattern were
checked at full size: no halo, nothing lifted.

**Her idle still does not loop**, and that is the edit, not the refine: 0.779 SSIM last frame
to first (0.786 in the original), and no frame in its second half comes near the first (best
mean difference 5.1, against 0.23 for one ordinary frame step), so no trim closes it. Her
`stageCycle` therefore hard-cuts walk → idle (0.983, a clean join) and cross-dissolves the idle
into itself for 500 ms at every loop. A re-cut that returns to its opening pose is the real
fix. (The earlier cut's idle scored 0.815 and was never fixed.)

The refine runs at ~11 fps at 1296x2304 (a talk takes 30-40 minutes); lifting at full 4K was
measured at 0.8 fps. `highbitrate/refined/_working/HOW.txt` has the exact commands and keeps
the plates.

### Step captions sit inside the video

As in the old app, a step's subtitle is a translucent strip across the lower part of the
*video*, not a band below the carousel. Each slide owns its caption element, so only the playing
slide ever shows text. Steps with `"srt": null` (Samat's, burned in) get no caption at all.

### The two FBX files face opposite ways

`Wau.fbx`'s painted face points **+Z**; `WauSeparated.fbx`'s points **−Z**. Measured, not
guessed: both files report first-triangle normals at `z = +1.00`, yet rendering the separated
stack at yaw 0 shows its plain blue backing and only at yaw 180 shows the painted layers.

`variants[].modelYawDeg: 180` corrects the exploded variant. It rotates the **model**, applied
before the bounding box is measured, so it sits *inside* the viewer's own yaw — the visitor's
rotation still composes on top and continuity across the swap is preserved. Putting the
correction on the camera instead would have broken exactly the continuity it exists to keep.

Without it the kite appears to flip round the instant it comes apart.

### The product is centred in the free space, not the screen

The control column takes up the right of the Produk screen, so the geometric centre (x=540)
puts the kite visibly too far right. `freeSpaceCentre()` in `web/screens/products.js`
**measures** the back button's right edge and the controls' visible left edge (allowing for the
PNG glow, `PILL_GLOW_INSET`) and centres the rotation axis between them — x≈425 today. Because
it is measured rather than hard-coded, it stays right if the buttons move or another artist has
a different set of controls.

The shift is a camera **view offset** (`setViewOffset`): it slides the rendered image without
changing the projection. Moving the pivot or aiming the camera off-centre would instead put the
kite off the camera's axis and skew its perspective. The drag area stays full-width either way.

The assembled Wau is a zero-thickness plane, so at exactly 90° it has no pixels at all — that is
geometry, not a rendering fault.

### Tilt is a CAMERA orbit, never a model rotation

`camera.startPitchDeg` raises the camera; `pivot.rotation` only ever carries yaw about
world Y. Tilt the mesh instead and a drag begins to *roll* the kite as well as turn it,
which is disorienting and near-impossible to undo by hand. Keep the tilt on the camera.

### How the Pisahkan / Sambung transition works

**The camera belongs to the viewer, not to the model.** Rotation, pitch and zoom are held
by the viewer and are *never* touched when variants swap, so the kite opens and closes at
exactly the angle the visitor dragged it to. Variants deliberately carry no `camera` block
— adding one back would reset the view mid-transition and break the illusion that it is one
continuous object.

For the same reason the camera **distance is computed once**, from the first variant, and
never recomputed. The exploded Wau's bounds grow from 6 to 176 deep as it opens; re-fitting
on each swap would zoom the model in and out, and the separation would read as a rescale
rather than as movement.

The swap is **asymmetric**, because opening and closing are not mirror images in the source
files:

| Action | What happens |
|---|---|
| **Pisahkan** | swap in the exploded mesh, then play its clips **forward** |
| **Sambung** | stay on the exploded mesh, play the clips in **reverse** first, and only swap back to the whole kite once they land |

Swapping first on the close would cut straight to the assembled mesh with no motion at all.
The toggle button is disabled for the duration either way, so it cannot be double-tapped
mid-transition.

`animation.durationSec` retimes every clip to that wall-clock duration (currently **1.0 s**);
the Blender export runs 2.042 s. Reverse uses the same magnitude with a negative `timeScale`,
starting from the clip's end, so the close takes exactly as long as the open.

Other tuning without re-exporting: `model.scale` and `model.camera.startYawDeg` /
`startPitchDeg` (the *initial* view only).

---

## How it's built

```
start.bat              launcher: starts server, waits for the port, opens Chrome
server/server.js       zero-dependency static server
content/content.json   THE manifest
content/artists/…      prepared media
web/                   the app (plain ES modules, no build step)
tools/transcode.mjs    one-time media preparation
_source/               masters + downloads — NOT served
```

Edit anything under `web/` and just refresh; there is no build step.

### Things that are load-bearing

**`server.js` must keep Range/206 support.** Without it Chrome cannot seek in a video and
playback can fail outright. This is the most common way a hand-rolled static server breaks
media.

**Cache headers must stay revalidating, never `immutable`.** Every response is `no-cache` +
`ETag` — which means "revalidate before reuse", not "don't store"; on localhost that is one
304 and no bytes. An earlier version sent `immutable, max-age=1 year`, which pinned `app.js`
and `app.css` in the kiosk's **persistent** browser profile so edits silently never arrived —
the running kiosk kept executing months-old JavaScript. It is invisible in testing, because a
fresh profile has an empty cache and always fetches the newest file. If a stale cache is ever
suspected, bump the profile suffix in `start.bat` (`chrome-profile-v2` → `v3`).

**`/api/manifest` enriches `content.json`** by `stat()`-ing every asset it references and
injecting `bytes` and `exists`. That gives the loading bar a byte-exact denominator and
gives the product viewer its "has the FBX arrived?" signal, with no hand-maintained file list.

**The page background is not `#fff`.** It is `--backdrop`, measured from the footage
(`#FCFCFF` for Samat). On a semi-transparent panel a pure-white page would make the video's
rectangle visible as a dim box. `tools/transcode.mjs` prints the measured value for each new
artist — put it in that artist's `backdrop` field.

**The walk→idle seam** (`web/lib/seamless-player.js`). The incoming `<video>` is the hazard,
not the outgoing one: an element that has never presented a frame paints black, and
`readyState === 4` does not prove a frame was painted. The player primes the next clip to a
*presented* frame 0 and swaps ~2 frames early, with a canvas freeze covering the swap.

**The idle watchdog** (`kiosk.idleTimeoutMs`, currently **3 minutes**) is suspended while the
artist is talking (Profil, for the whole clip) and while a Pembuatan step video is playing,
resuming the moment that clip ends. The artist **idle loop must never hold it**, or the kiosk
would never return to the menu. Verified by test.

In the carousel the hold is driven by the videos' own `play` / `pause` / `ended` events and is
**counted, not boolean** — a page change emits several of those events, and a boolean would drop
a release and strand the timer held forever. Step videos have `loop = false`, so each plays once
and rests on its last frame; re-selecting a page replays it from the start.

**The canvas is centred by absolute positioning, not by grid/flex** (`web/app.css`,
`fitCanvas()` in `web/app.js`). CSS Grid and Flexbox refuse to centre an item *larger* than
their container — they clamp it to the start edge. So at any window smaller than 1080×1920
the canvas stayed at 0,0 and then scaled about its own centre, throwing everything down and
to the right and pushing content off-screen. At exactly 1080×1920 the scale is 1 and the bug
is invisible, which is why it only ever appeared in a window — and why the Wau seemed not to
render at all. `translate(-50%,-50%)` must stay ahead of `scale()` in the transform.

**The 3D pixel ratio tracks the canvas scale.** The viewport is measured in design pixels, so
rendering at that size leaves the model soft on the 4K panel. `effectiveScale()` multiplies
the device pixel ratio by however much the canvas is actually scaled.

**A fade `swap` must return as soon as its screen is READY, never when its content
finishes.** `transition()` holds an opaque white veil over the canvas while `swap` runs.
`enterProfile` used to `await` the whole 7.5-minute talk there, so the veil stayed up for
the entire video: audio played perfectly behind a blank white screen. `playOnce()` now
resolves on the **first presented frame** and returns `{ done }` for the end of playback,
and `transition()` carries a failsafe timer that lifts the veil regardless — nothing
downstream should ever be able to white out the exhibit again.

**`presented()` must not wait on rVFC alone** (`web/lib/seamless-player.js`).
`requestVideoFrameCallback` only fires when a video presents a *new* frame. A paused,
already-decoded element — exactly what a re-primed clip is — never presents another one, so
waiting on it hangs forever. This is what made a profile video play the first time and never
again; the second visit simply never started. It now also accepts `readyState >= 2` and has a
hard timeout.

**Late playback must not hijack a newer screen.** Each profile visit takes a session number,
and an abandoned playback that resolves late only auto-returns to the stage if its session is
still the current one. Without that, a stale visit dragged a *later* one back to the stage.

## The idle watchdog, and the bug worth not reintroducing

Three minutes of no touch returns to the main menu. The countdown is **suspended** while a
one-shot video plays — the walk-in, a talk, a Pembuatan step — and must NOT be suspended by
the artist idle loop, which runs forever.

`idle.hold()` returns its own release rather than exposing a bare `release()`. That release
is idempotent, and it stops working once `clearHolds()` has run. Both properties are
load-bearing, and the second one fixed a reported fault: watching Norhaiza's seven-minute
profile, the kiosk jumped to the main menu partway through.

| step | holds |
|---|---|
| `enterArtist` takes a hold, schedules its release for the walk-in's 14.96 s | 1 |
| visitor taps Profil, `showScreen` calls `clearHolds()` | **0** |
| `enterTalk` takes its own hold | 1 |
| the walk-in's **stray** timer fires at 14.06 s | **0** |
| three minutes later the countdown fires, mid-talk | — |

A release must never be able to decrement a hold it did not take. The scenario is covered by
a test that replays it against both the old and new timer.

## Operator keys

| Key | Effect |
|---|---|
| **Esc** | from any panel → main menu; **from the main menu → quits the app** |
| **F11** | fullscreen ⇄ 608×1080 portrait window |
| Alt+F4 | quit |

Esc→quit goes through `window.kraf.quit()`, the single function exposed by
`electron/preload.cjs`; in a plain browser it falls back to `window.close()`.

## Cursor

The cursor is **visible on every panel** while the exhibit is being built and tested.
To hide it for the museum floor, set `kiosk.hideCursor: true` in `content.json`, or open
with `?cursor=off`.

## Transitions

Every panel change crossfades through solid white (`#veil`). `kiosk.fadeMs` is the duration
of **each half**, so the default 500 gives 0.5 s to white + 0.5 s out = **1 s total**. The
swap happens while the screen is fully white, so nothing half-built is ever visible, and a
tap during a fade is swallowed.

The **one deliberate exception is the walk-in → idle handoff**, which is frame-matched and
must stay seamless. Fading there would destroy the effect it exists to create.

**The walk-in only plays when arriving from the main menu.** Coming back from Profil, Produk
or Pembuatan goes straight to the idle loop — replaying the arrival would read as the artist
leaving the box and walking in again. `enterArtist(artist, { walkIn })` carries this, and the
stage buttons appear immediately when there is no walk-in to wait for.

Leaving a panel stops and rewinds its media, so an abandoned profile video replays from the
beginning next time rather than resuming.

## Window modes

`start.bat` launches `--start-fullscreen`, **not** `--kiosk` — kiosk mode locks fullscreen and
swallows F11. **F11 toggles between fullscreen and a 608×1080 portrait window** (set by
`kiosk.windowedWidth`/`Height` and mirrored in the `--window-size` flag). The canvas rescales
to whatever it is given, so both modes are correct; 608×1080 is deliberately ~9:16 to match
the design canvas with almost no letterboxing.

## Pressed state

Buttons take a **50% dark-brown wash while held** (`--press-tint`). The tint is a
pseudo-element *masked with the button's own PNG* (`--btn-img`, set beside the background
image), so it follows the artwork's silhouette instead of painting a rectangle across the
transparent glow margin. `.is-pressed` is added on `pointerdown` for ~140 ms because a quick
touch can release before `:active` ever paints.

**The main-menu artist card is the exception**: it responds by **scaling only**, with no colour
wash, which would dull the portrait and the plate's gold glow. The card is a single button
containing both the portrait and the name plate, so a tap anywhere on it selects the artist.

⚠️ `.artist-card` must stay **out** of the `.imgbtn::after` selector that creates the tint layer.
An earlier attempt set `.artist-card::after { content: none }` *above* that rule; equal
specificity means the later rule wins, so the card silently kept tinting and the fix appeared to
do nothing. Verified by asserting the computed `::after` content is `none`, not `""`.

## Button placement

Each PNG carries ~30 px of transparent glow above and below its visible pill at display scale,
so stacked buttons sit ~64 px apart even at `gap: 0`. The tight clusters are therefore built
with **negative margins** (`gap` cannot be negative) and negative `right` insets that let the
glow overhang the canvas edge so the *pill* lands near it.

On the Produk screen the zoom buttons live **inside** the control column rather than in their
own absolutely-positioned stack, so `+`, `−`, Pisahkan/Sambung and Set Semula read as one
cluster. The back button is 80% size at the left edge, shared by every panel — a new artist's
screens inherit it automatically.

### Media preparation does NOT re-encode

`tools/transcode.mjs` **remuxes**. Measuring the masters killed the usual reasons to
transcode: they are already faststart (`moov@28`), already CFR 25 with a clean 30-frame GOP.
The one real defect was that Samat's and Norhaiza's portrait clips are colour-**untagged**,
which on a white-backdrop shoot risks Chrome picking a different matrix and shifting the
backdrop. Measure each new artist rather than copying the flags: Bangie's four clips arrived
already BT.709-tagged, 1296×2304 and 50 fps, so all four have `retag: false`.

Still images are the exception — the only things this pipeline re-encodes. `args` on an
`ARTWORK` row passes extra ffmpeg flags, which is how Bangie's five 33-megapixel masters get
capped and turned into WebP.

So the script stamps BT.709 into the H.264 SPS VUI with a bitstream filter and stream-copies
everything else. Zero generation loss; the whole pass takes about six seconds. It also drops
walk/idle audio, which measures −91 dB (digital silence) — that removes any loop click and
lets both clips autoplay muted.

Re-run any time; it skips up-to-date outputs. `npm run prepare-assets:force` rebuilds.

---

## Current state

> For a per-artist status table and what is outstanding, see **`HANDOVER.md`**, which is kept
> current. This section records the architecture-level state.

**Five** artists are in and tested end to end: loading, menu, the stage cycle, talk videos
with and without subtitles, the Pembuatan carousel, all three product types, idle reset and
kiosk hardening. Johnny (5th, Parang Ilang) has his talks and subtitles but no artwork of his
own, and no Terokai Produk yet.

> **The drop folder was reorganised on 1 Oct 2025** and the job tables were repointed to
> match: Bangie's masters are now `premiere file/bangie/Edited/`, Norhaiza's menu art is in
> `images/` (with `18/19 Keris … Title.png` where the old names said `Info`), and his
> sequences, steps and video — plus the Wau FBX — moved under `old/`. Every source in
> `tools/transcode.mjs` resolves again; if a reorganisation happens, run the script and
> read the `! missing` lines before assuming anything is lost.

| Outstanding | Notes |
|---|---|
| Maznah's Terokai Produk | the Sungu Duri turntable with three hotspots works, but is **to be replaced by a better design** (20 Oct 2026) |
| ~~Maznah's new script has no words yet~~ | **done** — the `### NEW SCRIPT ###` placeholders were transcribed and filled. Verified 19 Oct 2026: every `.srt` in the project covers its clip with no gap over 12 s |
| Re-timed cues want a spot check | 23 of 59 (profile) and 14 of 33 (product) matched below 0.85 correlation. `tools/retime-subs.py` lists them |
| Maznah's captions are English only | `profile BM.txt` and `product BM.txt` exist beside the English ones and are deliberately unused || Maznah's profil/explain are still 4K | 2160x3840, as chosen — they are one-shot talks, not the attract loop. Her walk/idle/dance are 1296x2304 |
| `Biografi Bangie Sub.mov` has finished downloading | 7 GB, in `premiere file/bangie/Edited/`. Previously an unusable partial; if it is her profile with burnt-in captions it would settle the "Bangie has no subtitles" row below |
| Bangie's idle loop does not close | new cut, still 0.779 SSIM at its own seam; cross-dissolved by her `stageCycle` until a re-cut. See *Bangie's refined footage* |
| ~~Bangie's footage is on grey~~ | **done** (22 Oct 2026) — lifted to #F2F2F2 by `tools/refine-video.py`, and she is colour-graded |
| Bangie's supers card | `Text1.png` on a 5s/5s cycle — placeholder artwork *and* placeholder schedule. To be replaced by **infotext** (timed images; Maznah, Bangie, Johnny), briefed 20 Oct 2026 and not yet built. See `HANDOVER.md` → *Infotext* |
| Bangie has no subtitles | her talks are in **Iban**; the museum is to supply a full translation, which the re-edit and subtitles both wait on. The band stays off until a `.srt` appears |
| Bangie's title block reads "???" | `Title Product Explore.png` ships with placeholder Motif/Teknik text |
| Norhaiza keris info blocks | `18 Keris 1 Info.png` / `19 Keris 2 Info.png` are still generated placeholders. Norhaiza was accepted as done on 20 Oct 2026 with these in place |
| Wau product thumbnail | still a crop of the old screenshot; only visible behind a missing model or in a 2+ product rail, so cosmetic. Samat was accepted as done on 20 Oct 2026 |
| `9 Logo.png` is fully opaque | a white box, not transparent. The import keys the white out, which costs a little edge quality; a version with real alpha would be cleaner |

### Main menu artwork

All supplied pieces are used: `8 Title.png` as the header (an `<img>`, not live text),
`9 Logo.png` top-right, `4 Samat MainMenu.png` as the card, and `3 Samat Button MainMenu.png`
as the name plate overlapping its bottom edge. Nothing is drawn over them, so a new artist is
purely a matter of new PNGs plus a manifest entry.

### UI artwork

Buttons are the museum's PNGs, not CSS shapes. Each carries its glow in a transparent
margin, so roughly half the element's height is drawable pill — that is why `.pill` is sized
generously and the type kept small, and why the stage menu uses a near-zero `gap` (the glow
margin *is* the spacing). Labels are drawn over `btn-empty.png` except where the artwork
already contains its text (`btn-reset`, `btn-separate`), which is chosen automatically by
whether `ui[<label key>]` exists in the manifest.

### Before it goes on the real panel

1. Play a clip fullscreen and confirm `chrome://gpu` reports accelerated video decode.
   If Windows is rotating a landscape panel to portrait, the zero-copy video path can drop
   out — the panel should report natively as portrait.
2. Put a CSS `#FCFCFF` area against a paused video frame and check no rectangle edge shows.
3. Watch the walk→idle handoff for a white or black frame.
4. Confirm pinch does not zoom the page and swipes do not navigate back.
5. Leave it running overnight; memory should be flat and it should be parked on the menu.

### Kiosk machine setup

Auto-login; sleep, hibernate and screensaver off; Windows Update active hours locked;
notifications off; `start.bat` in Startup. **Pin Chrome's version or disable its updater** —
otherwise this runs for eight months and dies on a Tuesday.

---

## Source note

The masters are 1080×1920 (portrait) and 1920×1080 (steps). Nothing in the set is 4K, so
video is kept at native resolution and Chrome upscales it to the panel; the UI layer is DOM
and renders at the panel's true resolution. If the original camera masters are higher
resolution than these exports, they are worth collecting — that is the only thing that would
make the picture sharper.

three.js is vendored at **r170** in `web/vendor/three/` (the whole `examples/jsm` folder,
because FBXLoader pulls in fflate and the NURBS helpers). Pinned deliberately; leave it alone.
