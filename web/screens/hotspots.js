/**
 * Product hotspots — pulsing markers over a product, each opening a zoom-in view.
 *
 * Maznah's Sungu Duri uses them: three markers sit on the basket (top, right, bottom)
 * and tapping one brings up a close-up of that part of the weave. A tap anywhere closes
 * it again.
 *
 * Two things about the zoom images are deliberate:
 *
 *   - ALL OF THEM ARE MOUNTED UP FRONT, at opacity 0, and the overlay they live in is
 *     never display:none. A hidden or not-yet-created <img> has nothing on the
 *     compositor, so the first tap would show a blank panel for however long the decode
 *     took. Keeping them composited means the fade always has a picture to fade to.
 *   - THE OVERLAY CARRIES AN OPAQUE BACKGROUND. It covers the turntable and the markers
 *     completely, so nothing shows through and the markers cannot be tapped behind it.
 *
 * The marker artwork is a white glow ring on transparent, used as a MASK over a coloured
 * box rather than as an image. That is what lets the colour animate: the pulse is one CSS
 * keyframe animation moving scale and background-color together, so it costs nothing per
 * frame and keeps running whatever JavaScript is doing.
 */

const DEFAULT_SIZE = 96;

export function mountHotspots({ product, url, assetInfo, els }) {
  const spots = (product.hotspots ?? []).filter((h) => h.image && assetInfo(h.image).exists);
  els.layer.innerHTML = '';
  els.zoom.innerHTML = '';
  els.zoom.classList.remove('is-open');
  if (!spots.length) return () => {};

  const size = product.hotspotSize ?? DEFAULT_SIZE;
  const art = product.hotspotArt && assetInfo(product.hotspotArt).exists
    ? url(product.hotspotArt) : null;

  const images = new Map();

  for (const spot of spots) {
    const img = document.createElement('img');
    img.className = 'product-zoom__img';
    img.src = url(spot.image);
    img.alt = spot.label ?? '';
    img.decoding = 'async';
    els.zoom.appendChild(img);
    images.set(spot.id, img);

    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hotspot';
    b.style.left = `${spot.x}px`;
    b.style.top = `${spot.y}px`;
    b.style.width = `${size}px`;
    b.style.height = `${size}px`;
    b.style.margin = `${-size / 2}px 0 0 ${-size / 2}px`;   // x,y is the CENTRE
    b.setAttribute('aria-label', spot.label ?? spot.id);

    const glow = document.createElement('span');
    glow.className = 'hotspot__glow';
    if (art) glow.style.setProperty('--hot-img', `url("${art}")`);
    // Stagger the loop so three markers do not pulse in lockstep, which reads as a
    // flashing block rather than three separate invitations.
    glow.style.animationDelay = `${(spots.indexOf(spot) * 0.22).toFixed(2)}s`;
    b.appendChild(glow);

    b.addEventListener('click', (e) => {
      e.stopPropagation();          // or the overlay's own close would fire immediately
      open(spot.id);
    });
    els.layer.appendChild(b);
  }

  let openId = null;

  function open(id) {
    for (const [key, img] of images) img.classList.toggle('is-on', key === id);
    openId = id;
    els.zoom.classList.add('is-open');
  }

  function close() {
    openId = null;
    els.zoom.classList.remove('is-open');
    // Leave the picture in place until the fade has finished, or it vanishes instantly
    // and the fade has nothing to show.
    setTimeout(() => {
      if (!openId) for (const img of images.values()) img.classList.remove('is-on');
    }, 220);
  }

  const onZoomClick = () => close();
  els.zoom.addEventListener('click', onZoomClick);

  return () => {
    els.zoom.removeEventListener('click', onZoomClick);
    els.zoom.classList.remove('is-open');
    els.layer.innerHTML = '';
    els.zoom.innerHTML = '';
  };
}
