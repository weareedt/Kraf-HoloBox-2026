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

  async function select(i) {
    // Tapping the product already on screen must do nothing. Without this guard it
    // disposed and re-mounted the same keris, and the panel visibly blinked. (Its
    // button is also disabled below; this covers any other caller.)
    if (i === index && viewer) return;
    const switching = Boolean(viewer);
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

    /* Switching products fades the product and its title out to the backdrop, swaps
     * while hidden, and fades back in once the new one has painted — so the dispose,
     * the blank viewport and the first-frame load are never seen. The buttons stay
     * put throughout. The first mount on entering the panel does not fade: the
     * panel's own white transition already covers it. */
    if (switching) {
      setSwapping(true);
      await sleep(swapMs);
      if (stale()) return;              // a newer tap took over mid-fade
    }

    unbind?.();
    unbind = null;
    unspot?.();
    unspot = null;
    viewer?.dispose?.();
    viewer = null;
    els.viewport.innerHTML = '';

    paintMeta(product);

    const mount = VIEWERS[product.type];
    if (!mount) {
      console.error(`no viewer registered for product type "${product.type}"`);
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
      if (!stale()) setSwapping(false);
      return;
    }
    // A newer tap arrived while this one was loading: drop it rather than let two
    // products fight over the viewport.
    if (stale()) { mounted?.dispose?.(); return; }
    viewer = mounted;

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
      els: { layer: els.hotspots, zoom: els.zoom },
    });

    // Centre the product in the free space between the buttons. Done after the
    // controls exist, since their position is what defines that space.
    // A per-product nudge (camera.centreOffsetX) is added on top, since the measured
    // gap centre is a starting point and the final placement is an eye judgement.
    const gap = freeSpaceCentre(els.viewport.closest('.screen'), els.side ?? els.controls);
    const nudge = product.centreOffsetX ?? product.model?.camera?.centreOffsetX ?? 0;
    viewer.setScreenCentre?.(gap == null ? null : gap + nudge);

    if (switching) {
      // let the new product paint behind the fade before revealing it
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (!stale()) setSwapping(false);
    }
  }

  await select(0);
  void index;

  /* ---------------------------------------------------------- dispose */

  return () => {
    selectToken++;                    // cancel any switch still in flight
    setSwapping(false);
    unspot?.();
    unspot = null;
    unbind?.();
    viewer?.dispose?.();
    viewer = null;
    els.viewport.innerHTML = '';
    els.controls.innerHTML = '';
    els.meta.innerHTML = '';
    els.rail.innerHTML = '';
    if (screenEl) delete screenEl.dataset.layout;
    for (const stack of document.querySelectorAll('.zoom-stack')) stack.remove();
  };
}
