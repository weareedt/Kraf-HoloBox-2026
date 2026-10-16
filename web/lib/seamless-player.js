/**
 * SeamlessPlayer — gapless handoff between clips on the artist stage.
 *
 * The problem this exists to solve: the walk-in clip's LAST frame is pose-matched to
 * the idle loop's FIRST frame, so the join has to be invisible on a 2 m panel.
 *
 * Two facts drive the whole design:
 *
 *   - The OUTGOING video is safe. Chrome keeps its last presented frame on screen
 *     after `ended`, so nothing flashes on the way out.
 *
 *   - The INCOMING video is the hazard. A <video> that has never presented a frame
 *     paints transparent (so: black). `readyState === 4` is NOT proof of a painted
 *     frame — it only means data is buffered. The only reliable proof is
 *     requestVideoFrameCallback having actually fired once on that element.
 *
 * So: keep a small pool of <video> elements, always prime the next clip to a
 * *presented* frame 0 while the current one is still playing, and swap ~2 frames
 * before the end rather than waiting for `ended` (which gives zero lead time for the
 * next decoder to spin up). A one-frame canvas freeze covers the swap as insurance
 * against a driver that flashes on reveal — it costs <2 ms and means this never has
 * to be debugged on site at 11pm.
 *
 * Worst case, the pose-matched frame 0 is held an extra frame or two while the
 * decoder starts. Because the poses match, that reads as stillness, not a glitch.
 */

const LEAD_FRAMES = 2;

const once = (el, ev) => new Promise((r) => el.addEventListener(ev, r, { once: true }));

/**
 * Resolve once the element has a frame on screen.
 *
 * requestVideoFrameCallback only fires when a NEW frame is presented. An element that
 * is paused and already decoded — which is exactly what a re-primed clip is — will
 * never present another one, so waiting on rVFC alone hangs forever. That is what made
 * a profile video play the first time and never again.
 *
 * So: prefer rVFC, but treat "has decoded data" as good enough, and cap the wait.
 */
const presented = (v) =>
  new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };

    if (typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(finish);
    else once(v, 'loadeddata').then(finish);

    // HAVE_CURRENT_DATA or better means a frame exists for this position.
    if (v.readyState >= 2) setTimeout(finish, 50);
    setTimeout(finish, 500);        // hard ceiling: never block the UI on this
  });

export class SeamlessPlayer {
  /** @param {HTMLElement} root  @param {number} poolSize */
  constructor(root, poolSize = 3) {
    this.root = root;
    this.pool = Array.from({ length: poolSize }, () => {
      const v = document.createElement('video');
      v.className = 'sp-video';
      v.playsInline = true;
      v.preload = 'auto';
      v.controls = false;
      v.disablePictureInPicture = true;
      v.muted = true;
      root.appendChild(v);
      return v;
    });

    this.cover = document.createElement('canvas');
    this.cover.className = 'sp-cover';
    root.appendChild(this.cover);

    this.active = null;
    this._loopToken = 0;
  }

  _spare() {
    const v = this.pool.find((e) => e !== this.active && !e.dataset.busy);
    if (v) return v;
    // everything busy: reclaim the oldest non-active element
    const fallback = this.pool.find((e) => e !== this.active) ?? this.pool[0];
    fallback.dataset.busy = '';
    return fallback;
  }

  /**
   * Load `src` into a spare element and resolve only once ONE frame is actually
   * on the compositor at t=0. This is what makes the swap safe.
   */
  async prime(src, { muted = true } = {}) {
    const v = this._spare();
    v.dataset.busy = '1';
    v.muted = muted;
    v.loop = false;

    if (v.dataset.src !== src) {
      v.dataset.src = src;
      v.src = src;
      v.load();
      await once(v, 'loadedmetadata');
    }
    if (v.readyState < 4) await once(v, 'canplaythrough');
    if (v.currentTime !== 0) {
      v.currentTime = 0;
      await once(v, 'seeked');
    }
    // Force a frame onto the compositor without showing playback.
    try {
      await v.play();
      v.pause();
      v.currentTime = 0;
    } catch { /* autoplay refused while muted is unlikely; prime() still resolves below */ }
    await presented(v);
    return v;
  }

  /** Resolves ~LEAD_FRAMES before the final frame of `v`. */
  _nearEnd(v, fps) {
    const cutoff = Math.max(0, (v.duration || 0) - (LEAD_FRAMES + 0.5) / fps);
    return new Promise((res) => {
      let done = false;
      const finish = () => { if (!done) { done = true; res(); } };
      if (typeof v.requestVideoFrameCallback === 'function') {
        const tick = (_now, meta) => {
          if (done) return;
          if (meta.mediaTime >= cutoff) finish();
          else v.requestVideoFrameCallback(tick);
        };
        v.requestVideoFrameCallback(tick);
      } else {
        const poll = () => {
          if (done) return;
          if (v.currentTime >= cutoff) finish();
          else requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
      }
      v.addEventListener('ended', finish, { once: true }); // safety net
    });
  }

  /** Paint the current frame into the cover canvas and show it. */
  _shield() {
    const v = this.active;
    if (!v || !v.videoWidth) return;
    this.cover.width = v.videoWidth;
    this.cover.height = v.videoHeight;
    this.cover.getContext('2d', { alpha: false }).drawImage(v, 0, 0);
    this.cover.style.opacity = '1';
  }

  _unshield() {
    this.cover.style.opacity = '0';
  }

  _reveal(v) {
    for (const e of this.pool) e.style.zIndex = e === v ? '2' : '1';
    if (this.active && this.active !== v) this.active.dataset.busy = '';
    this.active = v;
    v.dataset.busy = '1';
  }

  /**
   * Cross-dissolve `to` in over `from`, used for joins that are NOT pose-matched.
   *
   * `from` has already run past its last frame by the time this is called, and Chrome
   * holds that final frame on screen, so the dissolve is from a frozen still into live
   * playback. That is why no pre-roll is needed: the fade can start late and still look
   * right. The outgoing element's opacity is restored afterwards so the pool stays clean.
   */
  async _crossfade(from, to, ms) {
    to.style.transition = 'none';
    to.style.opacity = '0';
    this._reveal(to);                       // on top; `from` stays visible beneath
    to.play().catch(() => {});
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    to.style.transition = `opacity ${ms}ms linear`;
    to.style.opacity = '1';
    await new Promise((r) => setTimeout(r, ms + 20));
    to.style.transition = 'none';
    from.style.opacity = '1';
  }

  /**
   * Play an ordered cycle of clips, repeating forever.
   *
   * This replaces the old walk-once-then-loop-idle shape, which could not express
   * Maznah's stage: she walks in, stands through the idle TWICE, dances, and the dance
   * ends with her walking off exactly where the walk clip begins — so her whole cycle
   * loops back to the walk rather than to an idle. Every other artist is the degenerate
   * case of the same thing: [walk, idle] looping from index 1.
   *
   * @param {{src: string, fps?: number, blendMs?: number}[]} steps  in play order.
   *   `blendMs` cross-dissolves INTO that step; 0 (the default) is a hard cut, which is
   *   what every pose-matched join must use.
   * @param {{startIndex?: number, loopFrom?: number}} opts  `startIndex` skips the
   *   walk-in when returning from a sub-panel; `loopFrom` is where the cycle repeats.
   */
  async playCycle(steps, { startIndex = 0, loopFrom = 0 } = {}) {
    const token = ++this._loopToken;
    const alive = () => token === this._loopToken;
    if (!steps.length) return;

    const wrap = (i) => ((i % steps.length) + steps.length) % steps.length;
    const after = (i) => (i + 1 < steps.length ? i + 1 : wrap(loopFrom));

    let i = wrap(startIndex);
    let current = await this.prime(steps[i].src);
    if (!alive()) return;
    this._shield();
    this._reveal(current);
    await current.play();
    await presented(current);
    this._unshield();

    while (alive()) {
      const j = after(i);
      const step = steps[j];
      const next = await this.prime(step.src);   // primed while `current` still plays
      if (!alive()) return;
      await this._nearEnd(current, steps[i].fps ?? 25);
      if (!alive()) return;

      const prev = current;
      if (step.blendMs > 0) {
        await this._crossfade(prev, next, step.blendMs);
      } else {
        this._reveal(next);
        next.play().catch(() => {});
      }
      if (!alive()) return;
      prev.pause();
      try { prev.currentTime = 0; } catch { /* not seekable */ }
      current = next;
      i = j;
    }
  }

  /**
   * Play a single clip once.
   *
   * Resolves as soon as the FIRST FRAME IS ON SCREEN, returning `{ done }` for the
   * end of playback. The split matters: callers run inside a fade transition, and if
   * this awaited the whole clip the white veil would stay up for its entire duration
   * — which looked exactly like "the video is broken, but I can hear it".
   */
  async playOnce(src, { fps = 25, muted = false, onTime } = {}) {
    const token = ++this._loopToken;
    const v = await this.prime(src, { muted });
    if (token !== this._loopToken) return;

    this._shield();
    this._reveal(v);
    await v.play();
    await presented(v);
    this._unshield();

    // Drive subtitles from requestVideoFrameCallback, not timeupdate. timeupdate
    // only fires ~4x/second, which shows as up to a quarter-second of lag at every
    // cue boundary; rVFC fires per presented frame, so cues land on the right frame.
    if (onTime) {
      let stopped = false;
      const stop = () => { stopped = true; };
      v.addEventListener('ended', stop, { once: true });
      v.addEventListener('emptied', stop, { once: true });

      if (typeof v.requestVideoFrameCallback === 'function') {
        const tick = (_now, meta) => {
          if (stopped || token !== this._loopToken) return;
          onTime(meta.mediaTime);
          v.requestVideoFrameCallback(tick);
        };
        v.requestVideoFrameCallback(tick);
      } else {
        const handler = () => { if (!stopped) onTime(v.currentTime); };
        v.addEventListener('timeupdate', handler);
      }
    }
    // Settles on natural end OR on interruption. Without the interrupt path this
    // promise would dangle forever when the visitor leaves mid-video, holding the
    // element and its caller's scope alive for the life of the kiosk.
    const done = new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearInterval(watch);
        v.removeEventListener('ended', finish);
        resolve();
      };
      const watch = setInterval(() => { if (token !== this._loopToken) finish(); }, 120);
      v.addEventListener('ended', finish, { once: true });
    });

    return { done };
  }

  /** Halt whatever is playing and clear the pool. */
  stop() {
    this._loopToken++;
    this._unshield();
    for (const v of this.pool) {
      v.pause();
      try { v.currentTime = 0; } catch { /* not seekable yet */ }
      v.dataset.busy = '';
      v.style.zIndex = '1';
      // a cycle interrupted mid-crossfade would otherwise leave an element parked
      // at opacity 0, and the next visit would reuse it and show nothing
      v.style.transition = 'none';
      v.style.opacity = '1';
    }
    this.active = null;
  }

  /** Release all media so a long-running kiosk does not accumulate decoders. */
  dispose() {
    this.stop();
    for (const v of this.pool) {
      v.removeAttribute('src');
      v.load();
      v.remove();
    }
    this.cover.remove();
    this.pool.length = 0;
  }
}
