/**
 * Main menu — the artist carousel.
 *
 * WHY THIS IS NOT THE PEMBUATAN CAROUSEL. That one has a fixed number of slides with two
 * ends, so a slide can simply sit still at the edge. This one loops, and looping with one
 * DOM element per artist does not work: three visible slots plus a staging slot either
 * side need five positions, and four artists cannot fill five. One card always had to
 * teleport from the left edge to the right edge, and no amount of hiding that made the
 * exit read correctly — the card vanished where it stood instead of sliding away.
 *
 * So the strip is built from REPEATED COPIES of the artist list, long enough that the
 * visible window never reaches either end. Sliding is then just the window moving along
 * the strip: every card moves exactly one slot per step, out to the left and in from the
 * right, and nothing ever jumps.
 *
 * The loop is closed by shifting the window back by exactly one full copy when it drifts
 * too far. Because the strip repeats with period `n`, that shift is pixel-for-pixel
 * identical on screen — it is applied with transitions off and is genuinely invisible,
 * unlike the per-card teleport it replaces.
 *
 * Manual and self-driving motion run through the same path and differ only in duration,
 * so a tap and a drift step look like the same movement at different speeds.
 */

const AUTO_MS = 5300;      // per artist while self-driving
const MANUAL_MS = 420;     // a tap, a swipe, or settling after a touch
const RESUME_MS = 3000;    // idle time after a touch before self-driving resumes

const SIDE_SCALE = 0.68;

/* The carousel has two looks, and switching between them is itself animated.
 *
 *   auto    nobody is touching it: every artist is shown at full size and full opacity,
 *           packed as closely as they go, so it reads as a showcase gliding past rather
 *           than one artist with two dim understudies.
 *   manual  somebody is choosing: the selected artist is lifted out of the row — the
 *           neighbours drop back in size and opacity, and the row tightens up.
 *
 * SPACING IS DERIVED, NOT CHOSEN. The card artwork measures 418px of visible width at
 * full size (the name plate, not the portrait, is the widest part; both carry transparent
 * glow margins, so the element box is wider than anything you can see). Neighbouring
 * cards must not touch, so:
 *
 *   auto    both cards full size   -> 418 + a 22px gap            = 440
 *   manual  one full, one at 0.68  -> 209 + 418*0.68/2 + 9px gap  = 360
 *
 * Anything smaller overlaps. 370 was the old single value; manual is slightly tighter.
 */
const MODES = {
  auto: {
    spread: 440,
    scale: () => 1,
    // |d| >= 2 is off-screen at this spacing; fading there only guards the edge.
    fade: (d) => clamp(1 - clamp(Math.abs(d) - 2, 0, 1), 0, 1),
  },
  manual: {
    spread: 360,
    scale: (d) => 1 - (1 - SIDE_SCALE) * clamp(Math.abs(d), 0, 1),
    fade: (d) => clamp(1 - 0.28 * clamp(Math.abs(d), 0, 1)
                         - 0.72 * clamp(Math.abs(d) - 1, 0, 1), 0, 1),
  },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const MANUAL_EASE = 'cubic-bezier(.22,.7,.3,1)';
const AUTO_EASE = 'linear';   // linear, or each step would visibly pulse

export function mountMenu({ artists, manifest, url, assetInfo, els, onPick }) {
  const list = [...artists]
    .filter((a) => a.enabled !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const n = list.length;
  els.carousel.innerHTML = '';

  /* The window shows offset-2 .. offset+2, so the strip needs a copy either side of the
   * one being looked at. Few artists need more copies to cover the same five slots. */
  const COPIES = Math.max(3, Math.ceil(9 / Math.max(n, 1)));
  const BASE = n * Math.floor(COPIES / 2);     // the copy the window starts in
  const TOTAL = n * COPIES;

  let offset = BASE;          // which strip position is centred; may be fractional mid-glide
  let suppressClick = false;
  let autoTimer = null;
  let resumeTimer = null;
  let active = false;
  const cards = [];

  /* ---------------------------------------------------------- build */

  for (let j = 0; j < TOTAL; j++) {
    const artist = list[j % n];
    const card = document.createElement('button');
    card.className = 'artist-card';
    card.type = 'button';
    card.setAttribute('aria-label', `${artist.name} — ${artist.honorific ?? ''}`);

    // The press scale lives on an inner wrapper: the card's own transform is owned by
    // the carousel, and a :active rule on the card would throw away its position.
    const inner = document.createElement('span');
    inner.className = 'artist-card__inner';

    const cardSrc = url(artist.menuCard ?? artist.menuPortrait);
    const art = document.createElement('img');
    art.className = 'artist-card__art';
    art.alt = '';
    art.src = cardSrc;
    inner.appendChild(art);

    if (artist.menuPlate && assetInfo(artist.menuPlate).exists) {
      const plate = document.createElement('img');
      plate.className = 'artist-card__plate';
      plate.alt = '';
      plate.src = url(artist.menuPlate);
      inner.appendChild(plate);
    }

    card.appendChild(inner);
    card.addEventListener('click', () => {
      // Swallowed when the tap was a swipe, or when it was the tap that stopped the
      // drift. Reset on the next pointerdown, never here.
      if (suppressClick) return;
      if (j === offset) onPick(artist);     // already centred: open it
      else goTo(j, { ms: MANUAL_MS });      // otherwise just bring it in
    });
    els.carousel.appendChild(card);
    cards.push(card);
  }

  /* ---------------------------------------------------------- layout */

  // The mode's scale and fade are piecewise-linear in |d|, which matters: with `linear`
  // easing the browser's interpolation between two steps then equals the function itself,
  // so pinning the cards mid-glide (see settle) reproduces exactly what is on screen.
  let mode = 'auto';        // the menu arrives self-driving

  function layoutAt(off, { ms = MANUAL_MS, easing = MANUAL_EASE, m = mode } = {}) {
    const cfg = MODES[m];
    cards.forEach((card, j) => {
      const d = j - off;
      card.style.transitionProperty = ms > 0 ? 'transform, opacity' : 'none';
      card.style.transitionDuration = `${ms}ms`;
      card.style.transitionTimingFunction = easing;
      card.style.transform = `translateX(${d * cfg.spread}px) scale(${cfg.scale(d)})`;
      card.style.opacity = String(cfg.fade(d));
      // Fine-grained, because mid-glide d is fractional and two cards rounding to the
      // same z would let the stacking order flip under them.
      card.style.zIndex = String(Math.round(100 - Math.abs(d) * 10));
      card.style.pointerEvents = Math.abs(d) <= 1 ? 'auto' : 'none';
      card.setAttribute('aria-current', String(d === 0));
    });
    // Commit an instant layout before anything animates off it, or the browser coalesces
    // the two and animates from the OLD position — which is the loop shift becoming
    // visible as a long slide.
    if (ms === 0 && cards.length) void cards[0].offsetWidth;
  }

  /** Move the window by a whole number of copies. Identical on screen, so it is instant. */
  function shiftCopies(k) {
    offset += k * n;
    layoutAt(offset, { ms: 0 });
  }

  /** Animate the window to strip position `target`, looping it back into range first. */
  function goTo(target, opts = {}) {
    let t = target;
    while (t >= BASE + n) { shiftCopies(-1); t -= n; }
    while (t < BASE)      { shiftCopies(1);  t += n; }
    offset = t;
    layoutAt(t, opts);
  }

  /**
   * Where the cards actually are right now, in strip positions (may be fractional).
   *
   * The spacing is read from two neighbouring cards rather than taken from the mode,
   * because a touch can land while the row is still re-spacing between the two looks —
   * at which point neither mode's `spread` is what is on screen.
   */
  function visualOffset() {
    if (cards.length < 2) return offset;
    const x0 = new DOMMatrixReadOnly(getComputedStyle(cards[0]).transform).m41;
    const x1 = new DOMMatrixReadOnly(getComputedStyle(cards[1]).transform).m41;
    const spread = x1 - x0;
    if (!Number.isFinite(spread) || Math.abs(spread) < 1) return offset;
    return -x0 / spread;             // card 0 sits at (0 - offset) * spread
  }

  /**
   * Stop the drift where it is and run to the NEAREST artist at the manual speed.
   *
   * Changing transition-duration does not retime a transition already running, so the
   * current position has to be pinned first — otherwise a touch during the glide would
   * leave the strip creeping for the rest of it.
   */
  function pin() {
    const vis = visualOffset();
    offset = vis;
    layoutAt(vis, { ms: 0 });            // stop, still wearing the self-driving look
    mode = 'manual';                     // then lift the selection out of the row
  }

  /** Stop, and run to `target` — or to the nearest artist if none is given. */
  function settle(target) {
    pin();
    goTo(target ?? Math.round(offset), { ms: MANUAL_MS, easing: MANUAL_EASE });
  }

  /* -------------------------------------------------- self-driving ----
   * Runs only while the menu is the visible screen, so the kiosk is not animating a
   * hidden carousel for the whole time a visitor is inside an artist. */

  function stopAuto() {
    clearInterval(autoTimer);
    autoTimer = null;
  }

  function startAuto() {
    if (!active || autoTimer || n < 2) return;
    // The row opens back out to the showcase look as part of the first glide, so the
    // change of look arrives with the movement rather than snapping before it.
    mode = 'auto';
    const step = () => goTo(Math.round(offset) + 1, { ms: AUTO_MS, easing: AUTO_EASE });
    step();                                  // begin gliding immediately
    autoTimer = setInterval(step, AUTO_MS);  // each glide spans its whole interval
  }

  /** Any input: pause the drift, and arm a restart for when the visitor stops touching. */
  function nudge() {
    stopAuto();
    clearTimeout(resumeTimer);
    if (active) resumeTimer = setTimeout(startAuto, RESUME_MS);
  }

  /* ---------------------------------------------------------- input */

  let startX = null;
  const onDown = (e) => {
    startX = e.clientX;
    const wasDrifting = Boolean(autoTimer);
    nudge();
    // While drifting there is no settled centre to tap, and a card that merely LOOKS like
    // a neighbour may already be the selected one — tapping it would open an artist the
    // visitor never chose. So the touch that stops the drift never opens anything;
    // choosing takes a second, deliberate tap.
    //
    // It does still honour WHICH card it landed on: tap a side card and that card comes
    // to the middle. Only a tap that misses the cards falls back to the nearest one.
    suppressClick = wasDrifting;
    if (!wasDrifting) return;
    const hit = e.target?.closest?.('.artist-card');
    const j = hit ? cards.indexOf(hit) : -1;
    settle(j >= 0 ? j : undefined);
  };
  const onUp = (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    startX = null;
    nudge();
    if (Math.abs(dx) < 60) return;          // too small to be a swipe: let the tap land
    suppressClick = true;                   // it was a swipe, so the click that follows is not a tap
    goTo(Math.round(offset) + (dx < 0 ? 1 : -1), { ms: MANUAL_MS });
  };

  els.screen.addEventListener('pointerdown', onDown);
  els.screen.addEventListener('pointerup', onUp);
  els.screen.addEventListener('pointercancel', () => { startX = null; });

  layoutAt(offset, { ms: 0 });              // first paint: place the cards, do not animate

  /* ---------------------------------------------------------- api */

  return {
    setActive(on) {
      active = on;
      if (on) startAuto();
      else { stopAuto(); clearTimeout(resumeTimer); }
    },
    dispose() {
      stopAuto();
      clearTimeout(resumeTimer);
      els.screen.removeEventListener('pointerdown', onDown);
      els.screen.removeEventListener('pointerup', onUp);
      els.carousel.innerHTML = '';
    },
  };
}
