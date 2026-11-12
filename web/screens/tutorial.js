/**
 * The drag/scale hint shown for 4 s when a product panel opens (user's brief, 10 Nov 2026).
 *
 *   0 - 2 s     the rotate hand, sliding 50 px each side of the product's centre, linear,
 *               on a fast loop
 *   2 - 4 s     the scale hand, static, over a square that grows 1x -> 2x, ease-out, looping
 *
 * It fades in very fast, crossfades between the two, and fades out at 4 s, then removes
 * itself. Which parts play comes from the product's own controls, not from the artist: a
 * `drag` control means "rotate", a `pinch` control means "scale". A product with only one of
 * them gets that part for the whole 4 s; with neither there is no hint. All input is
 * locked while it plays (user, 12 Nov 2026); it always runs its 4 s.
 *
 * Geometry is the designer's tap-icon document scaled by S (0.2: hands 102 px, square 92 px
 * at rest): the square's 440 px path (460 px
 * PNG with its stroke) grows about its own centre, and the scale hand's 512 px image sits
 * 165 px right and 137 px below that centre (measured off the user's two screenshots).
 */

// 4 s, 2 s per part, and everything at half the first size, slide included (user, 10 Nov
// 2026; it was 3 s at 0.4 with a 100 px slide). The phase timeline is in app.css.
const TOTAL_MS = 4000;
const S = 0.2;                           // document px -> design px
const SWAY = 50;                         // px each side of centre the rotate hand slides
const HAND_OFFSET = [165 * S, 137 * S];  // scale hand's centre from the square's centre
/* Each image is shown at its OWN pixel size x S, centred on its point. The designer's
 * glow versions (10 Nov 2026: 660 / 618 / 598 px, against 512 / 512 / 460) only pad the
 * canvas evenly -- the drawn hands and square are the same size and keep the same offset
 * from the canvas centre, measured -- so sizing by the file keeps them where they were and
 * any later re-export just works. Until an image has loaded its size is unknown, so it is
 * placed on load (the hint fades in over 0.15 s anyway). */

export function playTutorial({ el, product, ui, url, assetInfo, centre }) {
  const has = (rel) => Boolean(rel && assetInfo(rel).exists);
  const specs = product?.controls ?? [];
  const rotate = specs.some((s) => s.widget === 'drag') && has(ui.tutorialRotate);
  const scale = specs.some((s) => s.widget === 'pinch') && has(ui.tutorialScale) && has(ui.tutorialRect);
  el.innerHTML = '';
  el.className = 'product-tutorial';
  if (!rotate && !scale) { el.hidden = true; return { dismiss() {}, cancel() {} }; }

  const [cx, cy] = centre;
  const img = (rel, cls, x, y) => {
    const i = document.createElement('img');
    i.alt = ''; i.className = cls; i.decoding = 'async';
    const place = () => {
      const w = i.naturalWidth * S, h = i.naturalHeight * S;
      i.style.width = `${w}px`;
      i.style.left = `${x - w / 2}px`;
      i.style.top = `${y - h / 2}px`;
    };
    i.addEventListener('load', place, { once: true });
    i.src = url(rel);
    if (i.complete && i.naturalWidth) place();
    return i;
  };
  const phase = (name) => {
    const p = document.createElement('div');
    // `--solo` when this is the only part: it then holds for the whole 4 s.
    p.className = `tut-phase tut-phase--${name}${rotate && scale ? '' : ' tut-phase--solo'}`;
    p.style.animationDuration = `${TOTAL_MS}ms`;
    el.appendChild(p);
    return p;
  };

  el.style.setProperty('--tut-sway', `${SWAY}px`);
  if (rotate) phase('rotate').append(img(ui.tutorialRotate, 'tut-rotate', cx, cy));
  if (scale) {
    phase('scale').append(
      img(ui.tutorialRect, 'tut-rect', cx, cy),
      img(ui.tutorialScale, 'tut-scale', cx + HAND_OFFSET[0], cy + HAND_OFFSET[1]),
    );
  }
  el.hidden = false;

  // Nothing can be tapped while the hint plays, the back button included (user, 12 Nov
  // 2026, for every artist): a transparent sheet over the whole screen takes every touch
  // until it ends. (It used to fade out at a touch on the product; with input locked
  // there is no such touch, so it always runs its 4 s.)
  const block = document.createElement('div');
  block.className = 'input-block';
  for (const t of ['pointerdown', 'pointerup', 'click']) {
    block.addEventListener(t, (e) => { e.stopPropagation(); e.preventDefault(); });
  }
  el.parentNode?.appendChild(block);

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    block.remove();
    el.hidden = true;
    el.innerHTML = '';
  };
  const timer = setTimeout(finish, TOTAL_MS + 50);
  return { dismiss() {}, cancel: finish };
}
