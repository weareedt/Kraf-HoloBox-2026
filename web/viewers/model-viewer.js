/**
 * 3D model viewer (three.js + FBXLoader).
 *
 * Four things here were established by probing the museum's actual FBX files, not
 * assumed. Changing any of them will silently break the Wau:
 *
 *  1. TEXTURE PATHS. The FBX references its maps as bare filenames ("layer5 wau.png"),
 *     so without setResourcePath() they resolve against the site root and 404.
 *
 *  2. THE alphaMap IS A LIE. FBXLoader wires the *colour* texture in as alphaMap as
 *     well (verified: map.image === alphaMap.image). alphaMap samples the GREEN channel,
 *     so on a colourful painted kite it crushes alpha to near-zero and the whole mesh
 *     vanishes. The PNGs carry real cutout alpha via a palette tRNS chunk, which `map`
 *     already provides — so the alphaMap has to be discarded.
 *
 *  3. TEXTURES ARRIVE AFTER THE LOADER RESOLVES. loadAsync() resolves before the images
 *     decode. A texture with no image samples as alpha 0, so anything rendered in that
 *     window is discarded. We wait for the images before showing the model.
 *
 *  4. ONE CLIP IS NOT ENOUGH. Blender exported every object x every action - 25 clips for
 *     5 objects - and each clip drives a single object. Playing clip 0 animates one layer
 *     and leaves the rest frozen. The "self-matched" strategy keeps only the clips whose
 *     object and action agree ("Layer 1|Layer 1Action") and plays all of them together.
 *
 * The meshes are flat planes, so materials are forced double-sided: the kite must read
 * correctly from behind as well as in front.
 */

import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const LOAD_TIMEOUT_MS = 20000;
const TEXTURE_TIMEOUT_MS = 15000;

const withTimeout = (p, ms, what) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout loading ${what}`)), ms)),
]);

/**
 * Keep only clips whose object and action names agree, e.g. "Layer 1|Layer 1Action".
 * Falls back to everything if the export does not use that convention.
 */
function selfMatchedClips(clips) {
  const keep = clips.filter((c) => {
    const [obj, act] = String(c.name).split('|');
    return obj && act && act.replace(/Action$/, '').trim() === obj.trim();
  });
  return keep.length ? keep : clips;
}

function resolveClips(clips, spec) {
  if (!clips?.length) return [];
  if (spec === 'self-matched' || spec == null) return selfMatchedClips(clips);
  if (spec === 'all') return clips;
  if (typeof spec === 'number') return clips[spec] ? [clips[spec]] : [clips[0]];
  if (typeof spec === 'string') {
    const hit = clips.find((c) => c.name === spec);
    return hit ? [hit] : selfMatchedClips(clips);
  }
  if (Array.isArray(spec)) {
    return spec.map((s) => (typeof s === 'number' ? clips[s] : clips.find((c) => c.name === s)))
      .filter(Boolean);
  }
  return selfMatchedClips(clips);
}

/** Wait until every texture on the object actually has a decoded image. */
function texturesReady(obj, ms = TEXTURE_TIMEOUT_MS) {
  const maps = [];
  obj.traverse((c) => {
    if (!c.isMesh) return;
    for (const m of [].concat(c.material)) {
      if (!m) continue;
      for (const key of ['map', 'alphaMap', 'emissiveMap', 'normalMap', 'specularMap']) {
        if (m[key]) maps.push(m[key]);
      }
    }
  });
  if (!maps.length) return Promise.resolve();
  const ready = () => maps.every((t) => t.image && (t.image.width || t.image.data));
  if (ready()) return Promise.resolve();
  return new Promise((resolve) => {
    const t0 = Date.now();
    const poll = setInterval(() => {
      if (ready() || Date.now() - t0 > ms) { clearInterval(poll); resolve(); }
    }, 80);
  });
}

function applyMaterialPolicy(obj, policy = {}) {
  const doubleSide = policy.doubleSide !== false;
  const drop = policy.dropAlphaMap !== false;
  const alphaTest = policy.alphaTest ?? 0.5;
  const unlit = policy.unlit === true;

  obj.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = false;
    child.receiveShadow = false;

    const convert = (m) => {
      if (!m) return m;

      // The colour map doubling as an alphaMap is an FBX export artefact; using it
      // would key the kite out by its own green channel.
      const sameImage = m.map && m.alphaMap && m.map.image === m.alphaMap.image;
      const alphaMap = m.alphaMap && (drop || sameImage) ? null : m.alphaMap;

      /* Unlit.
       *
       * The textures are painted artwork — the shading is already in the image — so
       * lighting them again only adds specular sheen the craftsman never put there,
       * and makes the kite darken as it rotates away from the key light. Swapping to
       * MeshBasicMaterial shows each texel exactly as painted, from either side, at
       * any angle, and costs nothing to render. */
      let out = m;
      if (unlit && !m.isMeshBasicMaterial) {
        out = new THREE.MeshBasicMaterial({
          name: m.name,
          map: m.map ?? null,
          color: 0xffffff,          // no tint: the texture is the whole appearance
          opacity: m.opacity ?? 1,
          toneMapped: false,
        });
        m.dispose?.();              // the replaced material is not referenced again
      } else {
        out.alphaMap = alphaMap;
      }

      if (doubleSide) out.side = THREE.DoubleSide;
      if (out.map) {
        out.map.colorSpace = THREE.SRGBColorSpace;
        out.transparent = true;
        out.alphaTest = alphaTest;  // cutout: keeps depth sorting correct between layers
        out.depthWrite = true;
      }
      out.needsUpdate = true;
      return out;
    };

    child.material = Array.isArray(child.material)
      ? child.material.map(convert)
      : convert(child.material);
  });
}

/**
 * Recentre an object on the origin and report how big it is.
 *
 * Called ONCE per variant, at load, while the model is still in its rest pose. The
 * camera distance is then derived from the first variant only and never recomputed:
 * the exploded Wau's bounds grow from 6 to 176 deep as it opens, so re-fitting on
 * every switch would zoom the model in and out and the separation would read as a
 * rescale instead of as movement.
 */
function centreAndMeasure(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  object.position.sub(box.getCenter(new THREE.Vector3()));
  return Math.max(size.x, size.y, size.z) || 1;
}

function distanceFor(camera, maxDim, margin = 1.35) {
  const fov = (camera.fov * Math.PI) / 180;
  const dist = (maxDim / 2 / Math.tan(fov / 2)) * margin;
  camera.near = Math.max(0.01, dist / 500);
  camera.far = dist * 500;
  camera.updateProjectionMatrix();
  return dist;
}

export async function mountModel({ product, viewport, url, assetInfo, strings }) {
  const cfg = product.model ?? {};
  const variants = cfg.variants ?? [];
  const present = variants.filter((v) => assetInfo(v.src).exists);
  if (!present.length) return mountPlaceholder({ product, viewport, url, assetInfo, strings });

  const width = viewport.clientWidth || 1080;
  const height = viewport.clientHeight || 1280;

  /**
   * The viewport is measured in DESIGN pixels (1080-wide canvas), but the canvas is
   * CSS-scaled to the real panel — up on the 4K box, down in a window. Rendering at
   * design size would leave the model visibly soft on the 4K panel, so the pixel
   * ratio is multiplied by however much the canvas is actually scaled.
   */
  const effectiveScale = () => {
    const rect = viewport.getBoundingClientRect();
    const cssW = viewport.clientWidth || 1;
    return rect.width > 0 ? rect.width / cssW : 1;
  };

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio * effectiveScale(), 2));
  renderer.setSize(width, height, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  viewport.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, width / height, 0.1, 100000);

  // Flat, generous light. These are painted planes shown double-sided, so the back
  // face needs its own light or the kite goes black when rotated past 90 degrees.
  const L = cfg.lighting ?? {};
  scene.add(new THREE.AmbientLight(0xffffff, L.ambient ?? 2.0));
  const key = new THREE.DirectionalLight(0xffffff, L.key ?? 0.9);
  key.position.set(1, 1.5, 2);
  scene.add(key);
  const back = new THREE.DirectionalLight(0xffffff, L.back ?? 0.7);
  back.position.set(-1, -0.5, -2);
  scene.add(back);

  const pivot = new THREE.Group();
  scene.add(pivot);

  const loader = new FBXLoader();
  if (cfg.resourcePath) loader.setResourcePath(url(cfg.resourcePath));

  const cache = new Map();
  const mixers = new Map();

  async function getVariant(id) {
    if (cache.has(id)) return cache.get(id);
    const v = variants.find((x) => x.id === id);
    if (!v || !assetInfo(v.src).exists) return null;

    const obj = await withTimeout(loader.loadAsync(url(v.src)), LOAD_TIMEOUT_MS, v.src);
    if (cfg.scale) obj.scale.setScalar(cfg.scale);
    applyMaterialPolicy(obj, cfg.material);
    await texturesReady(obj);

    /* Fixed model-space correction, applied BEFORE centring so the bounding box
     * reflects it.
     *
     * The two Wau files are authored facing opposite ways: the assembled kite's
     * decorated face points +Z, the separated stack's points -Z. Without this the
     * kite appears to flip round the moment it comes apart, showing the plain blue
     * backing instead of the painted layers.
     *
     * It belongs on the MODEL, not the camera: the viewer's yaw is the visitor's own
     * rotation and composes on top of this, so continuity across the swap survives. */
    const modelYaw = v.modelYawDeg ?? cfg.modelYawDeg ?? 0;
    if (modelYaw) obj.rotation.y = (modelYaw * Math.PI) / 180;

    const maxDim = centreAndMeasure(obj);

    let mixer = null;
    let actions = [];
    if (obj.animations?.length && v.animation) {
      mixer = new THREE.AnimationMixer(obj);
      mixers.set(id, mixer);

      // Retime every clip to the requested wall-clock duration. The Blender export
      // runs 2.042s; the exhibit wants a crisp 1s open/close.
      const clips = resolveClips(obj.animations, v.animation.clips ?? v.animation.clip);
      const target = v.animation.durationSec ?? null;
      actions = clips.map((clip) => {
        const action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = v.animation.clampWhenFinished ?? true;
        return { action, clip, speed: target ? clip.duration / target : 1 };
      });
    }

    cache.set(id, { obj, spec: v, maxDim, mixer, actions });
    return cache.get(id);
  }

  /**
   * Drive a variant's clips in one direction and resolve when they land.
   *
   * Forward reads as the wau opening; reverse as it closing. Reverse is what makes
   * "Sambung" look like a real recombination rather than a cut back to the whole kite.
   */
  function runAnimation(entry, { reverse = false } = {}) {
    if (!entry?.actions?.length) return Promise.resolve();
    const seconds = entry.spec.animation?.durationSec
      ?? (entry.actions[0].clip.duration || 1);

    for (const { action, clip, speed } of entry.actions) {
      action.stop();
      action.reset();
      action.paused = false;
      action.enabled = true;
      action.timeScale = reverse ? -speed : speed;
      action.time = reverse ? clip.duration : 0;   // clip time, not scaled time
      action.play();
    }
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  }

  const camCfg = cfg.camera ?? {};
  const startYaw = camCfg.startYawDeg ?? 0;
  const startPitch = camCfg.startPitchDeg ?? 0;

  let current = null;
  let currentId = null;
  let baseDistance = null;   // computed once, from the first variant shown
  let zoom = 1;
  let yaw = startYaw;
  let pitch = startPitch;

  /**
   * Orbit the CAMERA for the tilt, and spin the model only about world Y.
   *
   * Dragging therefore always rotates around the upright world axis, never around a
   * tilted local one — tilt the mesh itself instead and a drag would start to roll the
   * kite as well as turn it, which is disorienting and hard to undo by hand.
   */
  function applyCamera() {
    const d = baseDistance / Math.max(0.05, zoom);
    const py = (pitch * Math.PI) / 180;
    camera.position.set(0, Math.sin(py) * d, Math.cos(py) * d);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    pivot.rotation.set(0, (yaw * Math.PI) / 180, 0);
  }

  /**
   * Put a variant on screen.
   *
   * The camera is NOT touched here. Rotation, pitch and zoom belong to the viewer, not
   * to the model, so whatever the visitor has dragged to carries across the swap — which
   * is what makes Pisahkan read as the same kite opening rather than a different object
   * appearing at a different angle.
   */
  async function show(id, { animate = false, reverse = false } = {}) {
    const entry = await getVariant(id);
    if (!entry) return null;

    if (current !== entry) {
      if (current) pivot.remove(current.obj);
      pivot.add(entry.obj);
      current = entry;
      currentId = id;
    }

    if (baseDistance == null) {
      baseDistance = distanceFor(camera, entry.maxDim, camCfg.fitMargin ?? 1.35);
    }
    applyCamera();

    if (animate && entry.spec.animation?.playOnEnter !== false) {
      await runAnimation(entry, { reverse });
    }
    return entry;
  }

  /**
   * Horizontal placement of the rotation axis on screen, in design pixels relative to
   * the viewport centre (negative = left).
   *
   * Done with setViewOffset — a shift of the rendered image — rather than by moving the
   * model or aiming the camera off-centre. Moving the pivot would put the kite off the
   * camera's axis and skew its perspective; aiming the camera would do the same. A view
   * offset leaves the projection exactly as it was and only slides the picture, so the
   * kite looks identical, still spins about its own centre, and the drag area stays the
   * full width of the screen.
   */
  let axisShiftPx = 0;
  function applyViewOffset() {
    const w = viewport.clientWidth || width;
    const h = viewport.clientHeight || height;
    if (axisShiftPx) camera.setViewOffset(w, h, -axisShiftPx, 0, w, h);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }

  const clock = new THREE.Clock();
  let raf = 0;
  let running = true;

  function tick() {
    if (!running) return;
    raf = requestAnimationFrame(tick);
    const dt = clock.getDelta();
    for (const m of mixers.values()) m.update(dt);
    renderer.render(scene, camera);
  }

  const onResize = () => {
    const w = viewport.clientWidth || width;
    const h = viewport.clientHeight || height;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio * effectiveScale(), 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    applyViewOffset();          // re-derive for the new size, and updates the projection
  };
  window.addEventListener('resize', onResize);

  await show(cfg.initialVariant ?? variants[0].id);
  tick();

  return {
    available: true,
    initialRotation: startYaw,

    setRotation(deg) { yaw = deg; applyCamera(); },
    setZoom(z) { zoom = z; applyCamera(); },

    /**
     * Put the rotation axis at `designX` (design pixels across the viewport). The
     * products screen calls this with the centre of the free space between the back
     * button and the control column, so the kite sits in the gap rather than in the
     * geometric middle of a screen whose right side is taken up by buttons.
     */
    setScreenCentre(designX) {
      const w = viewport.clientWidth || width;
      axisShiftPx = Number.isFinite(designX) ? designX - w / 2 : 0;
      applyViewOffset();
    },

    /**
     * Switching variants is deliberately asymmetric, because opening and closing are
     * not mirror images of each other in the source files:
     *
     *   to an ANIMATED variant   (Pisahkan) — swap in the exploded mesh, then play its
     *                             clips forward. The kite comes apart.
     *   to a STATIC variant      (Sambung)  — stay on the exploded mesh and play the
     *                             clips in REVERSE first, and only swap back to the
     *                             whole kite once they land. Swapping first would cut
     *                             straight to the assembled mesh with no motion at all.
     *
     * The camera is untouched throughout, so the kite closes at whatever angle the
     * visitor was already looking from.
     */
    async setVariant(id) {
      if (id === currentId) return;
      const target = variants.find((v) => v.id === id);
      if (!target) return;

      const closing = current?.spec?.animation && !target.animation;
      if (closing) {
        await runAnimation(current, { reverse: true });
        await show(id, { animate: false });
      } else {
        await show(id, { animate: true });
      }
    },

    reset() { yaw = startYaw; pitch = startPitch; zoom = 1; applyCamera(); },

    dispose() {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      for (const m of mixers.values()) m.stopAllAction();
      mixers.clear();
      for (const { obj } of cache.values()) {
        obj.traverse((child) => {
          if (!child.isMesh) return;
          child.geometry?.dispose?.();
          for (const m of [].concat(child.material ?? [])) {
            if (!m) continue;
            for (const k of Object.keys(m)) {
              const val = m[k];
              if (val && val.isTexture) val.dispose();
            }
            m.dispose?.();
          }
        });
      }
      cache.clear();
      scene.clear();
      renderer.dispose();
      renderer.forceContextLoss?.();
      renderer.domElement.remove();
    },
  };
}

function mountPlaceholder({ product, viewport, url, assetInfo, strings }) {
  const box = document.createElement('div');
  box.className = 'product-placeholder';
  if (product.thumb && assetInfo(product.thumb).exists) {
    const img = document.createElement('img');
    img.src = url(product.thumb);
    img.alt = '';
    box.appendChild(img);
  }
  const msg = strings.modelSoon ?? { ms: 'Model 3D belum tersedia', en: '3D model not yet available' };
  const p = document.createElement('p');
  p.textContent = msg.ms;
  const small = document.createElement('small');
  small.textContent = msg.en;
  box.append(p, small);
  viewport.appendChild(box);

  return {
    available: false,
    initialRotation: 0,
    setRotation() {}, setZoom() {}, setVariant() {}, reset() {},
    setScreenCentre(designX) {
      // keep the placeholder in the same free space the model would occupy
      const w = viewport.clientWidth || 1080;
      box.style.transform = Number.isFinite(designX) ? `translateX(${designX - w / 2}px)` : '';
    },
    dispose() { box.remove(); },
  };
}
