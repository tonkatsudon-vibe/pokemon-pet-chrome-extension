/* Pokémon Browser Pet — 3D stage.
 *
 * A diorama the pets walk around inside. Kept in its own file, and kept lazy:
 * three.js is ~650KB, so it is only fetched the first time a scene is actually
 * switched on. Pages browsed with the scene off pay nothing but this file.
 *
 * MV3 forbids remotely hosted code, so three.js and GLTFLoader ship inside the
 * extension (src/vendor/). Their bare `from 'three'` specifiers were rewritten
 * to sibling-relative paths, because a content script cannot install an import
 * map into its isolated world.
 *
 * The camera is FIXED — the scene is framed once per layout and does not
 * rotate. What the engine needs back is `region()`: the floor, projected into
 * the same 2D space the sprites live in (x from the viewport's left edge, y up
 * from its bottom), as a four-point convex polygon. That is what keeps a pet
 * inside the room instead of loose on the page. It stays a polygon rather than
 * a trapezoid because slicing a convex polygon is the same amount of work and
 * makes no assumption about the camera being level.
 */

(() => {
  "use strict";
  if (window.PKMN_STAGE) return;

  const THREE_URL = "src/vendor/three.module.min.js";
  const LOADER_URL = "src/vendor/GLTFLoader.js";

  const FOV_DEG = 34;
  const FIT_MARGIN = 1.06; // >1 leaves a little air around the model

  // Stage box, as a fraction of the viewport. Height also depends on the
  // scene's own `stageAspect`, so a square room is not framed in dead space.
  const STAGE_W_FRAC = 0.9;
  const STAGE_W_MAX = 1180;
  const STAGE_H_FRAC = 0.78;

  const rad = (d) => (d * Math.PI) / 180;
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  // clamp(), except an empty range (lo > hi) resolves to its midpoint.
  const fit = (n, lo, hi) => (lo > hi ? (lo + hi) / 2 : clamp(n, lo, hi));

  /** Convex hull of {x,y} points (Andrew's monotone chain), in ring order. */
  function convexHull(points) {
    const p = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    if (p.length < 3) return p;
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (const q of p) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
      lower.push(q);
    }
    const upper = [];
    for (let i = p.length - 1; i >= 0; i--) {
      const q = p[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
      upper.push(q);
    }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
  }

  // Drag-to-resize limits. Kept in step with the engine's own clamp.
  const SCALE_MIN = 0.4;
  const SCALE_MAX = 1.5;

  const DRAG_THRESHOLD_PX = 4; // move further than this and it's a drag, not a click
  const TAP_GAP_MS = 450; // max gap between the clicks of a triple-click
  const TAP_SLOP_PX = 24; // ...and how far apart they may land
  const TOOLS_MARGIN = 8; // the resize grip never gets closer to the edge
  const GRIP_INSET = 0.06; // grip's distance in from the room's right end, as a fraction of its width

  const Stage = {
    canvas: null,
    state: "off", // off | loading | ready | failed
    /** Zoom, set by the engine from config. Scales the stage box; the sprites
     *  are scaled by the same factor on their side, so the pets stay in
     *  proportion to the room. */
    scale: 1,

    /** Set by the engine. Called as (scale, committed) while the corner grip is
     *  dragged — continuously with committed=false so the change is visible,
     *  then once with true on release, which is the only point it is saved. */
    onScaleChange: null,

    /** Where the stage sits, as an offset from centred. Set by the engine. */
    offsetX: 0,
    offsetY: 0,

    /** Set by the engine. Called as (x, y, committed) while the stage is
     *  dragged, same contract as onScaleChange. */
    onMoveChange: null,

    /** Set by the engine. Called when the floor is triple-clicked. */
    onQuake: null,
    _taps: null,

    grip: null,
    tools: null, // the move/resize pill that rides on the floor's corner
    pad: null, // floor-shaped grab surface for moving the stage
    _grab: null,
    _move: null,
    _toolsSize: null,
    error: null,
    sceneKey: null,

    _THREE: null,
    _renderer: null,
    _scene: null,
    _camera: null,
    _model: null,
    _box: null,
    _mixer: null,
    _region: null, // { poly: [{x,y} x4] } in sprite coordinates
    _mountToken: 0, // abandons an in-flight load if a newer mount starts
    _rect: { left: 0, top: 0, width: 0, height: 0, vh: 0 },
    _lost: false,

    /** Screen-space floor polygon, or null while the scene isn't usable.
     *
     *  Deliberately NOT gated on a lost GL context. The floor is pure layout
     *  math and stays valid while the GPU is away; returning null there made
     *  the engine fall back to the whole viewport, and the pets walked straight
     *  out of the house (and stayed out after the context came back). */
    region() {
      return this.state === "ready" ? this._region : null;
    },

    /** The canvas box in viewport px, plus the viewport height it was laid out
     *  against — the engine needs both to carry the pets along when it moves. */
    rect() {
      return { ...this._rect };
    },

    /** Hide the grab surfaces, e.g. while the scene animates out. */
    hideControls() {
      if (this.tools) this.tools.hidden = true;
      if (this.pad) this.pad.hidden = true;
    },

    get def() {
      return (window.PKMN_SCENES || {})[this.sceneKey] || null;
    },

    // -- lifecycle ----------------------------------------------------------

    /** Create the canvas immediately, then load three.js + the model in the
     *  background. `onReady` fires once the floor region exists — which is also
     *  the right moment to play the entrance animation, since before that the
     *  canvas is just an empty transparent rectangle. */
    async mount(root, sceneKey, onReady) {
      // Tolerate being called while a previous scene is still up or midway
      // through its exit animation. Silently returning here was a real bug:
      // toggling off and straight back on left the stage permanently blank,
      // because the pending teardown then removed the canvas this call never
      // replaced.
      if (this.state !== "off") this.unmount();

      const token = ++this._mountToken;
      this.state = "loading";
      this.sceneKey = sceneKey;

      const def = this.def;
      if (!def) {
        this.state = "failed";
        this.error = new Error("unknown scene: " + sceneKey);
        console.warn("[pkmn-pet]", this.error.message);
        if (onReady) onReady();
        return;
      }
      const live = () => token === this._mountToken;

      const canvas = document.createElement("canvas");
      canvas.className = "pkmn-stage";
      canvas.dataset.scene = sceneKey;
      this.canvas = canvas;
      root.appendChild(canvas);

      // The canvas stays click-through (the empty air around the room must
      // never eat a click), so the stage is grabbed through two DOM surfaces
      // instead:
      //
      //  - a pad clipped to the room's projected outline, so grabbing anywhere
      //    on the house moves it (and triple-clicking it sets off a quake). The
      //    room is opaque, so nothing visible on the page is lost under it.
      //  - a resize grip on the room's front-right corner — on the house itself
      //    rather than out at the corner of the canvas box.
      //
      // Both are hidden until the model has loaded and been laid out.
      const pad = document.createElement("div");
      pad.className = "pkmn-stage-pad";
      pad.title = "Drag to move · triple-click for an earthquake";
      pad.hidden = true;
      this.pad = pad;
      root.appendChild(pad);
      this._bindMove(pad, { taps: true });

      const tools = document.createElement("div");
      tools.className = "pkmn-stage-tools";
      tools.hidden = true;
      const grip = document.createElement("div");
      grip.className = "pkmn-stage-tool pkmn-stage-grip";
      grip.title = "Drag to resize";
      grip.innerHTML =
        '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
        '<path d="M14 6v8H6M14 14 4 4M2 10V2h8"/></svg>';
      tools.appendChild(grip);
      this.tools = tools;
      this.grip = grip;
      root.appendChild(tools);
      this._bindGrip(grip);

      // Also bound on the canvas itself. It is pointer-events:none in the
      // shared stylesheet, so in a browser tab this never fires; the desktop
      // shell overrides that one property to opt in.
      this._bindMove(canvas, { taps: true });

      // Chrome caps live WebGL contexts (~16 per process) and drops the oldest
      // when a new one is created past that. With a canvas per tab this is a
      // matter of when, not if — so both halves are handled.
      //
      // Both handlers ignore a canvas that is no longer the live one. That
      // guard is load-bearing: unmount() releases the old context on purpose,
      // and its `webglcontextlost` arrives a task later — by which point a new
      // mount may be up. Without the guard it marked the *new* stage lost.
      canvas.addEventListener("webglcontextlost", (e) => {
        e.preventDefault(); // required, or the context never comes back
        if (canvas !== this.canvas) return;
        this._lost = true;
      });
      canvas.addEventListener("webglcontextrestored", () => {
        if (canvas !== this.canvas) return;
        this._lost = false;
        this._build();
        this.layout();
      });

      try {
        const [THREE, loaderMod] = await Promise.all([
          import(chrome.runtime.getURL(THREE_URL)),
          import(chrome.runtime.getURL(LOADER_URL)),
        ]);
        this._THREE = THREE;

        const gltf = await new Promise((resolve, reject) => {
          new loaderMod.GLTFLoader().load(
            chrome.runtime.getURL(def.file),
            resolve,
            undefined,
            reject
          );
        });

        // A newer mount (or a teardown) may have superseded us while the model
        // downloaded. Checking a token rather than the state matters: a second
        // mount puts the state back to "loading", so a state check would let
        // this stale continuation overwrite the newer scene.
        if (!live()) return;

        this._model = gltf.scene;
        this._box = new THREE.Box3().setFromObject(this._model);
        this._clips = gltf.animations || [];

        // The textures are tiny GBA-era pixel art; smoothing them on magnify
        // turns the whole model to mush.
        this._model.traverse((o) => {
          const mats = o.material ? [].concat(o.material) : [];
          for (const m of mats) {
            for (const key of ["map", "emissiveMap"]) {
              if (m[key]) {
                m[key].magFilter = THREE.NearestFilter;
                m[key].needsUpdate = true;
              }
            }
          }
        });

        this._build();
        this.layout();
        this.state = "ready";
        if (this.tools) this.tools.hidden = false;
        if (this.pad) this.pad.hidden = false;
        this._placeControls(); // the pill can be measured now it's visible
        if (onReady) onReady();
      } catch (err) {
        if (!live()) return; // superseded; the newer mount owns the state
        this.state = "failed";
        this.error = err;
        console.warn("[pkmn-pet] 3D scene failed to load:", err);
        if (this.canvas && this.canvas.parentNode) {
          this.canvas.parentNode.removeChild(this.canvas);
        }
        this.canvas = null;
        if (onReady) onReady(); // let the engine fall back to the full viewport
      }
    },

    _build() {
      const THREE = this._THREE;
      if (!THREE || !this.canvas) return;

      const renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        alpha: true, // the page shows through around the model
        antialias: true,
        powerPreference: "low-power",
      });
      renderer.setClearAlpha(0);
      this._renderer = renderer;

      const scene = new THREE.Scene();
      scene.add(this._model);
      this._scene = scene;

      // Every material in these models is KHR_materials_unlit, so there are no
      // lights to add — the colours come straight from the baked textures.
      this._camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.01, 100);

      // Some scenes ship an animation clip; play them all on a loop.
      if (this._clips && this._clips.length) {
        this._mixer = new THREE.AnimationMixer(this._model);
        for (const clip of this._clips) this._mixer.clipAction(clip).play();
      } else {
        this._mixer = null;
      }
    },

    unmount() {
      this._mountToken++; // abandon any load still in flight
      if (this._renderer) {
        this._renderer.dispose();
        // Hand the GPU context back rather than waiting for GC, so toggling
        // the scene off actually frees a slot against Chrome's context cap.
        const ext = this._renderer.getContext().getExtension("WEBGL_lose_context");
        if (ext) ext.loseContext();
      }
      if (this._mixer) this._mixer.stopAllAction();
      if (this._scene) {
        this._scene.traverse((o) => {
          if (o.geometry) o.geometry.dispose();
          const mats = o.material ? [].concat(o.material) : [];
          for (const m of mats) {
            for (const k of ["map", "emissiveMap", "normalMap"]) if (m[k]) m[k].dispose();
            m.dispose();
          }
        });
      }
      if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
      for (const el of [this.tools, this.pad]) {
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }
      this.canvas = null;
      this.grip = null;
      this.tools = null;
      this.pad = null;
      this._toolsSize = null;
      this._grab = null;
      this._move = null;
      this._renderer = this._scene = this._camera = this._model = this._box = null;
      this._mixer = null;
      this._clips = null;
      this._region = null;
      this.sceneKey = null;
      this.state = "off";
      this._lost = false;
    },

    /** Resize by dragging the corner.
     *
     *  The new scale is the ratio of the pointer's distance from the stage
     *  centre now versus when the drag started. That reads as pulling the
     *  corner in and out, works on both axes at once, and — unlike tracking
     *  raw dx — cannot invert when the pointer crosses the centre. */
    _bindGrip(grip) {
      grip.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 && e.pointerType === "mouse") return;
        e.preventDefault();
        e.stopPropagation();
        const r = this._rect;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const dist = Math.hypot(e.clientX - cx, e.clientY - cy);
        if (dist < 8) return; // degenerate: ratios would explode
        this._grab = { id: e.pointerId, cx, cy, dist, scale: this.scale };
        grip.classList.add("pkmn-grabbing");
        try {
          grip.setPointerCapture(e.pointerId);
        } catch (_) {
          /* capture is a nicety */
        }
      });

      grip.addEventListener("pointermove", (e) => {
        const g = this._grab;
        if (!g || e.pointerId !== g.id) return;
        e.preventDefault();
        const now = Math.hypot(e.clientX - g.cx, e.clientY - g.cy);
        const next = clamp((g.scale * now) / g.dist, SCALE_MIN, SCALE_MAX);
        if (this.onScaleChange) this.onScaleChange(next, false);
      });

      const end = (e) => {
        const g = this._grab;
        if (!g || e.pointerId !== g.id) return;
        this._grab = null;
        grip.classList.remove("pkmn-grabbing");
        try {
          grip.releasePointerCapture(e.pointerId);
        } catch (_) {
          /* nothing to release */
        }
        // Save once, at the end — not on every pointermove.
        if (this.onScaleChange) this.onScaleChange(this.scale, true);
      };
      grip.addEventListener("pointerup", end);
      grip.addEventListener("pointercancel", end);
    },

    /** Drag `el` (any of the move surfaces) to move the scene.
     *
     *  Nothing moves until the pointer has travelled DRAG_THRESHOLD_PX, so a
     *  plain click leaves the room exactly where it was. With `taps` set, those
     *  plain clicks are also counted, and a triple-tap fires onQuake. */
    _bindMove(el, { taps = false } = {}) {
      el.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 && e.pointerType === "mouse") return;
        e.preventDefault();
        e.stopPropagation();
        this._move = {
          id: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          ox: this.offsetX,
          oy: this.offsetY,
          dragging: false,
        };
        try {
          el.setPointerCapture(e.pointerId);
        } catch (_) {
          /* capture is a nicety */
        }
      });

      el.addEventListener("pointermove", (e) => {
        const m = this._move;
        if (!m || e.pointerId !== m.id) return;
        e.preventDefault();
        const dx = e.clientX - m.x;
        const dy = e.clientY - m.y;
        if (!m.dragging) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return; // still a click
          m.dragging = true;
          el.classList.add("pkmn-grabbing");
        }
        if (this.onMoveChange) this.onMoveChange(m.ox + dx, m.oy + dy, false);
      });

      const end = (e) => {
        const m = this._move;
        if (!m || e.pointerId !== m.id) return;
        this._move = null;
        el.classList.remove("pkmn-grabbing");
        try {
          el.releasePointerCapture(e.pointerId);
        } catch (_) {
          /* nothing to release */
        }
        if (m.dragging) {
          // Save once, on release — layout() has already clamped the offsets.
          if (this.onMoveChange) this.onMoveChange(this.offsetX, this.offsetY, true);
        } else if (taps && e.type === "pointerup") {
          this._tap(e);
        }
      };
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
    },

    /** Count consecutive clicks. Done by hand rather than via click's
     *  `detail`, because that is not reliably counted for touch taps. */
    _tap(e) {
      const now = performance.now();
      const t = this._taps;
      const chained =
        t && now - t.at < TAP_GAP_MS && Math.hypot(e.clientX - t.x, e.clientY - t.y) < TAP_SLOP_PX;
      const count = chained ? t.count + 1 : 1;
      if (count >= 3) {
        this._taps = null;
        if (this.onQuake) this.onQuake();
        return;
      }
      this._taps = { count, at: now, x: e.clientX, y: e.clientY };
    },

    // -- layout / projection ------------------------------------------------

    layout() {
      if (this.state === "failed" || !this._renderer || !this._camera) return;
      const def = this.def;
      if (!def) return;

      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const zoom = this.scale > 0 ? this.scale : 1;
      // Fit first, then zoom — so the box is a fraction of the *fitted* size
      // rather than of the viewport, and shrinking never letterboxes oddly.
      const w = Math.round(Math.min(vw * STAGE_W_FRAC, STAGE_W_MAX) * zoom);
      const h = Math.round(Math.min(vh * STAGE_H_FRAC, (w / zoom) * def.stageAspect) * zoom);

      this._renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this._renderer.setSize(w, h, false);

      this._camera.aspect = w / h;
      this._frameModel();

      // Centred, then displaced by however far it has been dragged. The framing
      // depends only on the aspect, so where the model lands inside the canvas
      // is already known — clamp against *that*, not the canvas box, which
      // carries empty air around the room. The whole room stays on screen and
      // can sit flush in a corner; if it is bigger than the viewport on an
      // axis, it is pinned centred on that axis instead.
      const pts = this._projectCorners(w, h);
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const m = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
      this._outline = convexHull(pts);
      this._anchor = this._projectAnchor(w, h);
      const baseL = (vw - w) / 2;
      const baseT = (vh - h) / 2;
      this.offsetX = fit(this.offsetX, -baseL - m.x0, vw - baseL - m.x1);
      this.offsetY = fit(this.offsetY, -baseT - m.y0, vh - baseT - m.y1);
      const left = Math.round(baseL + this.offsetX);
      const top = Math.round(baseT + this.offsetY);

      this._rect = { left, top, width: w, height: h, vh };
      const c = this.canvas;
      c.style.width = w + "px";
      c.style.height = h + "px";
      c.style.left = left + "px";
      c.style.top = top + "px";

      this._projectFloor();
      this._placeControls();
    },

    /** The model's bounding-box corners, projected into canvas px. Same index
     *  order as _corners(). */
    _projectCorners(w, h) {
      return this._corners().map((c) => {
        const p = c.project(this._camera);
        return { x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h };
      });
    },

    /** Where the resize grip sits, in canvas px: on the room's front edge, a
     *  little in from the right. Not the bounding box's corner itself — rooms
     *  often have a chamfered or cut-away corner there, which would leave the
     *  grip floating in the air beside the house. */
    _projectAnchor(w, h) {
      const box = this._box;
      const x = box.max.x - (box.max.x - box.min.x) * GRIP_INSET;
      const p = new this._THREE.Vector3(x, box.min.y, box.max.z).project(this._camera);
      return { x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h };
    },

    _corners() {
      const THREE = this._THREE;
      const box = this._box;
      const out = [];
      for (let i = 0; i < 8; i++) {
        out.push(
          new THREE.Vector3(
            i & 1 ? box.max.x : box.min.x,
            i & 2 ? box.max.y : box.min.y,
            i & 4 ? box.max.z : box.min.z
          )
        );
      }
      return out;
    },

    /** Fit the grab pad to the room's outline, and park the resize grip on the
     *  room's front-right corner — on the house, near the pets, instead of out
     *  at the canvas corner. The grip is clamped into the viewport so it stays
     *  reachable wherever the room has been pushed. */
    _placeControls() {
      const outline = this._outline;
      const anchor = this._anchor;
      if (!outline || !anchor) return;
      const { left, top, width, height } = this._rect;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      if (this.pad) {
        const s = this.pad.style;
        s.left = left + "px";
        s.top = top + "px";
        s.width = width + "px";
        s.height = height + "px";
        const pts = outline.map((p) => `${p.x.toFixed(1)}px ${p.y.toFixed(1)}px`);
        s.clipPath = `polygon(${pts.join(", ")})`;
      }

      if (this.tools) {
        // Measured once: reading offsetWidth on every drag frame would force a
        // synchronous reflow each time. It's 0 while hidden, so keep trying.
        if (!this._toolsSize) {
          const tw = this.tools.offsetWidth;
          if (tw) this._toolsSize = { w: tw, h: this.tools.offsetHeight };
        }
        const { w: tw, h: th } = this._toolsSize || { w: 30, h: 30 };
        // Centred on the corner, so it reads as a handle on the house.
        const x = clamp(left + anchor.x - tw / 2, TOOLS_MARGIN, vw - tw - TOOLS_MARGIN);
        const y = clamp(top + anchor.y - th / 2, TOOLS_MARGIN, vh - th - TOOLS_MARGIN);
        this.tools.style.left = Math.round(x) + "px";
        this.tools.style.top = Math.round(y) + "px";
      }
    },

    /** Point the camera at the model from the scene's fixed elevation and pull
     *  back until the whole thing is inside the frustum. Iterating on projected
     *  corners fits a wide flat model far better than a bounding-sphere guess. */
    _frameModel() {
      const THREE = this._THREE;
      const cam = this._camera;
      const box = this._box;

      const center = box.getCenter(new THREE.Vector3());
      const el = rad(this.def.elevationDeg);
      const dir = new THREE.Vector3(0, Math.sin(el), Math.cos(el)).normalize();

      const corners = this._corners();

      let dist = box.getSize(new THREE.Vector3()).length() / 2 / Math.sin(rad(FOV_DEG) / 2);
      for (let pass = 0; pass < 6; pass++) {
        cam.position.copy(center).addScaledVector(dir, dist);
        cam.lookAt(center);
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld(true);

        let worst = 0;
        for (const c of corners) {
          const p = c.clone().project(cam);
          worst = Math.max(worst, Math.abs(p.x), Math.abs(p.y));
        }
        if (worst < 1e-6) break;
        dist *= worst * FIT_MARGIN;
        if (Math.abs(worst * FIT_MARGIN - 1) < 0.005) break;
      }

      cam.position.copy(center).addScaledVector(dir, dist);
      cam.lookAt(center);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
    },

    /** Project the four floor corners into sprite coordinates, in ring order.
     *  Ring order matters: the engine walks the polygon's edges, so the points
     *  must stay adjacent-in-sequence rather than being sorted. */
    _projectFloor() {
      const THREE = this._THREE;
      const box = this._box;
      const cam = this._camera;
      const def = this.def;
      if (!box || !cam || !def) return;

      const { left, top, width, height } = this._rect;
      const vh = window.innerHeight;

      const cx = (box.min.x + box.max.x) / 2;
      const cz = (box.min.z + box.max.z) / 2;
      const hx = ((box.max.x - box.min.x) / 2) * def.floorInsetX;
      const hz = ((box.max.z - box.min.z) / 2) * def.floorInsetZ;
      const y = box.min.y;

      const poly = [
        [cx - hx, cz + hz],
        [cx + hx, cz + hz],
        [cx + hx, cz - hz],
        [cx - hx, cz - hz],
      ].map(([x, z]) => {
        const p = new THREE.Vector3(x, y, z).project(cam);
        return {
          // canvas px -> viewport px -> sprite space (y measured up from the
          // viewport's bottom edge, which is what the engine uses)
          x: left + (p.x * 0.5 + 0.5) * width,
          y: vh - (top + (-p.y * 0.5 + 0.5) * height),
        };
      });

      this._region = { poly };
    },

    // -- per-frame ----------------------------------------------------------

    render(dtSec) {
      if (this.state !== "ready" || this._lost || !this._renderer) return;
      if (this._mixer) this._mixer.update(dtSec || 0);
      this._renderer.render(this._scene, this._camera);
    },
  };

  window.PKMN_STAGE = Stage;
})();
