/**
 * Generic control binder.
 *
 * Widgets are bound to a viewer's INTERFACE, never to a viewer's type. A slider bound
 * to `rotation` drives an FBX yaw exactly as well as a PNG-sequence frame index, and a
 * drag gesture works on both. That is what lets a future artist choose sliders for a 3D
 * model, or drag for an image sequence, by editing content.json rather than code.
 *
 * Viewer interface expected:
 *   setRotation(deg)   0..360
 *   setZoom(z)         multiplier
 *   setVariant(id)     optional
 *   reset()
 */

export function bindControls({ specs, viewer, strings, els, ui = {}, url = (s) => s }) {
  const cleanups = [];
  els.controls.innerHTML = '';

  const label = (key) => strings[key] ?? { ms: key, en: '' };

  /** Background image + --btn-img, so the pressed tint masks to the artwork. */
  const setArt = (el, href) => {
    el.style.backgroundImage = `url("${href}")`;
    el.style.setProperty('--btn-img', `url("${href}")`);
  };

  /**
   * Build a button from artwork where the museum supplied it, otherwise draw the
   * bilingual label over the blank pill. `reset` and `split` have dedicated PNGs
   * with their text already baked in; `join` (Sambung) has none, so it falls back
   * to the blank pill and stays readable.
   */
  function artButton(key) {
    const b = document.createElement('button');
    b.className = 'imgbtn pill';
    const art = ui[key];
    const s = label(key);
    if (art) {
      b.classList.add('pill--art');
      setArt(b, url(art));
      b.setAttribute('aria-label', `${s.ms} — ${s.en}`);
      b.dataset.art = '1';
    } else {
      if (ui.pill) setArt(b, url(ui.pill));
      b.innerHTML = `<span class="pill__ms"></span><span class="pill__en"></span>`;
      b.querySelector('.pill__ms').textContent = s.ms;
      b.querySelector('.pill__en').textContent = s.en;
    }
    return b;
  }

  /** Repaint an existing button for a new label (used by the toggle). */
  function repaint(b, key) {
    const art = ui[key];
    const s = label(key);
    b.setAttribute('aria-label', `${s.ms} — ${s.en}`);
    if (art) {
      b.classList.add('pill--art');
      setArt(b, url(art));
      b.innerHTML = '';
      b.dataset.art = '1';
    } else {
      b.classList.remove('pill--art');
      delete b.dataset.art;
      if (ui.pill) setArt(b, url(ui.pill));
      b.innerHTML = `<span class="pill__ms"></span><span class="pill__en"></span>`;
      b.querySelector('.pill__ms').textContent = s.ms;
      b.querySelector('.pill__en').textContent = s.en;
    }
  }

  const state = {
    rotation: viewer.initialRotation ?? 0,
    zoom: 1,
    variantIndex: 0,
  };

  const zoomSpec = specs.find((s) => s.binds === 'zoom') ?? {};
  const zMin = zoomSpec.min ?? 0.5;
  const zMax = zoomSpec.max ?? 3;
  const clampZoom = (z) => Math.min(zMax, Math.max(zMin, z));

  function applyZoom(z) {
    state.zoom = clampZoom(z);
    viewer.setZoom?.(state.zoom);
    for (const s of sliders.zoom ?? []) s.value = String(state.zoom);
  }
  /**
   * A viewer that declares `rotationLimits` is CLAMPED to that range instead of wrapping
   * round 360°. The keris turntable uses this to stop dead on its first and last frame.
   *
   * The clamp must happen here, on the binder's own state, not only inside the viewer:
   * if the binder kept counting past the end while the viewer sat on the last frame, a
   * drag back would have to "unwind" all that overshoot before anything moved — a dead
   * zone that feels like the kiosk has frozen.
   */
  const limits = viewer.rotationLimits ?? null;
  function applyRotation(deg) {
    state.rotation = limits
      ? Math.min(limits.max, Math.max(limits.min, deg))
      : ((deg % 360) + 360) % 360;
    viewer.setRotation?.(state.rotation);
    for (const s of sliders.rotation ?? []) s.value = String(state.rotation);
  }

  const sliders = { rotation: [], zoom: [] };

  /* ------------------------------------------------------------- widgets */

  for (const spec of specs) {
    switch (spec.widget) {

      case 'slider': {
        const row = document.createElement('label');
        row.className = 'slider-row';
        const l = label(spec.binds === 'zoom' ? 'zoom' : 'rotate');
        row.innerHTML =
          `<span class="slider-row__label"><b></b><i></i></span>` +
          `<input type="range">`;
        row.querySelector('b').textContent = l.ms;
        row.querySelector('i').textContent = l.en;
        const input = row.querySelector('input');
        input.min = String(spec.min ?? 0);
        input.max = String(spec.max ?? (spec.binds === 'zoom' ? 3 : 360));
        input.step = String(spec.step ?? (spec.binds === 'zoom' ? 0.01 : 1));
        input.value = String(spec.binds === 'zoom' ? state.zoom : state.rotation);
        const onInput = () => {
          if (spec.binds === 'zoom') applyZoom(+input.value);
          else applyRotation(+input.value);
        };
        input.addEventListener('input', onInput);
        sliders[spec.binds]?.push(input);
        els.controls.appendChild(row);
        cleanups.push(() => input.removeEventListener('input', onInput));
        break;
      }

      case 'zoomButtons': {
        const stack = document.createElement('div');
        stack.className = 'zoom-stack';
        for (const [sign, key] of [[1, 'plus'], [-1, 'minus']]) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'imgbtn zoom-btn';
          if (ui[key]) setArt(b, url(ui[key]));
          else b.textContent = sign > 0 ? '+' : '−';
          b.setAttribute('aria-label', sign > 0 ? 'Zoom in' : 'Zoom out');
          b.addEventListener('click', () => applyZoom(state.zoom + sign * (spec.step ?? 0.25)));
          stack.appendChild(b);
        }
        // Inside the control column, not floating separately, so +/- sit with the
        // pills as one cluster. Spec order puts zoomButtons before the toggle.
        els.controls.appendChild(stack);
        cleanups.push(() => stack.remove());
        break;
      }

      case 'toggle': {
        const states = spec.states ?? [];
        const labels = spec.labels ?? [];
        if (states.length < 2) break;
        // The label always names the action the NEXT tap performs.
        const b = artButton(labels[0] ?? 'split');
        const onClick = async () => {
          const next = (state.variantIndex + 1) % states.length;
          b.disabled = true;
          try {
            await viewer.setVariant?.(states[next]);
            state.variantIndex = next;
            repaint(b, labels[state.variantIndex] ?? labels[0]);
          } finally { b.disabled = false; }
        };
        b.addEventListener('click', onClick);
        els.controls.appendChild(b);
        cleanups.push(() => b.removeEventListener('click', onClick));
        break;
      }

      case 'button': {
        const b = artButton(spec.label ?? 'reset');
        const onClick = () => {
          viewer.reset?.();
          state.rotation = viewer.initialRotation ?? 0;
          state.zoom = 1;
          for (const s of sliders.rotation) s.value = String(state.rotation);
          for (const s of sliders.zoom) s.value = '1';
        };
        b.addEventListener('click', onClick);
        els.controls.appendChild(b);
        cleanups.push(() => b.removeEventListener('click', onClick));
        break;
      }

      /* Gestures live on the viewport, not in the control column. */
      case 'drag':
      case 'pinch':
        break;
    }
  }

  /* ------------------------------------------------------- gestures */

  const wantsDrag = specs.some((s) => s.widget === 'drag');
  const wantsPinch = specs.some((s) => s.widget === 'pinch');

  if (wantsDrag || wantsPinch) {
    const surface = els.viewport;
    const points = new Map();
    let lastX = 0;
    let pinchStart = 0;
    let zoomStart = 1;

    const dist = () => {
      const [a, b] = [...points.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };

    const onPointerDown = (e) => {
      // Capture keeps a drag alive if the finger leaves the viewport. It throws if the
      // pointer id is not active — which a synthetic event has — and an uncaught throw
      // here would abandon the rest of the handler and leave the drag dead.
      try { surface.setPointerCapture?.(e.pointerId); } catch { /* not capturable */ }
      points.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (points.size === 1) lastX = e.clientX;
      if (points.size === 2) { pinchStart = dist(); zoomStart = state.zoom; }
    };

    const onPointerMove = (e) => {
      if (!points.has(e.pointerId)) return;
      points.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (points.size === 2 && wantsPinch && pinchStart > 0) {
        applyZoom(zoomStart * (dist() / pinchStart));
        return;
      }
      if (points.size === 1 && wantsDrag) {
        const dx = e.clientX - lastX;
        lastX = e.clientX;
        // Ctrl+drag is the desktop stand-in for a pinch (see below); it must not also
        // spin the product, or testing the zoom would rotate it at the same time.
        if (!e.ctrlKey) applyRotation(state.rotation + dx * 0.4);
      }
    };

    const onPointerUp = (e) => {
      points.delete(e.pointerId);
      if (points.size < 2) pinchStart = 0;
      if (points.size === 1) lastX = [...points.values()][0].x;
    };

    surface.addEventListener('pointerdown', onPointerDown);
    surface.addEventListener('pointermove', onPointerMove);
    surface.addEventListener('pointerup', onPointerUp);
    surface.addEventListener('pointercancel', onPointerUp);
    surface.addEventListener('pointerleave', onPointerUp);

    cleanups.push(() => {
      surface.removeEventListener('pointerdown', onPointerDown);
      surface.removeEventListener('pointermove', onPointerMove);
      surface.removeEventListener('pointerup', onPointerUp);
      surface.removeEventListener('pointercancel', onPointerUp);
      surface.removeEventListener('pointerleave', onPointerUp);
    });
  }

  /* -------------------------------------------------- zooming on a desktop ----
   * A mouse has one pointer, so pinch cannot be performed while building or checking
   * the exhibit. These two give the same control from a keyboard and mouse:
   *
   *   wheel            zoom in / out
   *   Ctrl + drag up/down   zoom in / out
   *
   * Both are additions, not replacements — pinch is untouched, and these only exist for
   * products that already declare `pinch`, so nothing gains a zoom it was not given. On
   * the panel itself they are inert: a touchscreen sends no wheel events and has no Ctrl
   * key, so the museum sees exactly the behaviour that was specified. */
  if (wantsPinch) {
    const surface = els.viewport;

    const onWheel = (e) => {
      e.preventDefault();
      applyZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    };

    let ctrlY = null;
    const onCtrlDown = (e) => { if (e.ctrlKey) ctrlY = e.clientY; };
    const onCtrlMove = (e) => {
      if (ctrlY === null || !e.ctrlKey) return;
      const dy = ctrlY - e.clientY;      // drag up to zoom in, as a pinch outward would
      ctrlY = e.clientY;
      applyZoom(state.zoom * (1 + dy * 0.004));
    };
    const onCtrlUp = () => { ctrlY = null; };

    surface.addEventListener('wheel', onWheel, { passive: false });
    surface.addEventListener('pointerdown', onCtrlDown);
    surface.addEventListener('pointermove', onCtrlMove);
    surface.addEventListener('pointerup', onCtrlUp);
    surface.addEventListener('pointercancel', onCtrlUp);

    cleanups.push(() => {
      surface.removeEventListener('wheel', onWheel);
      surface.removeEventListener('pointerdown', onCtrlDown);
      surface.removeEventListener('pointermove', onCtrlMove);
      surface.removeEventListener('pointerup', onCtrlUp);
      surface.removeEventListener('pointercancel', onCtrlUp);
    });
  }

  return () => {
    for (const fn of cleanups) { try { fn(); } catch { /* ignore */ } }
    els.controls.innerHTML = '';
  };
}
