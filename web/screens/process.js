/**
 * Pembuatan — the process-step carousel.
 *
 * Behaviour that matters:
 *   - the selected slide plays ONCE, never loops
 *   - moving to another slide PAUSES the outgoing video
 *   - re-selecting a slide restarts it from the beginning, not from where it paused
 *   - subtitles only appear when the step actually ships an .srt; Samat's steps have
 *     their titles burned into the picture, so no band renders over them
 *   - the subtitle sits INSIDE the video, across its lower part, as in the old app
 *     (15_SamatCreationStep.png) — each slide owns its band, so only the playing
 *     slide ever shows text and a neighbour's caption can never bleed across
 *   - the layout must be right for any number of steps, including one
 */

import { loadSrt, SubtitleBand } from '../lib/srt.js';

const SPREAD = 470;   // px between neighbouring slide centres
const SIDE_SCALE = 0.68;

export async function mountProcess({ steps, manifest, url, assetInfo, idle, els }) {
  const ordered = [...steps].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  // The old full-width band below the carousel is no longer used; captions now live
  // inside each slide. Keep the element hidden so nothing stale can appear there.
  if (els.subs) els.subs.hidden = true;

  els.carousel.innerHTML = '';
  els.dots.innerHTML = '';
  els.dots.hidden = ordered.length < 2;

  let index = 0;
  let holds = 0;
  let suppressClick = false;
  const slides = [];
  const cueCache = new Map();

  // Counted, not boolean: several videos can briefly emit play/pause around a page
  // change, and a boolean would drop a release and hold the timer open for good.
  // `idle.hold()` hands back the matching release rather than exposing a bare
  // `idle.release()`, so a release can only ever cancel the hold it took — and stops
  // working once the screen changes. Keeping them on a stack preserves the counted
  // behaviour this already relied on.
  const pending = [];
  const hold = () => { holds += 1; const r = idle?.hold(); if (r) pending.push(r); };
  const release = () => { if (holds > 0) { holds -= 1; pending.pop()?.(); } };
  const releaseAll = () => { while (holds > 0) release(); };

  /* ---------------------------------------------------------- build */

  ordered.forEach((step, i) => {
    const slide = document.createElement('div');
    slide.className = 'slide';

    const video = document.createElement('video');
    video.playsInline = true;
    video.preload = 'none';       // lazy: bytes are already in the page cache
    video.controls = false;
    video.loop = false;
    video.disablePictureInPicture = true;
    if (step.thumb && assetInfo(step.thumb).exists) video.poster = url(step.thumb);
    video.src = url(step.video);

    const badge = document.createElement('span');
    badge.className = 'slide__badge';
    badge.textContent = `${i + 1}/${ordered.length}`;

    const subsEl = document.createElement('div');
    subsEl.className = 'slide__subs';
    subsEl.hidden = true;
    const band = new SubtitleBand(subsEl);

    slide.append(video, subsEl, badge);

    // Tapping a neighbouring slide navigates to it, as well as the dots and swipe.
    // `suppressClick` stops a swipe that ends on a slide from also counting as a tap.
    slide.addEventListener('click', () => {
      if (suppressClick) return;
      select(i);
    });
    els.carousel.appendChild(slide);
    slides.push({ slide, video, step, band });

    /* The idle countdown is suspended for exactly as long as a step video is actually
     * playing, and starts again the moment it stops. Tying this to play/pause/ended
     * rather than to page selection means switching pages mid-clip, or leaving one
     * paused, can never strand the timer in a held state. `loop` is false, so a clip
     * plays once and rests on its last frame; re-selecting that page replays it. */
    video.addEventListener('play', hold);
    video.addEventListener('pause', release);
    video.addEventListener('ended', release);

    // Per-frame, not timeupdate — see the note in seamless-player.js. Only the
    // selected slide drives the band; the others are paused anyway.
    if (typeof video.requestVideoFrameCallback === 'function') {
      const tick = (_now, meta) => {
        if (i === index) band.update(meta.mediaTime);
        if (!video.paused) video.requestVideoFrameCallback(tick);
      };
      video.addEventListener('play', () => video.requestVideoFrameCallback(tick));
    } else {
      video.addEventListener('timeupdate', () => {
        if (i === index) band.update(video.currentTime);
      });
    }

    if (ordered.length > 1) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.addEventListener('click', () => select(i));
      els.dots.appendChild(dot);
    }
  });

  /* ---------------------------------------------------------- layout */

  function layout() {
    slides.forEach(({ slide }, i) => {
      const d = i - index;
      const scale = d === 0 ? 1 : SIDE_SCALE;
      slide.style.transform = `translateX(${d * SPREAD}px) scale(${scale})`;
      slide.style.zIndex = String(50 - Math.abs(d));
      slide.style.opacity = Math.abs(d) > 1 ? '0' : d === 0 ? '1' : '.75';
      slide.style.pointerEvents = Math.abs(d) > 1 ? 'none' : 'auto';
    });
    [...els.dots.children].forEach((dot, i) =>
      dot.setAttribute('aria-current', String(i === index)));
  }

  /* ---------------------------------------------------------- select */

  async function loadCues(step) {
    if (!step.srt || !assetInfo(step.srt).exists) return [];
    if (cueCache.has(step.srt)) return cueCache.get(step.srt);
    try {
      const cues = await loadSrt(url(step.srt));
      cueCache.set(step.srt, cues);
      return cues;
    } catch {
      return [];
    }
  }

  async function select(i) {
    const reselect = i === index;

    // Always stop the outgoing video before anything else.
    for (const { video } of slides) {
      if (!video.paused) video.pause();
    }
    index = i;
    layout();

    const { video, step } = slides[i];
    // Only the selected slide may show a caption; clear the rest first.
    for (const other of slides) if (other !== slides[i]) other.band.setCues([]);
    slides[i].band.setCues(await loadCues(step));

    // Re-selecting restarts from the beginning rather than resuming. The idle hold is
    // owned entirely by the play/pause/ended listeners, so nothing is taken here.
    video.currentTime = 0;
    try { await video.play(); } catch { /* listeners keep the count straight */ }
    void reselect;
  }

  /* ---------------------------------------------------------- swipe */

  let startX = null;
  const onDown = (e) => { startX = e.clientX; suppressClick = false; };
  const onUp = (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    startX = null;
    if (Math.abs(dx) < 60) return;     // too small to be a swipe: let the click land
    suppressClick = true;              // it was a swipe, so the click that follows is not a tap
    setTimeout(() => { suppressClick = false; }, 0);
    const next = index + (dx < 0 ? 1 : -1);
    if (next >= 0 && next < slides.length) select(next);
  };
  els.carousel.addEventListener('pointerdown', onDown);
  els.carousel.addEventListener('pointerup', onUp);
  els.carousel.addEventListener('pointercancel', () => { startX = null; suppressClick = false; });

  layout();
  await select(0);

  /* ---------------------------------------------------------- dispose */

  return () => {
    releaseAll();
    els.carousel.removeEventListener('pointerdown', onDown);
    els.carousel.removeEventListener('pointerup', onUp);
    for (const { video } of slides) {
      video.pause();
      video.removeAttribute('src');
      video.load();       // release the decoder rather than leaking it
    }
    for (const sl of slides) sl.band.hide();
    els.carousel.innerHTML = '';
    els.dots.innerHTML = '';
  };
}
