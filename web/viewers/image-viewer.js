/**
 * Single-image viewer.
 *
 * The simplest product type: one picture, shown as large as its box allows. Bangie's
 * Tenunan Pua uses it — five views of one cloth, switched by the thumbnails in the
 * products rail, which is why each view is registered as its own product rather than
 * as a variant. The rail then gives the pressed/disabled behaviour for free.
 *
 * It implements the same interface as the model and turntable viewers, so the products
 * screen, the control binder and the manifest treat it identically. There is simply
 * nothing to rotate, and the "zoom" in these views is baked into the artwork — each
 * image IS a closer crop — so the rotation and zoom hooks are honoured but inert
 * unless the manifest actually declares controls for them.
 *
 * An <img> is used rather than a canvas on purpose: the browser decodes off-thread,
 * downscales these 1400x2400 masters with its own high-quality filter, and frees the
 * pixels when the element goes. `decode()` is awaited so the products screen only
 * lifts its swap-fade onto a picture that is ready to paint.
 */

export async function mountImage({ product, viewport, url, assetInfo }) {
  const cfg = product.image ?? {};
  const src = cfg.src;

  const img = document.createElement('img');
  img.className = 'product-image';
  img.alt = product.title ?? '';
  img.draggable = false;
  viewport.appendChild(img);

  let zoom = 1;
  let shiftPx = 0;
  const applyTransform = () => {
    img.style.transform = `translateX(${shiftPx}px) scale(${zoom})`;
  };

  // A missing file must not blank the panel silently — the rail still works, and the
  // console says which view is absent.
  const available = Boolean(src) && assetInfo(src).exists;
  if (!available) {
    console.error(`image viewer: missing source for "${product.id}"`, src);
  } else {
    img.src = url(src);
    // decode() rejects on a broken file; the catch keeps a bad asset from throwing
    // out of mount() and tearing the screen down.
    try { await img.decode(); } catch (e) { console.warn('image decode failed', e); }
  }

  applyTransform();

  return {
    available,
    initialRotation: 0,

    setRotation() {},
    setZoom(z) { zoom = z; applyTransform(); },
    setVariant() {},
    reset() { zoom = 1; applyTransform(); },

    /** Same contract as the other viewers: put the product at `designX` across.
     *  `null` means "stay centred in the viewport", which is what the Explore layout
     *  wants — its viewport box is already the picture's designed position. */
    setScreenCentre(designX) {
      const vw = viewport.clientWidth || 1080;
      shiftPx = Number.isFinite(designX) ? designX - vw / 2 : 0;
      applyTransform();
    },

    dispose() {
      img.removeAttribute('src');   // drop the decoded pixels now, not at GC time
      img.remove();
    },
  };
}
