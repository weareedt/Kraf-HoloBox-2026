/**
 * Turntable viewer: a pre-rendered image sequence scrubbed by dragging.
 *
 * Implements the same interface as the 3D model viewer (mount / setRotation / setZoom
 * / reset / setScreenCentre / dispose), so the products screen, the control binder and
 * the manifest treat both kinds of product identically. Only the manifest's `type`
 * decides which viewer is used.
 *
 * Behaviour, as specified for Norhaiza's keris:
 *
 *   - Dragging scrubs the frames and LOOPS: the source is a full 360-degree turn, so
 *     the last frame sits next to the first and the wrap is seamless. (No
 *     `rotationLimits` is declared, so the control binder wraps instead of clamping.)
 *   - Every mount starts on the first frame. Switching keris re-mounts, and leaving the
 *     panel disposes, so both reset the frame without any extra bookkeeping.
 *
 * Memory is the real constraint. One turn of 76 frames is ~350 MB once decoded, even
 * after the build step crops each frame to the keris. So:
 *
 *   - only the product on screen is ever resident — dispose() closes every bitmap;
 *   - frame 0 is painted the moment it decodes, and the rest load behind it, so a
 *     switch between keris shows a picture immediately rather than a blank panel;
 *   - bitmaps are decoded at full source resolution, because the 4K panel needs every
 *     pixel and zoom would otherwise go soft.
 */

const LOAD_CONCURRENCY = 6;

function frameUrl(seq, i, url) {
  const n = i + (seq.start ?? 0);
  // "{i}" or "{i:02}" -> zero-padded frame number
  return url(seq.pattern.replace(/\{i(?::(\d+))?\}/, (_, pad) => String(n).padStart(+pad || 0, '0')));
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`frame failed: ${src}`));
    img.src = src;
  });
}

export async function mountSequence({ product, viewport, url }) {
  const seq = product.sequence ?? {};
  const count = seq.count ?? 1;
  const fit = seq.fitHeight ?? 0.92;          // fraction of the viewport height
  // The frame column the object's middle sits on, in SOURCE pixels. Absent, the frame's own
  // middle. Set it when a turn was shot off-centre in an uncropped frame (Johnny's bare
  // blade sits 87 px right of its frame's centre), so the object, not the frame, is centred.
  const centreX = Number.isFinite(seq.centreX) ? seq.centreX : null;

  /* ------------------------------------------------------------- stage */

  const canvas = document.createElement('canvas');
  canvas.className = 'seq-canvas';
  viewport.appendChild(canvas);
  const ctx = canvas.getContext('2d', { alpha: true });

  const bitmaps = new Array(count).fill(null);
  let disposed = false;
  let frame = 0;
  let zoom = 1;
  let shiftPx = 0;
  let centreShift = 0;                         // CSS px that bring centreX to the middle

  /* ------------------------------------------------------------- layout */

  let natW = 1, natH = 1;
  function layout() {
    const vw = viewport.clientWidth || 1080;
    const vh = viewport.clientHeight || 1280;
    const cssH = vh * fit;
    const cssW = cssH * (natW / natH);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.style.left = `${(vw - cssW) / 2}px`;
    canvas.style.top = `${(vh - cssH) / 2}px`;
    // Only once frame 0 has given the real width; before that natW is a placeholder 1.
    centreShift = centreX === null || natW <= 1 ? 0 : (natW / 2 - centreX) * (cssW / natW);
    applyTransform();
  }

  function applyTransform() {
    // The scale is about the canvas centre, so the object's offset from it scales too.
    canvas.style.transform = `translateX(${shiftPx + centreShift * zoom}px) scale(${zoom})`;
  }

  /** Nearest frame that has actually decoded, so scrubbing never shows a blank. */
  function nearestLoaded(i) {
    if (bitmaps[i]) return bitmaps[i];
    for (let d = 1; d < count; d++) {
      if (bitmaps[i - d]) return bitmaps[i - d];
      if (bitmaps[i + d]) return bitmaps[i + d];
    }
    return null;
  }

  function draw() {
    const bmp = nearestLoaded(frame);
    if (!bmp) return;
    // Mirrored onto the element so the frame is visible to diagnostics and tests without
    // reaching into the closure; nothing in the app reads it.
    canvas.dataset.frame = String(frame);
    if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
      canvas.width = bmp.width;
      canvas.height = bmp.height;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0);
  }

  /* ------------------------------------------------------------- load */

  async function decode(i) {
    if (disposed || bitmaps[i]) return;
    const img = await loadImage(frameUrl(seq, i, url));
    if (disposed) return;
    const bmp = await createImageBitmap(img);
    if (disposed) { bmp.close(); return; }
    bitmaps[i] = bmp;
    if (i === frame || !nearestLoaded(frame) || Math.abs(i - frame) < 2) draw();
  }

  // Frame 0 first, and wait for it: the panel must never open blank.
  await decode(0);
  if (bitmaps[0]) { natW = bitmaps[0].width; natH = bitmaps[0].height; }
  layout();
  draw();

  // The rest behind it, a few at a time so the first swipe is not starved of decode time.
  (async () => {
    const queue = Array.from({ length: count - 1 }, (_, k) => k + 1);
    const workers = Array.from({ length: LOAD_CONCURRENCY }, async () => {
      while (!disposed && queue.length) {
        const i = queue.shift();
        try { await decode(i); } catch (e) { console.warn(e.message); }
      }
    });
    await Promise.all(workers);
  })();

  const onResize = () => layout();
  window.addEventListener('resize', onResize);

  /* ------------------------------------------------------------- api */

  // Degrees map onto frames so the shared drag sensitivity feels the same as the Wau.
  // 360 degrees is one full turn = `count` frames, so wrapping is modular and seamless.
  const degPerFrame = 360 / count;

  return {
    available: true,
    initialRotation: 0,

    setRotation(deg) {
      const next = ((Math.round(deg / degPerFrame) % count) + count) % count;
      if (next !== frame) { frame = next; draw(); }
    },
    setZoom(z) { zoom = z; applyTransform(); },
    setVariant() {},
    reset() { frame = 0; zoom = 1; applyTransform(); draw(); },

    /** Same contract as the model viewer: put the product at `designX` across. */
    setScreenCentre(designX) {
      const vw = viewport.clientWidth || 1080;
      shiftPx = Number.isFinite(designX) ? designX - vw / 2 : 0;
      applyTransform();
    },

    /** Current frame, exposed for tests and diagnostics only. */
    get frame() { return frame; },

    dispose() {
      disposed = true;
      window.removeEventListener('resize', onResize);
      for (let i = 0; i < bitmaps.length; i++) {
        bitmaps[i]?.close();          // free the decoded pixels now, not at GC time
        bitmaps[i] = null;
      }
      canvas.width = canvas.height = 0;
      canvas.remove();
    },
  };
}
