/**
 * KRAF kiosk — boot, screen state machine, and the capability-derived stage menu.
 *
 * The one rule that keeps this maintainable as artists are added: no artist is ever
 * named in code. Every screen asks the manifest "what does this artist have?" and
 * renders accordingly. An artist with no steps never grows a Pembuatan button,
 * because the button is built from `artist.steps`, not from a fixed template.
 */

import { SeamlessPlayer } from './lib/seamless-player.js';
import { AssetLoader, preloadImage } from './lib/loader.js';
import { loadSrt, SubtitleBand } from './lib/srt.js';
import { IdleTimer } from './lib/idle-timer.js';
import { mountProducts } from './screens/products.js';
import { mountProcess } from './screens/process.js';
import { mountMenu } from './screens/menu.js';

const CONTENT = '/content/';
const $ = (id) => document.getElementById(id);

/** @type {any} */ let manifest = null;
/** @type {IdleTimer} */ let idle = null;
let stagePlayer = null;
let profilePlayer = null;
let currentArtist = null;
let activeScreen = 'loading';
let disposeScreen = null;
let menuIdleSince = 0;
/** The main-menu carousel; built once at boot and kept for the life of the page. */
let menu = null;

const url = (rel) => CONTENT + String(rel).replace(/^\/+/, '');
const assetInfo = (rel) => manifest?.assets?.[rel] ?? { bytes: 0, exists: false };

/* ------------------------------------------------------------------ layout */

/**
 * Scale the 1080x1920 design canvas to fit whatever window or panel is attached.
 * The translate(-50%,-50%) must stay in front of the scale — see the note in app.css
 * about why centring cannot be left to the layout.
 */
function fitCanvas() {
  const el = $('canvas');
  const dw = manifest?.kiosk?.designWidth ?? 1080;
  const dh = manifest?.kiosk?.designHeight ?? 1920;
  el.style.width = `${dw}px`;
  el.style.height = `${dh}px`;
  const scale = Math.min(window.innerWidth / dw, window.innerHeight / dh);
  el.style.transform = `translate(-50%, -50%) scale(${scale})`;
}
window.addEventListener('resize', fitCanvas);

/* ------------------------------------------------------------------ screens */

function showScreen(name) {
  for (const s of document.querySelectorAll('.screen')) {
    s.hidden = s.dataset.screen !== name;
  }
  activeScreen = name;
  idle?.clearHolds();
  menuIdleSince = name === 'menu' ? Date.now() : 0;
  // The carousel only drives itself while it is the screen on show.
  menu?.setActive(name === 'menu');
}

/* --------------------------------------------------- fade-to-white ------
 * Every panel change goes through solid white. The single exception is the
 * walk-in -> idle handoff inside the stage, which is frame-matched and must
 * stay seamless — fading there would destroy the effect it exists to create.
 *
 * `swap` runs while the screen is fully white, so nothing half-built is ever
 * visible. Concurrent calls are serialised by a token: if the user taps again
 * mid-fade, the older transition abandons its fade-out.
 */
let fadeToken = 0;

function fadeMs() {
  return manifest?.kiosk?.fadeMs ?? 420;
}

async function transition(swap) {
  const token = ++fadeToken;
  const veil = $('veil');
  const ms = fadeMs();

  /* Safety net. A `swap` that never settles would leave the veil up forever and the
   * kiosk would sit on a blank white screen — which is precisely what happened when
   * enterProfile awaited a 7.5-minute video here. The swap is now expected to return
   * as soon as its screen is ready, but nothing downstream should ever be able to
   * white out the exhibit again, so the veil lifts on a timer regardless. */
  const failsafe = setTimeout(() => {
    if (veil.classList.contains('is-up')) {
      console.warn('transition: swap exceeded its budget — lifting the veil anyway');
      veil.classList.remove('is-up');
    }
  }, ms + 6000);

  try {
    veil.classList.add('is-up');
    await new Promise((r) => setTimeout(r, ms));
    if (token !== fadeToken) return;          // superseded mid-fade

    try { await swap(); } catch (e) { console.error(e); }
    if (token !== fadeToken) return;

    // one frame so the new screen paints behind the veil before it lifts
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (token !== fadeToken) return;
    veil.classList.remove('is-up');
  } finally {
    clearTimeout(failsafe);
  }
}

/** Tear down whatever the previous screen owned before moving on. */
function leaveScreen() {
  if (disposeScreen) {
    try { disposeScreen(); } catch (e) { console.error(e); }
    disposeScreen = null;
  }
  stagePlayer?.stop();
  profilePlayer?.stop();
}

/* ------------------------------------------------------------------ pills */

/**
 * A button drawn from the museum's artwork.
 *
 * Two shapes, chosen by whether the manifest supplies a dedicated image for this
 * label. `ui.reset` and `ui.separate` already have their text baked into the PNG,
 * so those render as bare artwork. Everything else — Profil, Produk, Pembuatan,
 * and the Sambung half of the toggle, for which no artwork was supplied —
 * draws its bilingual label over the blank pill.
 */
export function makePill(key, onClick, { image, strings } = {}) {
  const b = document.createElement('button');
  b.className = 'imgbtn pill';
  b.addEventListener('click', onClick);
  const vocab = strings ?? manifest.strings ?? {};

  if (image) {
    b.classList.add('pill--art');
    setButtonArt(b, image);
    const s = vocab[key];
    if (s) b.setAttribute('aria-label', `${s.ms} — ${s.en}`);
    return b;
  }

  const s = vocab[key] ?? { ms: key, en: '' };
  setButtonArt(b, url(manifest.ui?.pill));
  b.innerHTML = `<span class="pill__ms"></span><span class="pill__en"></span>`;
  b.querySelector('.pill__ms').textContent = s.ms;
  b.querySelector('.pill__en').textContent = s.en;
  return b;
}

/**
 * Point a button at its artwork. `--btn-img` mirrors the background image so the
 * pressed-state tint can be masked to the same silhouette rather than painting a
 * rectangle across the PNG's transparent glow margin.
 */
export function setButtonArt(el, href) {
  if (!href) return;
  el.style.backgroundImage = `url("${href}")`;
  el.style.setProperty('--btn-img', `url("${href}")`);
}

/* ------------------------------------------------------------------ menu */

/**
 * The menu is a wrapping, self-driving carousel (web/screens/menu.js). It is built once
 * at boot and kept, because it owns the drift timer and its own position in the ring —
 * rebuilding it on every return to the menu would restart the attract loop from artist
 * one each time.
 */
function buildMenu() {
  menu?.dispose();
  menu = mountMenu({
    artists: manifest.artists ?? [],
    manifest,
    url,
    assetInfo,
    els: {
      screen: $('screen-menu'),
      carousel: $('artist-carousel'),
    },
    // From the main menu, and only here, the artist walks in.
    onPick: (artist) => transition(() => enterArtist(artist, { walkIn: true })),
  });
}

/* ------------------------------------------------------------------ stage */

/**
 * Button artwork for this artist: the shared set, with any per-artist overrides on top.
 *
 * Bangie supplies his own three, because two of them carry labels no other artist has
 * ("Terangkan Produk", "Terokai Produk"). Artists who supply nothing keep the shared
 * artwork, so this costs the first two nothing.
 */
function uiFor(artist) {
  return { ...(manifest.ui ?? {}), ...(artist?.ui ?? {}) };
}

/**
 * The button vocabulary for this artist, same override rule as the artwork.
 *
 * Bangie's product panel is called "Terokai Produk", not "Produk". The label is baked
 * into his artwork, so this only reaches the accessible name — but a button that reads
 * one thing and announces another is a defect whichever way round it is.
 */
function stringsFor(artist) {
  return { ...(manifest.strings ?? {}), ...(artist?.strings ?? {}) };
}

/**
 * Build the stage button column from what this artist ACTUALLY has.
 * This is the whole "no template" claim, in eight lines.
 *
 * Order here is the order on screen, top to bottom. `explain` is a second talk video —
 * the artist describing the work rather than himself — and sits between the profile and
 * the product panel, which is where Bangie's brief puts it.
 */
function stageSections(artist) {
  const products = (artist.products ?? []).filter((p) => p.enabled !== false);
  const steps = artist.steps ?? [];
  return [
    artist.video?.profile ? { key: 'profile', go: () => enterTalk(artist, 'profile') } : null,
    artist.video?.explain ? { key: 'explain', go: () => enterTalk(artist, 'explain') } : null,
    products.length ? { key: 'products', go: () => enterProducts(artist, products) } : null,
    steps.length ? { key: 'process', go: () => enterProcess(artist, steps) } : null,
  ].filter(Boolean);
}

/**
 * What the stage plays, as an ordered cycle.
 *
 * Most artists are "walk in once, then loop the idle forever", and that is what this
 * returns when the manifest says nothing. Maznah needs more: she walks in, stands
 * through the idle twice, dances, and the dance ends with her walking off exactly where
 * the walk clip begins — so her cycle loops back to the WALK, not to an idle. Her
 * `stageCycle` block spells that out, one entry per play, which keeps each join
 * individually tunable (two of hers are not pose-matched and cross-dissolve).
 *
 * `resumeFrom` is where the cycle restarts when the visitor comes back from a sub-panel:
 * replaying the walk-in there would read as the artist leaving the box and returning.
 */
function stageCycle(artist) {
  const v = artist.video ?? {};
  const cfg = artist.stageCycle;

  if (!cfg?.steps?.length) {
    const steps = [];
    if (v.walk) steps.push({ src: url(v.walk.src), fps: v.walk.fps ?? 25 });
    if (v.idle) steps.push({ src: url(v.idle.src), fps: v.idle.fps ?? 25 });
    // loop the idle alone; with no walk there is only the idle to loop
    return { steps, loopFrom: steps.length - 1, resumeFrom: steps.length - 1 };
  }

  const steps = cfg.steps
    .map((s) => {
      const clip = v[s.clip];
      if (!clip) { console.error(`stageCycle: no video.${s.clip} for ${artist.id}`); return null; }
      return { src: url(clip.src), fps: clip.fps ?? 25, blendMs: s.blendMs ?? 0 };
    })
    .filter(Boolean);

  return {
    steps,
    loopFrom: Math.min(cfg.loopFrom ?? 0, steps.length - 1),
    resumeFrom: Math.min(cfg.resumeFrom ?? 0, steps.length - 1),
  };
}

/**
 * @param {object} artist
 * @param {{walkIn?: boolean}} opts  walkIn plays the arrival clip. Only true when the
 *   visitor comes from the main menu — returning from Profil/Produk/Pembuatan goes
 *   straight to the idle loop, because replaying the walk-in would read as the artist
 *   leaving the box and walking back in.
 */
async function enterArtist(artist, { walkIn = false } = {}) {
  leaveScreen();
  currentArtist = artist;
  document.documentElement.style.setProperty('--backdrop', artist.backdrop ?? '#FFFFFF');

  const menu = $('stage-menu');
  menu.innerHTML = '';
  const ui = uiFor(artist);
  const strings = stringsFor(artist);
  for (const section of stageSections(artist)) {
    // Each stage button has its own artwork with the label baked in; makePill falls
    // back to the blank pill only if a manifest entry is missing.
    menu.appendChild(makePill(section.key, () => transition(section.go), {
      image: ui[section.key] ? url(ui[section.key]) : null,
      strings,
    }));
  }
  // The buttons are present from the moment the stage appears — no fade-in, and no
  // waiting for the walk-in to finish. A visitor who already knows the exhibit can
  // tap straight through instead of watching the arrival first.
  menu.style.transition = '';
  menu.style.opacity = '1';

  showScreen('stage');

  stagePlayer ??= new SeamlessPlayer($('stage-video'), 3);

  const cycle = stageCycle(artist);
  stagePlayer
    .playCycle(cycle.steps, {
      startIndex: walkIn ? 0 : cycle.resumeFrom,
      loopFrom: cycle.loopFrom,
    })
    .catch((e) => console.error(e));

  if (walkIn) {
    // The walk-in is a one-shot, so it holds the idle countdown for its duration.
    // The idle LOOP must not, or the kiosk would never return to the menu.
    const walk = artist.video.walk;
    const releaseWalk = idle.hold();
    setTimeout(releaseWalk, Math.max(800, (walk?.durationMs ?? 7840) - 900));
  }

  disposeScreen = () => { menu.innerHTML = ''; };
}

/* --------------------------------------------------------------- talk ----
 * One screen for every "the artist speaks to camera" clip. Two exist so far:
 *
 *   profile  — who he is (all three artists)
 *   explain  — what the work is (Bangie only, so far)
 *
 * They are the same screen because they behave identically: a one-shot clip that
 * holds the idle countdown, can carry subtitles, and returns to the idle stage when
 * it ends. What differs is per-clip manifest data, not code.
 *
 * `overlay` is the one addition: a "supers" card held over the picture on a repeating
 * schedule. It is driven from the video's own currentTime rather than a wall clock, so
 * it stays in step if playback stalls, and it needs no timers to cancel on the way out.
 */

let profileSession = 0;

function mountOverlay(el, cfg) {
  if (!cfg?.image || !assetInfo(cfg.image).exists) {
    el.hidden = true;
    return { update() {}, hide() { el.hidden = true; } };
  }
  const showMs = cfg.showMs ?? 5000;
  const hideMs = cfg.hideMs ?? 5000;
  const period = (showMs + hideMs) / 1000;
  const startAt = (cfg.startAtMs ?? 0) / 1000;

  el.src = url(cfg.image);
  el.style.width = `${cfg.width ?? 900}px`;
  el.hidden = false;
  el.classList.remove('is-on');

  let on = null;
  return {
    update(t) {
      // Position within one show+hide cycle. Visible for the first `showMs` of it.
      const phase = ((t - startAt) % period + period) % period;
      const next = t >= startAt && phase < showMs / 1000;
      if (next !== on) { on = next; el.classList.toggle('is-on', next); }
    },
    hide() { el.hidden = true; el.classList.remove('is-on'); el.removeAttribute('src'); },
  };
}

async function enterTalk(artist, key) {
  leaveScreen();
  showScreen('profile');
  // Identifies THIS visit. A playback promise that resolves late — because the visitor
  // left — must not act on a screen that has moved on since.
  const session = ++profileSession;

  profilePlayer ??= new SeamlessPlayer($('profile-video'), 2);
  const band = new SubtitleBand($('profile-subs'));

  const cfg = artist.video[key];
  if (cfg.srt && assetInfo(cfg.srt).exists) {
    try { band.setCues(await loadSrt(url(cfg.srt))); }
    catch (e) { console.warn('subtitles unavailable', e); }
  }
  const overlay = mountOverlay($('profile-overlay'), cfg.overlay);

  // A talk is a one-shot: hold the idle countdown for its duration.
  const release = idle.hold();

  disposeScreen = () => { band.hide(); overlay.hide(); release(); };

  // Await only the FIRST FRAME, so the caller's fade can lift onto a painted picture.
  // Awaiting the whole clip here would hold the white veil up for the entire talk.
  let done;
  try {
    ({ done } = await profilePlayer.playOnce(url(cfg.src), {
      fps: cfg.fps ?? 25,
      muted: false,
      onTime: (t) => { band.update(t); overlay.update(t); },
    }));
  } catch (e) {
    console.error(`${key} playback failed`, e);
    release();
    return;
  }

  // The rest of the talk runs on its own; this function has already returned.
  done.then(() => {
    release();
    overlay.hide();
    // Returning to the idle stage when the talk ends is the documented behaviour.
    // Both guards matter: the session check stops an abandoned playback from dragging
    // a LATER visit back to the stage, and the screen check covers the ordinary case
    // where the visitor has already navigated away.
    if (session === profileSession && activeScreen === 'profile') {
      transition(() => enterArtist(artist));
    }
  });
}

/* ------------------------------------------------------------------ produk */

async function enterProducts(artist, products) {
  leaveScreen();
  showScreen('products');
  disposeScreen = await mountProducts({
    artist, products, manifest, url, assetInfo,
    els: {
      viewport: $('product-viewport'),
      meta: $('product-meta'),
      controls: $('product-controls'),
      rail: $('product-rail'),
      side: $('product-side'),
      hotspots: $('product-hotspots'),
      zoom: $('product-zoom'),
    },
  });
}

/* ------------------------------------------------------------------ pembuatan */

async function enterProcess(artist, steps) {
  leaveScreen();
  showScreen('process');
  disposeScreen = await mountProcess({
    artist, steps, manifest, url, assetInfo, idle,
    els: {
      carousel: $('carousel'),
      dots: $('carousel-dots'),
      subs: $('process-subs'),
    },
  });
}

/* ------------------------------------------------------------------ back */

function goMenu() {
  leaveScreen();
  currentArtist = null;
  document.documentElement.style.setProperty('--backdrop', '#FCFCFF');
  showScreen('menu');
}

/** Back from a sub-panel: no walk-in, straight to the idle loop. */
function goStage() {
  if (currentArtist) enterArtist(currentArtist, { walkIn: false });
  else goMenu();
}

/* ------------------------------------------------------------------ boot */

function setProgress({ ratio, files, totalFiles }) {
  $('progress-fill').style.width = `${(ratio * 100).toFixed(1)}%`;
  const label = manifest?.strings?.preparing?.ms ?? 'Menyediakan video…';
  $('progress-label').textContent = `${label} ${files}/${totalFiles}`;
}

function fatal(msg, detail) {
  const el = document.createElement('div');
  el.className = 'fatal';
  el.innerHTML = `<strong>${msg}</strong><span>${detail ?? ''}</span>`;
  $('canvas').appendChild(el);
  console.error(msg, detail);
}

/**
 * The video is not in the repository — it is 4.3 GB and ships separately (see
 * PROJECT-FLOW.md). A fresh clone therefore starts with every artist's walk, idle and talk
 * clips missing, and without this check the symptom is a stage that loads and then simply
 * never plays anything: no error, nothing in the console, just a blank white box. That is
 * the worst possible first impression for someone setting the project up.
 *
 * The server already stat()s every asset the manifest references and returns `exists` for
 * each, so this costs nothing extra — it just reads what /api/manifest already said.
 *
 * @returns {boolean} true when everything is present and boot may continue
 */
function checkMedia() {
  const assets = manifest.assets ?? {};
  const missing = Object.entries(assets)
    .filter(([rel, info]) => /\.(mp4|webm|mov)$/i.test(rel) && !info.exists)
    .map(([rel]) => rel)
    .sort();
  if (!missing.length) return true;

  const total = Object.keys(assets).filter((r) => /\.(mp4|webm|mov)$/i.test(r)).length;
  const byArtist = {};
  for (const rel of missing) {
    const who = rel.split('/')[1] ?? '?';
    byArtist[who] = (byArtist[who] ?? 0) + 1;
  }
  const el = document.createElement('div');
  el.className = 'fatal fatal--setup';
  el.innerHTML = `
    <strong>Video belum dipasang &middot; Video files are not installed</strong>
    <span>${missing.length} of ${total} video files are missing${
      Object.keys(byArtist).length
        ? ` &mdash; ${Object.entries(byArtist).map(([a, n]) => `${a} (${n})`).join(', ')}`
        : ''}.</span>
    <span class="fatal__how">
      The video is not in the Git repository: it is 4.3&nbsp;GB and is shared separately.<br>
      Copy the <code>content</code> folder from <code>HoloBox-media</code> (Google Drive)
      into this project and merge, then reload.<br>
      See <code>PROJECT-FLOW.md</code> &rarr; &ldquo;What is NOT in this repository&rdquo;.
    </span>
    <span class="fatal__list">${missing.slice(0, 8).join('<br>')}${
      missing.length > 8 ? `<br>&hellip; and ${missing.length - 8} more` : ''}</span>`;
  $('canvas').appendChild(el);
  console.error(`[media] ${missing.length}/${total} video files missing:\n` +
                missing.join('\n'));
  return false;
}

async function boot() {
  let res;
  try {
    res = await fetch('/api/manifest', { cache: 'no-store' });
    if (!res.ok) throw new Error(`manifest ${res.status}`);
    manifest = await res.json();
  } catch (e) {
    fatal('Tidak dapat memuatkan kandungan.', String(e));
    return;
  }

  fitCanvas();
  applyCursorPolicy();                 // re-apply now that the manifest is known

  // Stop here rather than loading into a stage whose clips will never play.
  if (!checkMedia()) return;

  document.documentElement.style.setProperty('--fade-ms', `${fadeMs()}ms`);
  $('loading-title').textContent = manifest.strings?.loading?.ms ?? 'Memuatkan aset…';
  for (const el of [$('brand-logo'), $('brand-logo-2')]) {
    if (manifest.museum?.logo) el.src = url(manifest.museum.logo);
  }
  for (const el of [$('brand-title-1'), $('brand-title-2')]) {
    if (manifest.museum?.titleImage) el.src = url(manifest.museum.titleImage);
    el.alt = manifest.museum?.title ?? '';
  }

  idle = new IdleTimer(manifest.kiosk?.idleTimeoutMs ?? 90000, () => {
    if (activeScreen !== 'menu') goMenu();
  });

  // Every back button fades. Leaving a panel also stops its media (see leaveScreen),
  // so an abandoned profile is rewound and will play from the start next time.
  $('stage-back').addEventListener('click', () => transition(goMenu));
  $('profile-back').addEventListener('click', () => transition(goStage));
  $('products-back').addEventListener('click', () => transition(goStage));
  $('process-back').addEventListener('click', () => transition(goStage));

  // Back-button artwork, and the rest of the shared UI images.
  const ui = manifest.ui ?? {};
  if (ui.back) {
    for (const id of ['stage-back', 'profile-back', 'products-back', 'process-back']) {
      setButtonArt($(id), url(ui.back));
    }
  }

  // Touch taps can release before :active ever paints, so hold the pressed look for
  // a beat. Delegated, so it covers buttons created later by any screen.
  const PRESS_MS = 140;
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest?.('.imgbtn, .artist-card, .product-rail button, .dots button');
    if (!b) return;
    b.classList.add('is-pressed');
    const clear = () => b.classList.remove('is-pressed');
    setTimeout(clear, PRESS_MS);
    b.addEventListener('pointerup', () => setTimeout(clear, PRESS_MS), { once: true });
    b.addEventListener('pointercancel', clear, { once: true });
  }, { capture: true, passive: true });

  /* ---- Phase A: byte-warm the assets the first interaction needs ---------
     Only walk + idle + menu art block the bar. Profile and step videos are
     large and lazy: by the time a visitor opens them their bytes are already
     in the OS page cache anyway. */
  const eager = [];
  const seen = new Set();
  const add = (rel) => {
    if (!rel || seen.has(rel)) return;
    const info = assetInfo(rel);
    if (!info.exists) return;
    seen.add(rel);
    eager.push({ url: url(rel), bytes: info.bytes });
  };

  if (manifest.museum?.logo) add(manifest.museum.logo);
  if (manifest.museum?.titleImage) add(manifest.museum.titleImage);
  for (const [k, p] of Object.entries(manifest.ui ?? {})) {   // button artwork
    if (!k.startsWith('_')) add(p);
  }
  for (const a of manifest.artists ?? []) {
    add(a.menuCard);
    add(a.menuPlate);
    add(a.menuPortrait);
    add(a.video?.walk?.src);
    add(a.video?.idle?.src);
    // Any extra clip the stage cycle plays (Maznah's dance) is part of the attract
    // loop, so it warms with the rest rather than stalling the first time it comes up.
    for (const s of a.stageCycle?.steps ?? []) add(a.video?.[s.clip]?.src);
    for (const [k, p] of Object.entries(a.ui ?? {})) {   // per-artist button artwork
      if (!k.startsWith('_')) add(p);
    }
  }

  const loader = new AssetLoader(setProgress);
  await loader.warmAll(eager);

  // Phase B: decode the menu and button art so the first paint never blocks and
  // no button visibly pops in on its first use.
  const toDecode = [
    manifest.museum?.logo,
    manifest.museum?.titleImage,
    ...Object.entries(manifest.ui ?? {}).filter(([k]) => !k.startsWith('_')).map(([, p]) => p),
    ...(manifest.artists ?? []).flatMap((a) => [
      a.menuCard, a.menuPlate,
      ...Object.entries(a.ui ?? {}).filter(([k]) => !k.startsWith('_')).map(([, p]) => p),
    ]),
  ].filter((p) => p && assetInfo(p).exists);
  await Promise.all(toDecode.map((p) => preloadImage(url(p))));

  buildMenu();
  showScreen('menu');
  idle.start();

  // Escape hatch for renderer memory creep on a multi-week install: if the kiosk
  // has been parked on the menu untouched for a long time, reload the page.
  const reloadAfter = manifest.kiosk?.menuReloadAfterMs ?? 0;
  if (reloadAfter > 0) {
    setInterval(() => {
      if (activeScreen === 'menu' && menuIdleSince && Date.now() - menuIdleSince > reloadAfter) {
        location.reload();
      }
    }, 60000);
  }
}

/* ------------------------------------------------- windowed / fullscreen ----
 * F11 drops out of fullscreen into a portrait window matching the design aspect,
 * which is far more usable for checking the layout than an arbitrary rectangle.
 *
 * Chrome only honours window.resizeTo for app-mode windows, so this is attempted
 * and allowed to fail; start.bat also passes --window-size, which means Chrome
 * restores to the same portrait size on its own when fullscreen is exited. Either
 * path lands in the right place, and the canvas rescales to whatever it gets.
 */
function applyWindowedSize() {
  const w = manifest?.kiosk?.windowedWidth ?? 608;
  const h = manifest?.kiosk?.windowedHeight ?? 1080;
  try { window.resizeTo(w, h); } catch { /* not permitted for this window type */ }
}

const isFullscreenish = () =>
  Boolean(document.fullscreenElement) ||
  (window.innerWidth >= screen.width - 8 && window.innerHeight >= screen.height - 80);

/* Esc is the single operator key:
 *   from any panel  -> back to the main menu
 *   from the menu   -> close the application
 * Under Electron that quits the app outright; in a browser window.close() only works
 * for script-opened windows, so it falls back to a blank page rather than doing
 * nothing visible. */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  if (activeScreen !== 'menu') {
    transition(goMenu);
    return;
  }
  if (window.kraf?.quit) window.kraf.quit();
  else { try { window.close(); } catch { /* ignore */ } }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'F11') return;
  e.preventDefault();
  if (isFullscreenish()) {
    document.exitFullscreen?.().catch(() => {});
    setTimeout(applyWindowedSize, 60);
  } else {
    document.documentElement.requestFullscreen?.().catch(() => {});
  }
});

// Chrome's own F11 bypasses the handler above in some window modes; catch the
// resulting transition and still land on the intended portrait size.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) setTimeout(applyWindowedSize, 60);
});

/* Kiosk hygiene: no context menu, no drag-and-drop of media, no pinch-zoom of
   the page itself (the model viewer handles its own pinch). */
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('dragstart', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());
/* Cursor stays visible everywhere while the exhibit is being built and tested on a
   desktop. To hide it for the museum floor (a touchscreen needs no pointer), set
   kiosk.hideCursor: true in content.json, or open with ?cursor=off. */
const cursorParam = new URLSearchParams(location.search).get('cursor');
function applyCursorPolicy() {
  const hide = cursorParam === 'off' || (cursorParam !== 'on' && manifest?.kiosk?.hideCursor === true);
  document.body.classList.toggle('kiosk', hide);
}
applyCursorPolicy();

boot();
