/**
 * Product intro: a short video of the product assembling (Bangie's pua unrolling, Maznah's
 * basket weaving itself), played once, muted, when the products panel opens -- before the
 * drag/scale hint. Its LAST frame is laid over the product's own starting picture, so when
 * it ends the real, draggable product simply takes over (user's brief, 10 Nov 2026).
 *
 * `product.intro = { src, box: [x, y, w, h] }`: box is the whole video frame expressed in
 * the product picture's own pixels (the turntable frame, or the still image), measured by
 * registering the video's last frame on that picture. The video is drawn wherever the
 * product is drawn -- read off the live canvas/img, so it follows any layout -- and sits
 * under the title, side buttons and back button. Nothing can be tapped while it plays.
 */

/** Where the product picture is drawn, in viewport-local CSS px, and its native size. */
export function productPicture(viewport) {
  const el = viewport.querySelector('canvas.seq-canvas, img.product-image');
  if (!el) return null;
  const vr = viewport.getBoundingClientRect();
  const k = viewport.offsetWidth / (vr.width || 1);      // screen px -> layout px
  const r = el.getBoundingClientRect();
  let natW, natH, left = (r.left - vr.left) * k, top = (r.top - vr.top) * k;
  let w = r.width * k, h = r.height * k;
  if (el.tagName === 'CANVAS') {
    natW = el.width; natH = el.height;
  } else {
    natW = el.naturalWidth; natH = el.naturalHeight;
    const s = Math.min(w / natW, h / natH);              // object-fit: contain, centred
    left += (w - natW * s) / 2; top += (h - natH * s) / 2;
    w = natW * s; h = natH * s;
  }
  if (!natW || !natH) return null;
  return { left, top, scale: w / natW, natW, natH };
}

/* `intro.endFade: "white"` ends the video through solid white instead of a straight cut,
 * like a panel change: white up over the whole screen, the product swapped in behind
 * it, white down (user, 10 Nov 2026, for Bangie, whose render's weave is not the
 * photo's). Each half lasts `intro.endFadeMs`, else the kiosk's panel fade. Leaving the
 * panel mid-intro (skip) never fades. */
/* No flash of the product first (user, 10 Nov 2026: its starting frame showed for an
 * instant before the video). The product is hidden and the layer put up AT ONCE, not when
 * the video's first frame arrives; `ready` resolves once that frame can paint (or the
 * intro has ended), and the caller holds the panel's white transition on it, so the load
 * happens under the white. Playback waits for `start()`, called as the white lifts, so the
 * intro's first frame is the first thing seen. */
export function playIntro({ layerParent, viewport, intro, url, fadeMs = 420 }) {
  let finish = () => {};
  let skipNow = () => {};
  let markReady = () => {};
  const ready = new Promise((r) => { markReady = r; });
  let startNow = () => {};
  const done = new Promise((resolve) => {
    const pic = productPicture(viewport);
    if (!intro?.src || !Array.isArray(intro.box) || !pic) { markReady(); resolve(); return; }
    const [bx, by, bw, bh] = intro.box;

    // The layer covers the whole screen, not just the product's box: the video is drawn
    // larger than that box, and clipping it there cut the strands flat at the top and the
    // woven base at the bottom (user, 10 Nov 2026, "a black line at the bottom"). Its own
    // margins are the page colour, and the title, side buttons and back button stack
    // above it.
    const layer = document.createElement('div');
    layer.className = 'product-intro';
    const video = document.createElement('video');
    video.muted = true;                    // silent by design; the files carry no audio
    video.playsInline = true;
    video.preload = 'auto';
    video.disablePictureInPicture = true;
    video.style.left = `${viewport.offsetLeft + pic.left + bx * pic.scale}px`;
    video.style.top = `${viewport.offsetTop + pic.top + by * pic.scale}px`;
    video.style.width = `${bw * pic.scale}px`;
    video.style.height = `${bh * pic.scale}px`;
    video.src = url(intro.src);
    layer.appendChild(video);
    // Nothing can be tapped while it plays, the back button included (user, 10 Nov
    // 2026): a transparent sheet over the whole screen takes every touch until the
    // product is back. (There is no tap-to-skip.)
    const block = document.createElement('div');
    block.className = 'product-intro__block';
    for (const t of ['pointerdown', 'pointerup', 'click']) {
      block.addEventListener(t, (e) => { e.stopPropagation(); e.preventDefault(); });
    }

    let ended = false;
    let cleaned = false;
    let safety = null;
    let veil = null;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(safety);
      viewport.classList.remove('is-under-intro');   // the product takes over in place
      layer.remove();
      video.removeAttribute('src');
      video.load();                                  // release the decoder
    };
    const fadeTo = (op, ms) => new Promise((r) => {
      veil.style.transition = `opacity ${ms}ms ease`;
      void veil.offsetWidth;                         // commit the start before the change
      veil.style.opacity = String(op);
      setTimeout(r, ms);
    });
    skipNow = () => {
      ended = true;
      cleanup();
      block.remove();
      veil?.remove();
      veil = null;
      markReady();
      resolve();
    };
    finish = async () => {
      if (ended) return;
      ended = true;
      markReady();
      clearTimeout(safety);
      const ms = intro.endFadeMs ?? fadeMs;
      if (intro.endFade === 'white' && layer.isConnected && ms > 0) {
        veil = document.createElement('div');
        veil.className = 'product-intro__veil';
        layerParent.appendChild(veil);
        await fadeTo(1, ms);
        if (cleaned) return;                         // skipped while whitening
        cleanup();
        // one frame so the product paints behind the white before it lifts
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        if (!veil) return;
        await fadeTo(0, ms);
        veil?.remove();
        veil = null;
      } else {
        cleanup();
      }
      // Taps come back only now: the white sits under the back button, so the input
      // block (not the white) has to hold until it has gone.
      block.remove();
      resolve();
    };
    video.addEventListener('ended', finish);
    video.addEventListener('error', finish);
    // Never strand the panel behind a video that will not play.
    safety = setTimeout(finish, 15000);

    /* `intro.endAt` (seconds): end there instead of at the file's end -- the moment the
     * product is complete (Maznah: the basket's last movement), so the white fade starts
     * on it rather than on the still frames after. Checked on every decoded frame. */
    if (Number.isFinite(intro.endAt)) {
      if (video.requestVideoFrameCallback) {
        const onFrame = (_now, meta) => {
          if (ended) return;
          if (meta.mediaTime >= intro.endAt - 0.001) finish();
          else video.requestVideoFrameCallback(onFrame);
        };
        video.requestVideoFrameCallback(onFrame);
      } else {
        video.addEventListener('timeupdate', () => {
          if (video.currentTime >= intro.endAt) finish();
        });
      }
    }

    // Up at once, the product hidden under it (see the note at the top).
    layerParent.appendChild(layer);
    layerParent.appendChild(block);
    viewport.classList.add('is-under-intro');
    video.addEventListener('loadeddata', () => markReady(), { once: true });

    let started = false;
    startNow = async () => {
      if (started || ended) return;
      started = true;
      try { await video.play(); } catch { finish(); return; }
      clearTimeout(safety);
      safety = setTimeout(finish, (video.duration || 10) * 1000 + 2000);
    };
  });
  return { done, ready, start: () => startNow(), skip: () => skipNow() };
}
