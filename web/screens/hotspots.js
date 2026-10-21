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
 *   - THE OVERLAY ITSELF PAINTS NOTHING; the zoom view's own opaque white is what covers
 *     the turntable. The overlay only catches the tap that closes it, and while open it
 *     also stops the markers behind it being tapped.
 *
 * A marker is drawn one of two ways:
 *
 *   - `button` on the spot: finished artwork (Maznah's lettered A/B/C squares), drawn as
 *     an image, with a tinted halo pulsing out from behind it.
 *   - otherwise `hotspotArt` on the product: a white glow ring on transparent, used as a
 *     MASK over a coloured box rather than as an image, so its colour can animate.
 *
 * Either way the pulse is CSS keyframes on transform, opacity and background-color, so
 * it costs nothing per frame and keeps running whatever JavaScript is doing.
 *
 * Each zoom view can carry `info` cards: caption PNGs positioned in the view image's own
 * pixels (`product.zoomSize`). The view and its cards share one box, laid out at the
 * image's native size and scaled down as a unit, so the numbers in content.json are the
 * ones read off the Photoshop layout and the cards stay registered to the picture. On
 * every open the cards scale in 0 -> 1, one after another.
 */

const DEFAULT_SIZE = 96;

/* The zoom view's box on the design canvas, 730 x 1092, centred. Taken from the museum's
   own placement rather than chosen: their mock-up is a 608x1080 document — the app's
   windowed size — in which the view sits at 411 x 615, and 1080/608 scales that to
   730 x 1092 on the design canvas. */
const VIEW_BOX = [730, 1092];

const INFO_MS = 200;   // each card's scale-in, linear, one after another

export function mountHotspots({ product, url, assetInfo, els }) {
  const spots = (product.hotspots ?? []).filter((h) => h.image && assetInfo(h.image).exists);
  els.layer.innerHTML = '';
  els.zoom.innerHTML = '';
  els.zoom.classList.remove('is-open');
  if (!spots.length) return () => {};

  const size = product.hotspotSize ?? DEFAULT_SIZE;
  const art = product.hotspotArt && assetInfo(product.hotspotArt).exists
    ? url(product.hotspotArt) : null;

  // Without a declared size the image is laid out in the view box itself, scale 1.
  const [zw, zh] = product.zoomSize ?? VIEW_BOX;
  const scale = Math.min(VIEW_BOX[0] / zw, VIEW_BOX[1] / zh);

  const cards = new Map();     // spot id -> { card, infos }

  for (const spot of spots) {
    const card = document.createElement('div');
    card.className = 'product-zoom__card';
    card.style.width = `${zw}px`;
    card.style.height = `${zh}px`;
    card.style.transform = `translate(-50%, -50%) scale(${scale})`;

    const img = document.createElement('img');
    img.className = 'product-zoom__img';
    img.src = url(spot.image);
    img.alt = spot.label ?? '';
    img.decoding = 'async';
    card.appendChild(img);

    // Cards come after the picture in the DOM and sit above it in z-order.
    const infos = (spot.info ?? [])
      .filter((i) => i.image && assetInfo(i.image).exists)
      .map((i) => {
        const el = document.createElement('img');
        el.className = 'product-zoom__info';
        el.src = url(i.image);
        el.alt = '';
        el.decoding = 'async';
        el.style.left = `${i.x}px`;
        el.style.top = `${i.y}px`;
        card.appendChild(el);
        return el;
      });

    els.zoom.appendChild(card);
    cards.set(spot.id, { card, infos });

    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hotspot';
    b.style.left = `${spot.x}px`;
    b.style.top = `${spot.y}px`;
    b.style.width = `${size}px`;
    b.style.height = `${size}px`;
    b.style.margin = `${-size / 2}px 0 0 ${-size / 2}px`;   // x,y is the CENTRE
    b.setAttribute('aria-label', spot.label ?? spot.id);

    // Stagger the loop so three markers do not pulse in lockstep, which reads as a
    // flashing block rather than three separate invitations.
    const delay = `${(spots.indexOf(spot) * 0.22).toFixed(2)}s`;

    if (spot.button && assetInfo(spot.button).exists) {
      b.classList.add('hotspot--art');
      const halo = document.createElement('span');
      halo.className = 'hotspot__halo';
      const face = document.createElement('img');
      face.className = 'hotspot__face';
      face.src = url(spot.button);
      face.alt = '';
      face.decoding = 'async';
      halo.style.animationDelay = face.style.animationDelay = delay;
      b.append(halo, face);
    } else {
      const glow = document.createElement('span');
      glow.className = 'hotspot__glow';
      if (art) glow.style.setProperty('--hot-img', `url("${art}")`);
      glow.style.animationDelay = delay;
      b.appendChild(glow);
    }

    b.addEventListener('click', (e) => {
      e.stopPropagation();          // or the overlay's own close would fire immediately
      open(spot.id);
    });
    els.layer.appendChild(b);
  }

  let openId = null;
  let running = [];              // the info animations of the view currently open

  // Scale each card in from nothing, one after another. Called on EVERY open, so going
  // back and forth replays it; the old animations are cancelled first, or a quick
  // re-open would find the cards already at full size.
  function playInfo(infos) {
    for (const a of running) a.cancel();
    running = infos.map((el, i) => el.animate(
      [{ transform: 'scale(0)' }, { transform: 'scale(1)' }],
      // `both` holds each card at scale 0 until its turn, and at 1 afterwards.
      { duration: INFO_MS, delay: i * INFO_MS, easing: 'linear', fill: 'both' },
    ));
  }

  function open(id) {
    for (const [key, { card }] of cards) card.classList.toggle('is-on', key === id);
    openId = id;
    els.zoom.classList.add('is-open');
    playInfo(cards.get(id).infos);
  }

  function close() {
    openId = null;
    els.zoom.classList.remove('is-open');
    // Leave the picture in place until the fade has finished, or it vanishes instantly
    // and the fade has nothing to show.
    setTimeout(() => {
      if (!openId) for (const { card } of cards.values()) card.classList.remove('is-on');
    }, 220);
  }

  const onZoomClick = () => close();
  els.zoom.addEventListener('click', onZoomClick);

  return () => {
    for (const a of running) a.cancel();
    running = [];
    els.zoom.removeEventListener('click', onZoomClick);
    els.zoom.classList.remove('is-open');
    els.layer.innerHTML = '';
    els.zoom.innerHTML = '';
  };
}
