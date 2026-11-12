/**
 * Produk screen.
 *
 * Dispatches purely on `product.type`. No artist is named here, and adding a new
 * product technique later means adding a module plus a `type` string — nothing in
 * this file needs to change beyond one entry in VIEWERS.
 *
 * An unregistered `type` fails loudly in the console rather than silently rendering
 * nothing, so a typo in content.json is caught on first test.
 */

import { mountModel } from '../viewers/model-viewer.js';
import { mountSequence } from '../viewers/sequence-viewer.js';
import { mountImage } from '../viewers/image-viewer.js';
import { bindControls } from '../viewers/controls.js';
import { mountHotspots } from './hotspots.js';
import { playTutorial } from './tutorial.js';
import { playIntro, productPicture } from './intro.js';

/**
 * Button PNGs carry a transparent glow margin, so their element box is wider than the
 * pill a visitor actually sees. Measured on the supplied artwork: the visible pill
 * starts ~11% in from the left of its box.
 */
const PILL_GLOW_INSET = 0.11;

/**
 * Centre of the free horizontal space between the back button and the control column,
 * in design pixels. Measured from the real layout rather than hard-coded, so the product
 * stays centred in the gap if the buttons move or another artist has a different set.
 * Returns null if either side cannot be found, which leaves the axis at screen centre.
 */
function freeSpaceCentre(screenEl, sideEl) {
  const canvas = document.getElementById('canvas');
  const back = screenEl?.querySelector('.btn-back');
  if (!canvas || !back || !sideEl) return null;

  const c = canvas.getBoundingClientRect();
  const scale = c.width / 1080 || 1;
  const toDesign = (px) => (px - c.left) / scale;

  const left = toDesign(back.getBoundingClientRect().right);

  // Every button on the right — controls AND the product switcher icons.
  const buttons = [...sideEl.querySelectorAll('.imgbtn')].map((b) => b.getBoundingClientRect());
  if (!buttons.length) return null;
  const right = Math.min(...buttons.map((r) => toDesign(r.left + r.width * PILL_GLOW_INSET)));

  return right > left ? (left + right) / 2 : null;
}

const VIEWERS = {
  model: mountModel,          // Samat's Wau: a real 3D model
  sequence: mountSequence,    // Norhaiza's keris: a pre-rendered turntable
  image: mountImage,          // Bangie's Tenunan Pua: one hi-res photograph
};

export async function mountProducts({ artist, products, manifest, url, assetInfo, els }) {
  /* Panel geometry is per-artist, because the panels genuinely differ: the Wau and the
   * keris are objects centred in the free space between the buttons, while Bangie's
   * cloth is a full-height picture with its title top-right and the switcher at mid-
   * right (see "Preview Product Explore (UI placement).png"). CSS keys off this
   * attribute, so a new layout is a stylesheet block plus one string in content.json. */
  const screenEl = els.viewport.closest('.screen');
  if (screenEl) screenEl.dataset.layout = artist?.productsLayout ?? '';

  const list = [...products]
    .filter((p) => p.enabled !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  let index = 0;
  let viewer = null;
  let unbind = null;
  let unspot = null;
  let selectToken = 0;
  let productCentreX = null;            // design px; where select() centred the product

  // Fast fade used when switching between products (e.g. the two keris). Each half
  // of the fade lasts this long; set kiosk.productSwapFadeMs in content.json.
  const swapMs = manifest.kiosk?.productSwapFadeMs ?? 160;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fading = [els.viewport, els.meta];
  for (const el of fading) el.style.setProperty('--swap-ms', `${swapMs}ms`);
  function setSwapping(on) {
    for (const el of fading) el.classList.toggle('is-swapping', on);
  }

  /* ---------------------------------------------------------- rail */

  els.rail.innerHTML = '';
  els.rail.hidden = list.length < 2;   // one product needs no switcher
  if (list.length > 1) {
    list.forEach((p, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(i === 0));
      b.setAttribute('aria-label', p.title ?? `Produk ${i + 1}`);
      // A supplied icon is finished artwork (frame and glow included), so it becomes
      // the button itself; a plain thumbnail gets the generic bordered tile instead.
      if (p.icon && assetInfo(p.icon).exists) {
        b.className = 'imgbtn rail-icon';
        b.style.backgroundImage = `url("${url(p.icon)}")`;
        b.style.setProperty('--btn-img', `url("${url(p.icon)}")`);
      } else if (p.thumb && assetInfo(p.thumb).exists) {
        const img = document.createElement('img');
        img.src = url(p.thumb);
        img.alt = p.title ?? '';
        b.appendChild(img);
      } else {
        b.textContent = String(i + 1);
      }
      b.addEventListener('click', () => select(i));
      els.rail.appendChild(b);
    });
  }

  /* ---------------------------------------------------------- meta */

  function paintMeta(product) {
    els.meta.innerHTML = '';

    // A designed title block (image) replaces the text entirely when supplied.
    if (product.metaImage && assetInfo(product.metaImage).exists) {
      const img = document.createElement('img');
      img.className = 'product-meta__image';
      img.src = url(product.metaImage);
      img.alt = [product.title, ...(product.meta ?? [])].filter(Boolean).join(' — ');
      els.meta.appendChild(img);
      return;
    }

    const title = document.createElement('div');
    title.className = 'product-meta__title';
    title.textContent = product.title ?? '';
    els.meta.appendChild(title);
    for (const line of product.meta ?? []) {
      const d = document.createElement('div');
      d.className = 'product-meta__line';
      d.textContent = line;
      els.meta.appendChild(d);
    }
  }

  /* ---------------------------------------------------------- select */

  const dropControls = () => {
    unbind?.();
    unbind = null;
    els.controls.style.pointerEvents = '';
  };

  /** Controls, markers and centring for the viewer just mounted. */
  function bindProduct(product) {
    // Old buttons out and new ones in, in one go (see the note at the fade).
    dropControls();
    unbind = bindControls({
      specs: product.controls ?? [],
      viewer,
      strings: manifest.strings ?? {},
      ui: manifest.ui ?? {},
      url,
      els: { controls: els.controls, viewport: els.viewport },
    });

    // Controls that drive a model make no sense over a placeholder.
    if (!viewer.available) {
      for (const el of els.controls.querySelectorAll('button, input')) el.disabled = true;
    }

    // Markers over the product, and the zoom-in views they open. Mounted even when the
    // product declares none, so a previous product's markers are always cleared.
    unspot = mountHotspots({
      product, url, assetInfo,
      els: { layer: els.hotspots, zoom: els.zoom, viewport: els.viewport },
    });

    // Centre the product in the free space between the buttons. Done after the
    // controls exist, since their position is what defines that space.
    // A per-product nudge (camera.centreOffsetX) is added on top, since the measured
    // gap centre is a starting point and the final placement is an eye judgement.
    viewer.setScreenCentre?.(centreFor(product));
    productCentreX = centreFor(product);
  }

  function centreFor(product) {
    const gap = freeSpaceCentre(els.viewport.closest('.screen'), els.side ?? els.controls);
    const nudge = product.centreOffsetX ?? product.model?.camera?.centreOffsetX ?? 0;
    return gap == null ? null : gap + nudge;
  }

  /* ---------------------------------------------------------- sheath swap
   * A sheathed product (`sheath.bare` names its bare twin) swaps with its twin by DRAWING
   * the blade: the sheath image, laid exactly over the sheathed turntable's frame, slides
   * straight down off the blade and dissolves through its mask (which covers the sheath
   * only); switching back plays it in reverse and seats the sheath. Johnny's parang, 10 Nov
   * 2026. The turntables are swapped UNDER the sheath without clearing the viewport first,
   * so the panel never blinks; the new viewer is centred in the same task it is mounted,
   * before anything paints. Both directions run from frame 0: a turned parang is faded back
   * to its front first. The rail is untappable while it plays. */
  let sheathLayer = null;
  let unlockDrag = null;

  function sheathPlan(from, to) {
    const ok = (s) => s?.image && s?.mask && assetInfo(s.image).exists && assetInfo(s.mask).exists;
    if (from?.sheath?.bare === to.id && ok(from.sheath)) return { sheathed: from, dir: 'out' };
    if (to.sheath?.bare === from?.id && ok(to.sheath)) return { sheathed: to, dir: 'in' };
    return null;
  }

  /** The sheathed turntable's frame box in viewport px -- the viewer's own layout(). */
  function frameBox(p, natW, natH, centreX) {
    const vw = els.viewport.clientWidth || 1080, vh = els.viewport.clientHeight || 1280;
    const seq = p.sequence ?? {};
    const cssH = vh * (seq.fitHeight ?? 0.92), k = cssH / natH, cssW = natW * k;
    const shift = centreX == null ? 0 : centreX - vw / 2;
    const left = (vw - cssW) / 2 + shift + (Number.isFinite(seq.centreX) ? (natW / 2 - seq.centreX) * k : 0);
    const top = (vh - cssH) / 2 + (Number.isFinite(seq.centreY) ? (natH / 2 - seq.centreY) * k : 0);
    return { left, top, width: cssW, height: cssH, k };
  }

  async function sheathSwap({ sheathed, dir }, product, stale) {
    const s = sheathed.sheath;
    els.rail.style.pointerEvents = 'none';
    els.controls.style.pointerEvents = 'none';
    // No turning the parang while the sheath moves, either way: the drag is swallowed
    // before the controls' own handlers see it. In the capture phase, so even a drag that
    // was already under way (its pointer captured by the viewport) stops dead.
    const block = (e) => { e.stopImmediatePropagation(); e.preventDefault(); };
    const LOCKED = ['pointerdown', 'pointermove', 'pointerup', 'wheel'];
    for (const t of LOCKED) els.viewport.addEventListener(t, block, true);
    unlockDrag = () => {
      for (const t of LOCKED) els.viewport.removeEventListener(t, block, true);
      unlockDrag = null;
    };
    unspot?.();
    unspot = null;

    // 1. The parang on screen back to its front frame and natural size, behind a quick
    //    fade, if it was turned or pinched: the sheath only fits the parang at rest.
    const canvas = els.viewport.querySelector('canvas.seq-canvas');
    const zoomed = canvas && !/scale\(1\)\s*$/.test(canvas.style.transform);
    const faded = (Number.isFinite(viewer?.frame) && viewer.frame !== 0) || zoomed;
    if (faded) {
      setSwapping(true);
      await sleep(swapMs);
      if (stale()) return;
      if (viewer.reset) viewer.reset(); else viewer.setRotation?.(0);
    }
    paintMeta(product);

    // 2. The sheath, over the sheathed turntable's frame, inside its mask.
    const img = new Image();
    img.src = url(s.image);
    try { await img.decode(); } catch { /* still try: the swap must not hang */ }
    if (stale()) return;
    const cx = centreFor(product);
    const box = frameBox(sheathed, img.naturalWidth || 1080, img.naturalHeight || 2048, cx);
    const layer = document.createElement('div');
    layer.className = 'sheath-layer';
    Object.assign(layer.style, {
      left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`,
    });
    layer.style.setProperty('--sheath-mask', `url("${url(s.mask)}")`);
    // What moves: the sheath, and behind it a solid fill in the panel's backdrop from its
    // mouth down -- an opaque sheath, in effect, so nothing of the bare blade behind can
    // show below the mouth (user, 10 Nov 2026: the photographed blade does not sit exactly
    // in the photographed sheath, and its tip peeked out near the end of the draw). The
    // fill is the backdrop colour, not pure white, so no lighter box shows round it; the
    // mask dissolves it along with the sheath.
    const mover = document.createElement('div');
    mover.className = 'sheath-layer__move';
    if (s.fill) {
      const fill = document.createElement('div');
      fill.className = 'sheath-layer__fill';
      const colour = s.fill.colour ?? artist?.backdrop ?? '#EFEFEF';
      const soft = (s.fill.soft ?? 20) * box.k;
      fill.style.top = `${(s.fill.fromY ?? 0) * box.k}px`;
      fill.style.background = `linear-gradient(to bottom, transparent, ${colour} ${soft}px)`;
      mover.appendChild(fill);
    }
    img.className = 'sheath-layer__img';
    mover.appendChild(img);
    layer.appendChild(mover);
    /* The path: keyframes [travel, turn, sideways] in the sheathed frame's own pixels,
     * travel being how far the mouth has dropped, the turn (degrees, clockwise) about the
     * mouth's centre (`pivot`). A straight drop showed the curved blade beside the sheath,
     * so the sheath follows the curve instead (user, 10 Nov 2026; fitted, see README). */
    const path = Array.isArray(s.path) && s.path.length > 1
      ? s.path : [[0, 0, 0], [s.travelY ?? 1190, 0, 0]];
    const [px, py] = s.pivot ?? [img.naturalWidth / 2, 0];
    const end = path[path.length - 1][0] || 1;
    mover.style.transformOrigin = `${px * box.k}px ${py * box.k}px`;
    const keyframes = path.map(([d, turn, side]) => ({
      offset: d / end,
      transform: `translate(${(side ?? 0) * box.k}px, ${d * box.k}px) rotate(${turn ?? 0}deg)`,
    }));
    const duration = s.durationMs ?? 900;

    const swapViewer = async () => {
      // Mount the next turntable OVER the current one, centre it, then drop the old: no
      // frame paints with neither, or with the new one off-centre.
      const mounted = await VIEWERS[product.type]({
        product, viewport: els.viewport, url, assetInfo, strings: manifest.strings ?? {},
      });
      if (stale()) { mounted?.dispose?.(); return false; }
      mounted.setScreenCentre?.(cx);
      viewer?.dispose?.();
      viewer = mounted;
      return true;
    };
    const reveal = async () => {
      if (!faded) return;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      setSwapping(false);
      await sleep(swapMs);
    };
    // Drawing runs the path forward, easing in (the pull gathers speed); sheathing runs it
    // backward with the same curve, so it rises fast and settles as it seats.
    const slide = (direction) => mover.animate(keyframes, {
      duration, easing: 'ease-in', direction, fill: 'forwards',
    }).finished.catch(() => {});                          // cancelled by a dispose: fine

    sheathLayer = layer;
    try {
      if (dir === 'out') {
        mover.style.transform = keyframes[0].transform;     // seated: covers the sheathed one exactly
        els.viewport.appendChild(layer);
        if (!(await swapViewer())) return;
        await reveal();
        if (stale()) return;
        await slide('normal');                             // drawn: the sheath slides off and fades
      } else {
        mover.style.transform = keyframes[keyframes.length - 1].transform; // below, dissolved
        els.viewport.appendChild(layer);
        await reveal();
        if (stale()) return;
        await slide('reverse');                            // sheathed: it rises and seats
        if (stale()) return;
        if (!(await swapViewer())) return;                 // the sheathed turntable shows the same
      }
      if (stale()) return;
      bindProduct(product);
    } finally {
      // Whatever happened, this swap's sheath goes and the drag comes back; the rail
      // unlocks unless a newer select (or the panel's dispose) has taken over.
      layer.remove();
      if (sheathLayer === layer) sheathLayer = null;
      unlockDrag?.();
      if (!stale()) els.rail.style.pointerEvents = '';
    }
  }

  async function select(i) {
    // Tapping the product already on screen must do nothing. Without this guard it
    // disposed and re-mounted the same keris, and the panel visibly blinked. (Its
    // button is also disabled below; this covers any other caller.)
    if (i === index && viewer) return;
    const switching = Boolean(viewer);
    const from = viewer ? list[index] : null;
    const token = ++selectToken;
    const stale = () => token !== selectToken;
    index = i;
    const product = list[i];

    // Buttons swap state the instant they are tapped, before any fading or loading,
    // so the tap always feels answered. The product on screen shows as pressed and
    // cannot be tapped; only the others are live.
    [...els.rail.children].forEach((b, n) => {
      const active = n === i;
      b.setAttribute('aria-pressed', String(active));
      b.disabled = active;
    });

    const plan = switching ? sheathPlan(from, product) : null;
    if (plan) { await sheathSwap(plan, product, stale); return; }
    els.rail.style.pointerEvents = '';   // in case a sheath swap was cut short
    unlockDrag?.();

    /* Switching products fades the product and its title out to the backdrop, swaps
     * while hidden, and fades back in once the new one has painted — so the dispose,
     * the blank viewport and the first-frame load are never seen. The buttons stay
     * put throughout. The first mount on entering the panel does not fade: the
     * panel's own white transition already covers it. */
    if (switching) {
      // The control buttons are NOT part of the fade, so they must never be empty while
      // the next product loads: emptying them first (as this did) blinked + and - off
      // for the length of every load, and rapid switching made them flicker (user, 10
      // Nov 2026; measured 1-2 frames a switch even with the frames cached). The old
      // ones stay on screen, untappable, and are replaced in the same task as the new
      // viewer binds, so no frame paints without them.
      els.controls.style.pointerEvents = 'none';
      setSwapping(true);
      await sleep(swapMs);
      if (stale()) return;              // a newer tap took over mid-fade
    }

    unspot?.();
    unspot = null;
    viewer?.dispose?.();
    viewer = null;
    els.viewport.innerHTML = '';

    paintMeta(product);

    const mount = VIEWERS[product.type];
    if (!mount) {
      console.error(`no viewer registered for product type "${product.type}"`);
      dropControls();
      return;
    }

    let mounted;
    try {
      mounted = await mount({
        product,
        viewport: els.viewport,
        url,
        assetInfo,
        strings: manifest.strings ?? {},
      });
    } catch (e) {
      // A corrupt or unreadable model must never take the kiosk down.
      console.error('product viewer failed', e);
      viewer = null;
      if (!stale()) { dropControls(); setSwapping(false); }
      return;
    }
    // A newer tap arrived while this one was loading: drop it rather than let two
    // products fight over the viewport.
    if (stale()) { mounted?.dispose?.(); return; }
    viewer = mounted;
    bindProduct(product);

    if (switching) {
      // let the new product paint behind the fade before revealing it
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (!stale()) setSwapping(false);
    }
  }

  await select(0);
  void index;

  /* The drag/scale hint, once per visit to the panel (not on every product switch),
   * centred on the product as select() placed it. All input is locked while it plays
   * (tutorial.js). */
  let tutorial = null;
  let disposed = false;
  function startTutorial() {
    if (disposed || !els.tutorial) return;
    const v = els.viewport;
    tutorial = playTutorial({
      el: els.tutorial,
      product: list[index],
      ui: manifest.ui ?? {},
      url,
      assetInfo,
      centre: [productCentreX ?? v.offsetLeft + v.offsetWidth / 2, v.offsetTop + v.offsetHeight / 2],
    });
  }

  /* The product's intro video, if it has one, plays first; the hint follows it. Not
   * awaited, so this panel's dispose is in place while it runs (leaving mid-intro must
   * still clean up). Its markers wait for it too. */
  let intro = null;
  const first = list[0];
  if (first?.intro?.src && assetInfo(first.intro.src).exists) {
    els.hotspots.style.visibility = 'hidden';
    intro = playIntro({
      layerParent: els.viewport.parentNode, viewport: els.viewport, intro: first.intro, url,
      fadeMs: manifest.kiosk?.fadeMs ?? 420,
    });
    intro.done.then(() => {
      els.hotspots.style.visibility = '';
      startTutorial();
    });
    // Hold the panel's white transition until the video's first frame can paint (never
    // more than 2 s), then start it as the white lifts: no flash of the product first.
    await Promise.race([intro.ready, sleep(2000)]);
    intro.start();
  } else {
    startTutorial();
  }

  /* ---------------------------------------------------------- dispose */

  return () => {
    selectToken++;                    // cancel any switch still in flight
    disposed = true;
    intro?.skip();
    els.hotspots.style.visibility = '';
    sheathLayer?.remove();
    sheathLayer = null;
    unlockDrag?.();
    els.rail.style.pointerEvents = '';
    tutorial?.cancel();
    setSwapping(false);
    unspot?.();
    unspot = null;
    unbind?.();
    viewer?.dispose?.();
    viewer = null;
    els.viewport.innerHTML = '';
    els.controls.innerHTML = '';
    els.controls.style.pointerEvents = '';   // in case it was left mid-switch
    els.meta.innerHTML = '';
    els.rail.innerHTML = '';
    if (screenEl) delete screenEl.dataset.layout;
    for (const stack of document.querySelectorAll('.zoom-stack')) stack.remove();
  };
}
