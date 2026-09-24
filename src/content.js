/* Pokémon Browser Pet — content script / Pet Engine.
 *
 * Architecture (kept deliberately small so it can later be lifted into a
 * shared pokemon-pet-core package):
 *
 *   Config (chrome.storage.local)
 *        -> World          one overlay, one rAF loop, one set of window
 *             |            listeners — reconciled against the config
 *             +-> Pet[]    one instance per selected character
 *                   -> State Machine  (IDLE / WALKING / TURNING / INTERACT / SLEEP / DRAG)
 *                   -> Movement Engine (2D unit heading, reflects off all walls)
 *                   -> Animation       (transform-driven bob / pitch / squash)
 *                   -> Interaction     (click -> hop + bubble + cry, drag -> move)
 *        -> DOM overlay (#pkmn-pet-root > .pkmn-pet ...)
 *
 * Several pets share the overlay, the animation frame and the window listeners;
 * each owns its own element, simulation state and drop height. Pets ignore one
 * another and walk straight through — that keeps the loop O(n) and avoids a
 * collision system nobody asked for.
 *
 * Coordinates: `x` is px from the viewport's left edge, `yOffset` is px above
 * its bottom edge (so +y is up, which keeps the physics readable). The heading
 * (`vx`, `vy`) is a unit vector, so speed is one scalar regardless of angle.
 */

(() => {
  "use strict";

  // Only run in the top document. Re-injection is handled by boot.js, which
  // has already torn down any previous instance by the time we get here — so
  // there is deliberately no "already loaded, bail out" guard. Bailing out was
  // what left a context-invalidated copy running after an extension reload.
  if (window.top !== window) return;

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  /** `characters` and `yOffsets` default to null/undefined rather than to a real
   *  value, so `migrate()` can tell "never written" from "deliberately empty" —
   *  unchecking every Pokémon has to survive a reload. */
  const DEFAULTS = {
    enabled: true,
    speed: 5, // 1..10 slider; 5 == the character's natural pace
    characters: null, // array of CHARACTERS keys; null = not written yet
    movement: "free", // "free" = walk + climb + fly, "ground" = left/right only
    sound: true, // play the character's cry when a pet is clicked
    scene: false, // show the 3D diorama and pen the pets inside it
    sceneId: null, // which diorama; null = the first in the registry
    yOffsets: null, // { [character]: px above the viewport bottom }
    reloadAt: 0, // stamp bumped by the popup's Reload button
    scale: 1, // 0.4..1.5 — zooms the diorama and the pets together
    stageX: 0, // px the diorama has been dragged from centre
    stageY: 0,
    // Legacy single-pet keys, read only so an older profile migrates cleanly.
    character: null,
    yOffset: null,
  };

  /** Playable characters come from src/characters.js, which is injected ahead
   *  of this file and shares the isolated world. Declared there so the popup
   *  reads the exact same table. */
  const CHARACTERS = window.PKMN_CHARACTERS;
  const CHARACTER_KEYS = window.PKMN_CHARACTER_KEYS;
  const SCENES = window.PKMN_SCENES || {};
  const SCENE_KEYS = window.PKMN_SCENE_KEYS || [];

  if (!CHARACTERS || !CHARACTER_KEYS) {
    console.warn("[pkmn-pet] character registry missing — is characters.js listed before content.js in the manifest?");
    return;
  }

  const PHRASES = ["Roar!", "Rawr!", "How're you today?", "Fire Thunder!", "Let's drag me!", "♪ ♪"];
  const SLEEP_PHRASE = "Zzz…";

  const INACTIVITY_SLEEP_MS = 60000; // no user input this long -> pets nap
  const TURN_MS = 260;
  const INTERACT_MS = 780;
  const DRAG_THRESHOLD_PX = 4; // move further than this and it's a drag, not a click
  const DOUBLE_CLICK_MS = 340; // two clicks closer together than this evolve the pet
  const EDGE_EPS = 2; // px tolerance when deciding "am I against a wall?"
  const PITCH_DEG = 14; // how far the sprite noses up/down when climbing/diving
  const SHADOW_FADE_PX = 160; // altitude at which the ground shadow has faded out
  const CRY_VOLUME = 0.5; // the pet lives on someone else's page — don't shout

  /* Evolution — double-click a pet whose character has an `evolvesTo`.
   * The pet freezes, flickers white, and the sprite is swapped at the peak of
   * the flash, so the old form is never seen turning into the new one. The
   * timings are shared with the pkmn-evo-* keyframes in pet.css and have to
   * move together with them. */
  const EVOLVE_CHARGE_MS = 1100; // flicker before the swap
  const EVOLVE_BURST_MS = 700; // white-out, swap, then fade back to colour
  const EVOLVE_PHRASES = ["…?", "Huh?", "!"]; // said as the flicker starts
  /* Where the sprite strobes white, as fractions of EVOLVE_CHARGE_MS. These
   * mirror the pkmn-evo-strobe keyframes, so the charge blips land on the
   * light rather than merely near it. */
  const EVOLVE_BEATS = [0.12, 0.31, 0.5, 0.66, 0.79, 0.9];

  /* Zoom. One factor scales the sprites and the diorama together, so the pets
   * stay in proportion to the room they are standing in — shrinking only the
   * scene would leave them looking like giants in a dollhouse. */
  const SCALE_MIN = 0.4;
  const SCALE_MAX = 1.5;

  /* Earthquake — triple-click the diorama's floor. The overlay shakes and the
   * pets bolt at QUAKE_SPEED× their pace, both easing back to normal over
   * QUAKE_MS. */
  const QUAKE_MS = 3000;
  const QUAKE_SPEED = 4; // pace multiplier at the start of the quake
  const QUAKE_SHAKE_PX = 10; // peak shake amplitude
  const QUAKE_PHRASES = ["!!", "Whoa!", "Earthquake!", "Eek!"];
  const QUAKE_SOUND = "assets/icons/pokemon/sounds/Earthquake.mp3";
  // The rumble and the pets' yelps outlast the shake a little, matching the
  // ~3.6s clip. The rumble fades out over its last QUAKE_FADE_MS.
  const QUAKE_SOUND_MS = 3500;
  const QUAKE_FADE_MS = 700;

  /* Scene entrance/exit choreography. The pets fade out, the room flies in,
   * then the pets fade back in already standing inside it.
   * Fading the pets rather than sliding them matters: their transform is
   * rewritten every frame by the animation loop, so only opacity is safe to
   * hand over to CSS. */
  const STAGE_IN_MS = 620; // must match the pkmn-stage-in keyframes
  const STAGE_OUT_MS = 260; // must match pkmn-stage-out
  const PETS_REVEAL_MS = 300; // into the entrance, when pets start fading back

  /** How a heading is chosen in free-roam mode. Weights sum to 1.
   *  Note these are odds *per bout*, and bouts differ in length — the felt
   *  ratio is weight × duration, so short vertical hops read as much rarer
   *  than their weight suggests. Keep them roughly comparable in length. */
  const GAITS = [
    { kind: "horizontal", weight: 0.25, minMs: 2400, maxMs: 5200 },
    { kind: "diagonal", weight: 0.45, minMs: 2400, maxMs: 5600 },
    { kind: "vertical", weight: 0.3, minMs: 2200, maxMs: 4800 },
  ];

  /** Diagonal angle range, in degrees off horizontal. Kept steep — below ~30°
   *  a diagonal is indistinguishable from a slightly crooked walk. */
  const DIAG_MIN_DEG = 30;
  const DIAG_MAX_DEG = 70;

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const coin = () => (Math.random() < 0.5 ? -1 : 1);
  const prefersReducedMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "wheel", "touchstart", "scroll"];

  /** Normalize a stored config into the shape the engine wants, migrating the
   *  old single-pet keys on the way. Runs on every apply, so a profile written
   *  by an older build keeps working without a one-shot upgrade step. */
  function migrate(raw) {
    const cfg = { ...DEFAULTS, ...raw };

    if (!Array.isArray(cfg.characters)) {
      // Never written: adopt the old single `character`, else the default one.
      const legacy =
        cfg.character && CHARACTERS[cfg.character] ? cfg.character : CHARACTER_KEYS[0];
      cfg.characters = [legacy];
    }
    // Drop unknown keys and duplicates; an empty array is legitimate (the user
    // unchecked everything) and must survive.
    cfg.characters = cfg.characters.filter(
      (k, i) => CHARACTERS[k] && cfg.characters.indexOf(k) === i
    );

    if (!SCENES[cfg.sceneId]) cfg.sceneId = SCENE_KEYS[0] || null;

    const n = Number(cfg.scale);
    cfg.scale = Number.isFinite(n) ? clamp(n, SCALE_MIN, SCALE_MAX) : 1;

    // Offsets get re-clamped against the live viewport by Stage.layout(), so
    // all that is needed here is to reject junk. Note Number(null) is 0 and
    // Number("") is 0, hence the explicit null/"" guard.
    for (const key of ["stageX", "stageY"]) {
      const v = cfg[key];
      const num = v === null || v === "" ? NaN : Number(v);
      cfg[key] = Number.isFinite(num) ? num : 0;
    }

    if (!cfg.yOffsets || typeof cfg.yOffsets !== "object") {
      cfg.yOffsets = {};
      // The old single yOffset belonged to the old single character.
      if (cfg.yOffset && cfg.character && CHARACTERS[cfg.character]) {
        cfg.yOffsets[cfg.character] = cfg.yOffset;
      }
    }

    return cfg;
  }

  // ---------------------------------------------------------------------------
  // Sound
  // ---------------------------------------------------------------------------

  /** One reused <audio> per character cry.
   *
   *  Reusing the element (rather than constructing one per click) keeps the
   *  file decoded and means a rapid second click restarts the cry instead of
   *  layering a chorus on top of itself. `play()` is only ever called from a
   *  pointerup handler, so it always carries a user gesture and autoplay
   *  policy lets it through — but the promise is caught anyway, because a
   *  page can still refuse the load and that must never break the pet. */
  const Cries = {
    cache: new Map(),

    /** Get (and, first time, start fetching) the element for a cry file. */
    load(file) {
      if (!file) return null;
      let audio = this.cache.get(file);
      if (!audio) {
        audio = new Audio(chrome.runtime.getURL(file));
        audio.preload = "auto";
        audio.volume = CRY_VOLUME;
        this.cache.set(file, audio);
      }
      return audio;
    },

    play(file, key) {
      const audio = this.load(file);
      if (!audio) {
        // No recording ships for this character — synthesize one rather than
        // borrowing another Pokémon's cry, which would just sound wrong.
        this.synth(key);
        return;
      }
      try {
        audio.currentTime = 0;
      } catch (_) {
        /* not seekable yet; it'll just play from wherever it is */
      }
      const p = audio.play();
      if (p && typeof p.catch === "function") {
        // A missing or undecodable file lands here; fall back rather than
        // leaving the click silent. An autoplay block lands here too, in which
        // case the fallback is blocked as well and this is a no-op.
        p.catch(() => this.synth(key));
      }
    },

    /** A sound effect rather than a cry: no synthesized fallback (a chirp is
     *  the wrong noise for an earthquake). Returns the element so the caller
     *  can fade it out. */
    effect(file) {
      const audio = this.load(file);
      if (!audio) return null;
      audio.volume = CRY_VOLUME;
      try {
        audio.currentTime = 0;
      } catch (_) {
        /* not seekable yet */
      }
      const p = audio.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
      return audio;
    },

    /** Lazily-created AudioContext. Only ever reached from a pointerup
     *  handler, so it is created under a user gesture and starts unsuspended. */
    context() {
      if (this._ctxFailed) return null;
      if (!this._ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) {
          this._ctxFailed = true;
          return null;
        }
        try {
          this._ctx = new AC();
        } catch (_) {
          this._ctxFailed = true;
          return null;
        }
      }
      if (this._ctx.state === "suspended") this._ctx.resume().catch(() => {});
      return this._ctx;
    },

    /** The evolution sound, synthesized rather than shipped: an accelerating
     *  charge that lands one blip on each white flash of the sprite's strobe,
     *  a rising hum underneath it, and a four-note chime with a sparkle of
     *  filtered noise at the moment the new form appears.
     *
     *  The whole sequence is scheduled in one go on the audio clock. It is
     *  started from a pointerup handler, so even the part that sounds a second
     *  later inherits that user gesture — and the audio clock, not setTimeout,
     *  is what keeps it locked to the CSS keyframes.
     *
     *  Returns a handle whose stop() silences whatever has not played yet, for
     *  when the pet is torn down mid-evolution. */
    evolution(chargeMs, beats) {
      const ctx = this.context();
      if (!ctx) return null;

      const t0 = ctx.currentTime;
      const charge = chargeMs / 1000;
      const sources = [];
      let master = null;

      try {
        master = ctx.createGain();
        master.gain.value = CRY_VOLUME;
        master.connect(ctx.destination);

        /** One enveloped note. exponentialRamp can't start from 0, hence the
         *  near-zero floor either side. */
        const note = (at, freq, dur, type, peak) => {
          const gain = ctx.createGain();
          gain.gain.setValueAtTime(0.0001, at);
          gain.gain.exponentialRampToValueAtTime(peak, at + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
          gain.connect(master);

          const osc = ctx.createOscillator();
          osc.type = type;
          osc.frequency.setValueAtTime(freq, at);
          osc.connect(gain);
          osc.start(at);
          osc.stop(at + dur);
          osc.onended = () => {
            osc.disconnect();
            gain.disconnect();
          };
          sources.push(osc);
        };

        // Charge: chiptune blips, one per flash, each a little higher.
        beats.forEach((p, i) => {
          note(t0 + p * charge, 330 * Math.pow(1.11, i), 0.09, "square", 0.22);
        });

        // A hum swelling under the blips, so the charge has a floor to climb.
        const humGain = ctx.createGain();
        humGain.gain.setValueAtTime(0.0001, t0);
        humGain.gain.exponentialRampToValueAtTime(0.13, t0 + charge);
        humGain.gain.exponentialRampToValueAtTime(0.0001, t0 + charge + 0.12);
        humGain.connect(master);
        const hum = ctx.createOscillator();
        hum.type = "sawtooth";
        hum.frequency.setValueAtTime(70, t0);
        hum.frequency.exponentialRampToValueAtTime(240, t0 + charge);
        hum.connect(humGain);
        hum.start(t0);
        hum.stop(t0 + charge + 0.14);
        hum.onended = () => {
          hum.disconnect();
          humGain.disconnect();
        };
        sources.push(hum);

        // The swap: a rising chime, C-E-G-C.
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
          note(t0 + charge + i * 0.055, f, 0.55, "triangle", 0.3);
        });

        // ...and the shiny itself: a band of noise sweeping upwards.
        const len = Math.floor(ctx.sampleRate * 0.6);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
        const noise = ctx.createBufferSource();
        noise.buffer = buf;
        const band = ctx.createBiquadFilter();
        band.type = "bandpass";
        band.Q.value = 1.2;
        band.frequency.setValueAtTime(1800, t0 + charge);
        band.frequency.exponentialRampToValueAtTime(7000, t0 + charge + 0.45);
        const noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(0.0001, t0 + charge);
        noiseGain.gain.exponentialRampToValueAtTime(0.2, t0 + charge + 0.05);
        noiseGain.gain.exponentialRampToValueAtTime(0.0001, t0 + charge + 0.6);
        noise.connect(band);
        band.connect(noiseGain);
        noiseGain.connect(master);
        noise.start(t0 + charge);
        noise.onended = () => {
          noise.disconnect();
          band.disconnect();
          noiseGain.disconnect();
        };
        sources.push(noise);
      } catch (_) {
        /* the sound is a nicety; never let it break the evolution */
      }

      return {
        stop() {
          for (const src of sources) {
            try {
              src.stop();
            } catch (_) {
              /* already finished, or never started */
            }
          }
          if (master) {
            try {
              master.disconnect();
            } catch (_) {
              /* already gone */
            }
          }
        },
      };
    },

    /** Stand-in cry for a character with no mp3.
     *
     *  A square-wave chirp that rises then falls — deliberately chiptune-ish,
     *  to sit with the pixel-art sprites rather than pretending to be a real
     *  recording. The pitch is derived from the character key, so each such
     *  character gets its own consistent voice instead of all of them sounding
     *  identical. */
    synth(key) {
      const ctx = this.context();
      if (!ctx) return;

      let h = 0;
      for (let i = 0; i < (key || "").length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
      const base = 200 + (h % 170); // ~200-370Hz, comfortably in a "cry" range
      const t0 = ctx.currentTime;
      const dur = 0.28;

      try {
        const gain = ctx.createGain();
        // Ramp from near-zero: exponentialRamp cannot start at exactly 0.
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(CRY_VOLUME * 0.45, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        gain.connect(ctx.destination);

        const osc = ctx.createOscillator();
        osc.type = "square";
        osc.frequency.setValueAtTime(base, t0);
        osc.frequency.exponentialRampToValueAtTime(base * 1.65, t0 + 0.08);
        osc.frequency.exponentialRampToValueAtTime(base * 0.75, t0 + dur);
        osc.connect(gain);
        osc.start(t0);
        osc.stop(t0 + dur);
        osc.onended = () => {
          osc.disconnect();
          gain.disconnect();
        };
      } catch (_) {
        /* a synthesized cry is a nicety; never let it break the click */
      }
    },

    _ctx: null,
    _ctxFailed: false,
  };

  // ---------------------------------------------------------------------------
  // Pet — one roaming character. Owns its element and simulation state only;
  // the overlay, the clock and the window listeners belong to the World.
  // ---------------------------------------------------------------------------

  class Pet {
    constructor(world, key) {
      this.world = world;
      this.key = key;

      // simulation
      this.state = "IDLE";
      this.x = 0;
      this.yOffset = 0; // px above the viewport bottom
      this.vx = 1; // unit heading, +x is right
      this.vy = 0; // unit heading, +y is up
      this.pvx = 1; // heading to adopt when the current TURNING finishes
      this.pvy = 0;
      this.facing = coin(); // last non-zero horizontal direction; drives the flip
      this.stateUntil = 0; // performance.now() timestamp for the next transition
      this.turnStart = 0;
      this.interactStart = 0;
      this.bubbleTimer = 0;
      this.shadowKey = ""; // memo so we only touch shadow styles when they change
      this.stride = 0; // footstep phase; accumulated so a speed change can't make it jump

      // drag
      this.dragging = false;
      this.dragCandidate = false;
      this.pointerId = null;
      this.grabDX = 0; // pointer offset inside the sprite box, so it doesn't jump
      this.grabDY = 0;
      this.downX = 0;
      this.downY = 0;
      this.dragLean = 0; // smoothed pointer velocity, used to tilt the sprite
      this.lastPointerX = 0;

      // evolution
      this.lastClickAt = 0; // for the double-click test; 0 == no click pending
      this.evolveStart = 0;
      this.evolveTimers = [];
      this.evolveSound = null; // handle for the scheduled evolution sequence

      this.build();
    }

    get char() {
      return CHARACTERS[this.key];
    }

    get cfg() {
      return this.world.cfg;
    }

    // Pixels/second along the heading, scaled by the speed slider (1..10 -> 0.2x..2x)
    // and by any earthquake in progress.
    get pxPerSec() {
      return this.char.baseSpeed * (clamp(this.cfg.speed, 1, 10) / 5) * this.world.boost;
    }

    /* Bounds.
     *
     * A pet is positioned by its box's left edge (`x`) but *stands* at the
     * middle of its base, so containment is tested against that point — call
     * it the feet. On the open page that works out identical to keeping the
     * whole box on screen; inside the diorama it is what puts the sprite on
     * the floor rather than floating it off the near edge.
     *
     * The walkable area is a convex polygon (see World.bounds): the diorama
     * floor projects to a quadrilateral whose shape shifts as the scene is
     * rotated, and the full viewport is just the rectangular case. */

    /** On-screen size: the character's natural box times the zoom factor.
     *  Everything that positions or bounds a pet goes through this, never
     *  `char.size` directly, so zooming moves the whole system together. */
    get size() {
      return Math.round(this.char.size * this.cfg.scale);
    }

    get feetX() {
      return this.x + this.size / 2;
    }

    set feetX(v) {
      this.x = v - this.size / 2;
    }

    get minY() {
      const poly = this.world.bounds().poly;
      let m = Infinity;
      for (const p of poly) if (p.y < m) m = p.y;
      return m;
    }

    get maxY() {
      const b = this.world.bounds();
      let m = -Infinity;
      for (const p of b.poly) if (p.y > m) m = p.y;
      // On the open page, hold the whole sprite on screen. In the diorama the
      // pet's head is allowed past the back edge of the floor — that is what
      // standing at the back of a room looks like.
      return Math.max(this.minY, m - (b.fitSprite ? this.size : 0));
    }

    /** Horizontal range for the feet at a given height, found by slicing the
     *  walkable polygon with a horizontal line. A convex polygon meets that
     *  line in exactly one interval, which is the whole trick: the open page
     *  (a rectangle) and a rotated diorama floor (any convex quad) both fall
     *  out of this one function. */
    xRangeAt(y) {
      const b = this.world.bounds();
      const poly = b.poly;
      let lo = Infinity;
      let hi = -Infinity;

      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const c = poly[(i + 1) % poly.length];
        const dy = c.y - a.y;
        if (Math.abs(dy) < 1e-9) {
          // Horizontal edge: contributes only when the slice runs along it.
          if (Math.abs(a.y - y) < 1e-6) {
            lo = Math.min(lo, a.x, c.x);
            hi = Math.max(hi, a.x, c.x);
          }
          continue;
        }
        const t = (y - a.y) / dy;
        if (t < 0 || t > 1) continue;
        const x = a.x + t * (c.x - a.x);
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }

      if (lo > hi) {
        // The slice missed the polygon — only reachable through rounding right
        // at a vertex. Fall back to the nearest corner so the pet still gets a
        // finite answer instead of Infinity.
        let best = poly[0];
        let bestD = Infinity;
        for (const p of poly) {
          const d = Math.abs(p.y - y);
          if (d < bestD) {
            bestD = d;
            best = p;
          }
        }
        lo = hi = best.x;
      }

      const inset = b.fitSprite ? this.size / 2 : 0;
      lo += inset;
      hi -= inset;
      if (hi < lo) lo = hi = (lo + hi) / 2; // area narrower than the sprite
      return { lo, hi };
    }

    get freeRoam() {
      return this.cfg.movement !== "ground";
    }

    // -- lifecycle ----------------------------------------------------------

    build() {
      const c = this.char;

      const el = document.createElement("div");
      el.className = "pkmn-pet";
      el.dataset.pkmn = this.key;
      el.setAttribute("role", "button");
      el.setAttribute("aria-label", c.name + " browser pet");
      el.title = c.evolvesTo
        ? c.name + " — click me, drag me anywhere, or double-click to evolve"
        : c.name + " — click me, or drag me anywhere";
      el.style.width = this.size + "px";
      el.style.height = this.size + "px";

      const sprite = document.createElement("div");
      sprite.className = "pkmn-pet-sprite";

      const img = document.createElement("img");
      img.alt = "";
      img.decoding = "async";
      img.draggable = false;
      img.src = chrome.runtime.getURL(c.file);

      const shadow = document.createElement("div");
      shadow.className = "pkmn-pet-shadow";

      const bubble = document.createElement("div");
      bubble.className = "pkmn-pet-bubble";
      bubble.setAttribute("aria-hidden", "true");

      // The evolution burst. Its own layer because the sprite's transform is
      // rewritten every frame from JS and cannot be handed to CSS.
      const flash = document.createElement("div");
      flash.className = "pkmn-pet-flash";
      flash.setAttribute("aria-hidden", "true");

      sprite.appendChild(img);
      el.appendChild(shadow);
      el.appendChild(flash);
      el.appendChild(sprite);
      el.appendChild(bubble);

      // Pointer events cover mouse + touch + pen with one code path.
      el.addEventListener("pointerdown", (e) => this.onPointerDown(e));
      el.addEventListener("pointermove", (e) => this.onPointerMove(e));
      el.addEventListener("pointerup", (e) => this.onPointerUp(e));
      el.addEventListener("pointercancel", (e) => this.onPointerUp(e));
      el.addEventListener("dragstart", (e) => e.preventDefault());
      el.addEventListener("contextmenu", (e) => e.preventDefault());

      this.el = el;
      this.sprite = sprite;
      this.img = img;
      this.shadow = shadow;
      this.bubble = bubble;
      this.flash = flash;

      if (this.cfg.sound) Cries.load(c.cry); // prefetch so the first click isn't late
    }

    /** Place a freshly created pet. `slot`/`total` spread the starting pets
     *  across the viewport instead of stacking them all on the same spot. */
    place(slot, total) {
      const stored = this.cfg.yOffsets[this.key];
      this.yOffset = clamp(
        typeof stored === "number" ? stored : this.minY,
        this.minY,
        this.maxY
      );
      const { lo, hi } = this.xRangeAt(this.yOffset);
      const lane = lo + ((slot + 0.5) / Math.max(1, total)) * (hi - lo);
      this.feetX = clamp(lane + rand(-40, 40), lo, hi);
    }

    destroy() {
      clearTimeout(this.bubbleTimer);
      this.evolveTimers.forEach(clearTimeout);
      this.evolveTimers = [];
      // Notes are scheduled ahead of time, so a pet torn down mid-evolution
      // would otherwise keep chiming after it is gone.
      if (this.evolveSound) this.evolveSound.stop();
      this.evolveSound = null;
      if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    }

    // -- drag ---------------------------------------------------------------

    onPointerDown(e) {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      // Mid-evolution the pet belongs to the animation, not to the pointer.
      if (this.state === "EVOLVE") return;
      e.preventDefault();
      e.stopPropagation();

      const box = this.el.getBoundingClientRect();
      this.pointerId = e.pointerId;
      this.dragCandidate = true;
      this.dragging = false;
      this.downX = e.clientX;
      this.downY = e.clientY;
      this.grabDX = e.clientX - box.left;
      this.grabDY = e.clientY - box.top;
      this.lastPointerX = e.clientX;
      this.world.lastActivity = performance.now();

      try {
        this.el.setPointerCapture(e.pointerId);
      } catch (_) {
        /* capture is a nicety; pointermove on the element still works */
      }
    }

    onPointerMove(e) {
      if (!this.dragCandidate || e.pointerId !== this.pointerId) return;
      e.preventDefault();

      if (!this.dragging) {
        const moved = Math.hypot(e.clientX - this.downX, e.clientY - this.downY);
        if (moved < DRAG_THRESHOLD_PX) return; // still a click, not a drag
        this.beginDrag();
      }

      // Smoothed horizontal velocity drives the "carried" tilt.
      const dx = e.clientX - this.lastPointerX;
      this.lastPointerX = e.clientX;
      this.dragLean = this.dragLean * 0.7 + dx * 0.3;

      this.yOffset = clamp(
        window.innerHeight - (e.clientY - this.grabDY) - this.size,
        this.minY,
        this.maxY
      );
      const drop = this.xRangeAt(this.yOffset);
      this.feetX = clamp(e.clientX - this.grabDX + this.size / 2, drop.lo, drop.hi);

      // Face the way it's being dragged.
      if (dx > 1) this.facing = 1;
      else if (dx < -1) this.facing = -1;
    }

    onPointerUp(e) {
      if (e.pointerId !== this.pointerId) return;
      const wasDragging = this.dragging;
      this.dragCandidate = false;
      this.dragging = false;
      this.pointerId = null;
      this.dragLean = 0;

      try {
        this.el.releasePointerCapture(e.pointerId);
      } catch (_) {
        /* nothing to release */
      }

      if (wasDragging) {
        // A drag isn't half of a double-click; don't let it pair with a click.
        this.lastClickAt = 0;
        this.endDrag();
      } else {
        this.onClick();
      }
    }

    beginDrag() {
      this.dragging = true;
      this.state = "DRAG";
      this.el.classList.add("pkmn-dragging");
      clearTimeout(this.bubbleTimer);
      this.bubble.classList.remove("pkmn-show");
    }

    endDrag() {
      const now = performance.now();
      this.el.classList.remove("pkmn-dragging");
      this.world.lastActivity = now;
      this.persistPosition();

      // Land with a squash, then set off again on a freshly chosen heading.
      this.pvx = null;
      this.pvy = null;
      this.turnStart = now;
      this.state = "TURNING";
      this.stateUntil = now + TURN_MS;
    }

    /** Each pet remembers its own drop height, under its character key. */
    persistPosition() {
      const y = Math.round(this.yOffset);
      if (y === this.cfg.yOffsets[this.key]) return;
      const next = { ...this.cfg.yOffsets, [this.key]: y };
      this.cfg.yOffsets = next;
      chrome.storage.local.set({ yOffsets: next });
    }

    /** A click that wasn't a drag. Two of them in quick succession on a pet
     *  with a next form evolve it; anything else is the usual hop-and-cry.
     *  The first click still reacts immediately — waiting DOUBLE_CLICK_MS to
     *  find out whether a second one is coming would make every single click
     *  feel late, and the cry also has to stay inside the user gesture. */
    onClick() {
      const now = performance.now();
      const isDouble = this.lastClickAt > 0 && now - this.lastClickAt < DOUBLE_CLICK_MS;
      // Reset rather than restamp, so a triple click isn't two double clicks.
      this.lastClickAt = isDouble ? 0 : now;

      if (isDouble && this.char.evolvesTo) {
        this.evolve(now);
        return;
      }
      this.onInteract();
    }

    /** Double-clicked: freeze, flicker white, swap to the next form.
     *  The swap happens at the peak of the flash — the point of the white-out
     *  is that you never see one sprite become the other. */
    evolve(now) {
      const to = this.char.evolvesTo;
      if (!to || !CHARACTERS[to] || this.state === "EVOLVE") return;

      const from = this.key;
      this.world.lastActivity = now;
      this.state = "EVOLVE"; // no case in tickState, so the pet holds still
      this.evolveStart = now;
      this.el.classList.add("pkmn-evolving");
      this.say(EVOLVE_PHRASES[(Math.random() * EVOLVE_PHRASES.length) | 0], EVOLVE_CHARGE_MS);
      if (this.cfg.sound) {
        // Scheduled here, in the pointerup gesture, rather than alongside the
        // timers below — the chime has to land with the flash, and setTimeout
        // is not the clock for that.
        this.evolveSound = Cries.evolution(EVOLVE_CHARGE_MS, EVOLVE_BEATS);
        Cries.load(CHARACTERS[to].cry); // ready for the reveal
      }

      this.evolveTimers.push(
        setTimeout(() => this.swapForm(from, to), EVOLVE_CHARGE_MS),
        setTimeout(() => this.endEvolve(to), EVOLVE_CHARGE_MS + EVOLVE_BURST_MS)
      );
    }

    /** Peak of the flash: become the new character. */
    swapForm(from, to) {
      const c = CHARACTERS[to];
      this.key = to;
      this.el.dataset.pkmn = to;
      this.el.setAttribute("aria-label", c.name + " browser pet");
      this.el.title = c.evolvesTo
        ? c.name + " — click me, drag me anywhere, or double-click to evolve"
        : c.name + " — click me, or drag me anywhere";
      this.img.src = chrome.runtime.getURL(c.file);
      this.el.classList.remove("pkmn-evolving");
      this.el.classList.add("pkmn-evolved");
      // A bigger form has to grow from its feet, not sink through the floor.
      this.applySize();
      this.clampToBounds();
      // Tell the world last: it rewrites the stored roster, and every pet
      // wants to already be its new self when that comes back as a change.
      this.world.onEvolved(this, from, to);
    }

    /** The flash is over: announce the new form and hand the pet back to the
     *  state machine. */
    endEvolve(to) {
      this.evolveTimers = [];
      this.evolveSound = null; // everything it scheduled has played by now
      this.el.classList.remove("pkmn-evolved");
      if (this.state !== "EVOLVE") return; // superseded (a config reload, say)
      if (this.cfg.sound) Cries.play(CHARACTERS[to].cry, to);
      this.say(CHARACTERS[to].name + "!");
      this.enterIdle(performance.now());
    }

    onInteract() {
      const now = performance.now();
      this.world.lastActivity = now;
      // Called straight from pointerup, so this still counts as a user gesture.
      if (this.cfg.sound) Cries.play(this.char.cry, this.key);
      if (this.state === "SLEEP") {
        this.wake(now);
        return;
      }
      this.state = "INTERACT";
      this.interactStart = now;
      this.stateUntil = now + INTERACT_MS;
      this.say(PHRASES[(Math.random() * PHRASES.length) | 0]);
    }

    // -- movement engine ----------------------------------------------------

    /** Choose a fresh unit heading and how long to hold it.
     *  In "ground" mode this is always pure left/right; in "free" mode it mixes
     *  horizontal walks, diagonal glides and vertical climbs. */
    pickHeading() {
      let vx, vy, minMs, maxMs;

      if (!this.freeRoam) {
        vx = coin();
        vy = 0;
        minMs = 2600;
        maxMs = 7000;
      } else {
        let roll = Math.random();
        let gait = GAITS[GAITS.length - 1];
        for (const g of GAITS) {
          if (roll < g.weight) {
            gait = g;
            break;
          }
          roll -= g.weight;
        }
        minMs = gait.minMs;
        maxMs = gait.maxMs;

        if (gait.kind === "horizontal") {
          vx = coin();
          vy = 0;
        } else if (gait.kind === "vertical") {
          vx = 0;
          vy = coin();
        } else {
          // Diagonal: a real angle, kept off the axes so it reads as diagonal.
          const ang = rand(DIAG_MIN_DEG, DIAG_MAX_DEG) * (Math.PI / 180);
          vx = coin() * Math.cos(ang);
          vy = coin() * Math.sin(ang);
        }
      }

      // Don't set off straight into a wall we're already touching.
      const { lo, hi } = this.xRangeAt(this.yOffset);
      if (this.feetX <= lo + EDGE_EPS && vx < 0) vx = -vx;
      else if (this.feetX >= hi - EDGE_EPS && vx > 0) vx = -vx;
      if (this.yOffset <= this.minY + EDGE_EPS && vy < 0) vy = -vy;
      else if (this.yOffset >= this.maxY - EDGE_EPS && vy > 0) vy = -vy;

      return { vx, vy, ms: rand(minMs, maxMs) };
    }

    setHeading(vx, vy) {
      this.vx = vx;
      this.vy = vy;
      if (vx > 0.05) this.facing = 1;
      else if (vx < -0.05) this.facing = -1;
      // A pure vertical climb keeps whichever way it was already looking.
    }

    /** Advance along the heading and bounce off any wall we run into.
     *  Returns true if an edge was hit (which triggers a TURNING beat). */
    step(dt) {
      const d = this.pxPerSec * dt;
      this.x += this.vx * d;
      this.yOffset += this.vy * d;

      let nvx = this.vx;
      let nvy = this.vy;
      let hit = false;

      // Depth first: it decides how wide the floor is at this point, so the
      // horizontal test below has to use the post-move range.
      const minY = this.minY;
      const maxY = this.maxY;
      if (this.yOffset <= minY) {
        this.yOffset = minY;
        if (nvy < 0) {
          nvy = -nvy;
          hit = true;
        }
      } else if (this.yOffset >= maxY) {
        this.yOffset = maxY;
        if (nvy > 0) {
          nvy = -nvy;
          hit = true;
        }
      }

      const { lo, hi } = this.xRangeAt(this.yOffset);
      if (this.feetX <= lo) {
        this.feetX = lo;
        if (nvx < 0) {
          nvx = -nvx;
          hit = true;
        }
      } else if (this.feetX >= hi) {
        this.feetX = hi;
        if (nvx > 0) {
          nvx = -nvx;
          hit = true;
        }
      }

      if (hit) {
        this.pvx = nvx;
        this.pvy = nvy;
      }
      return hit;
    }

    // -- state machine ------------------------------------------------------

    enterIdle(now) {
      this.state = "IDLE";
      this.stateUntil = now + rand(900, 2600);
    }

    /** Start walking. Pass a heading to force one, or omit to pick a new one. */
    enterWalking(now, fvx, fvy) {
      this.state = "WALKING";
      if (typeof fvx === "number" && typeof fvy === "number") {
        this.setHeading(fvx, fvy);
        this.stateUntil = now + rand(2200, 5000);
      } else {
        const h = this.pickHeading();
        this.setHeading(h.vx, h.vy);
        this.stateUntil = now + h.ms;
      }
    }

    enterTurning(now) {
      this.state = "TURNING";
      this.turnStart = now;
      this.stateUntil = now + TURN_MS;
    }

    wake(now) {
      this.say("!");
      this.enterIdle(now);
    }

    /** The ground just shook: yelp and bolt off in a fresh direction. */
    startle(now) {
      if (this.dragging) return;
      this.say(QUAKE_PHRASES[(Math.random() * QUAKE_PHRASES.length) | 0], QUAKE_SOUND_MS);
      this.enterWalking(now);
    }

    tickState(now, dtSec) {
      // While held, the pointer owns the pet's position — no autonomy.
      if (this.state === "DRAG") return;

      // 12 rad/s at normal pace; legs speed up with the pet during a quake.
      this.stride += dtSec * 12 * this.world.boost;

      const idleFor = now - this.world.lastActivity;

      switch (this.state) {
        case "IDLE":
          if (idleFor > INACTIVITY_SLEEP_MS) {
            this.state = "SLEEP";
            this.say(SLEEP_PHRASE, 4000);
          } else if (now > this.stateUntil || this.world.boost > 1) {
            // Nobody stands around during an earthquake.
            this.enterWalking(now);
          }
          break;

        case "WALKING":
          if (this.step(dtSec)) this.enterTurning(now);
          else if (now > this.stateUntil) this.enterIdle(now);
          break;

        case "TURNING":
          if (now > this.stateUntil) {
            // pvx/pvy null means "pick something new" (used after a drop).
            if (typeof this.pvx === "number") this.enterWalking(now, this.pvx, this.pvy);
            else this.enterWalking(now);
          }
          break;

        case "INTERACT":
          if (now > this.stateUntil) this.enterIdle(now);
          break;

        case "SLEEP":
          if (idleFor <= INACTIVITY_SLEEP_MS) this.wake(now);
          break;
      }
    }

    // -- animation / render -------------------------------------------------

    render(now) {
      this.el.style.transform =
        `translate(${this.x.toFixed(2)}px, ${(-this.yOffset).toFixed(2)}px)`;

      let by = 0; // vertical offset (px, negative = up)
      let rot = 0; // degrees, clockwise on screen
      let sx = 1; // scale x magnitude
      let sy = 1; // scale y magnitude

      // How ground-like the current heading is: 1 = pure walk, 0 = pure climb.
      // Inside the diorama every heading is a walk: moving up the screen means
      // stepping further back across the floor, not climbing, so the pet keeps
      // its footstep bob and never pitches nose-up.
      const onStage = this.world.bounds().onStage;
      const grounded = onStage ? 1 : Math.abs(this.vx);
      const airborne = 1 - grounded;

      if (this.state === "DRAG") {
        // Held up: lift slightly, dangle, and lean into the direction of travel.
        sx = 1.06;
        sy = 1.06;
        by = -4;
        rot = prefersReducedMotion ? 0 : clamp(this.dragLean * 0.6, -14, 14);
      } else if (!prefersReducedMotion) {
        if (this.state === "EVOLVE") {
          // Buzzing on the spot: the shiver widens and quickens as the light
          // builds, then the new form pops out of the flash and settles.
          const t = now - this.evolveStart;
          if (t < EVOLVE_CHARGE_MS) {
            const p = clamp(t / EVOLVE_CHARGE_MS, 0, 1);
            rot = Math.sin(t * (0.02 + p * 0.06)) * (1 + p * 6);
            sx = 1 - p * 0.05;
            sy = 1 + p * 0.07;
            by = -p * 5;
          } else {
            const q = clamp((t - EVOLVE_CHARGE_MS) / EVOLVE_BURST_MS, 0, 1);
            const pop = 1 - q; // eases the pop-out back to the resting size
            sx = 1 + pop * 0.14;
            sy = 1 + pop * 0.14;
            by = -pop * 7;
          }
        } else if (this.state === "WALKING") {
          // Footstep bob fades out as the heading turns vertical; a slower
          // hover sway fades in to replace it.
          const stride = this.stride;
          by = -Math.abs(Math.sin(stride)) * 5 * grounded;
          rot = Math.sin(stride) * 3 * grounded;
          by += Math.sin(now * 0.005) * 2.5 * airborne;
          // Nose up when climbing, down when diving. The sign follows `facing`
          // because the flip is applied *before* the rotation, so a positive
          // angle is always clockwise on screen. Steeper on a pure climb.
          if (!onStage) rot += -this.vy * (PITCH_DEG + airborne * 10) * this.facing;
        } else if (this.state === "TURNING") {
          const p = clamp((now - this.turnStart) / TURN_MS, 0, 1);
          const squash = Math.sin(p * Math.PI);
          sy = 1 - 0.22 * squash;
          sx = 1 + 0.14 * squash;
        } else if (this.state === "INTERACT") {
          const p = clamp((now - this.interactStart) / INTERACT_MS, 0, 1);
          by = -Math.abs(Math.sin(p * Math.PI * 2)) * 26;
          const land = p < 0.12 || (p > 0.5 && p < 0.62);
          sy = land ? 0.86 : 1;
          sx = land ? 1.1 : 1;
        } else if (this.state === "SLEEP") {
          const p = now * 0.0022;
          sy = 1 + Math.sin(p) * 0.04;
          by = Math.sin(p) * 1;
          // Drifting nap only makes sense in mid-air, not on the diorama floor.
          if (!onStage && this.yOffset > 4) by += Math.sin(now * 0.0016) * 3;
        } else {
          // IDLE: gentle breathing, plus a hover sway when off the floor.
          const p = now * 0.003;
          sy = 1 + Math.sin(p) * 0.03;
          by = Math.sin(p) * 1;
          if (!onStage && this.yOffset > 4) by += Math.sin(now * 0.004) * 3;
        }
      }

      const flip = this.char.faces === "left" ? -this.facing : this.facing;
      this.sprite.style.transform =
        `translateY(${by.toFixed(2)}px) rotate(${rot.toFixed(2)}deg) ` +
        `scale(${(flip * sx).toFixed(3)}, ${sy.toFixed(3)})`;

      this.renderShadow();
    }

    /** The ground shadow shrinks and fades as the pet gains altitude. On the
     *  stage there is no altitude — the pet is always on the floor — so it
     *  keeps a full shadow however far back it walks. */
    renderShadow() {
      const alt = this.world.bounds().onStage
        ? 0
        : clamp(this.yOffset / SHADOW_FADE_PX, 0, 1);
      const opacity = (1 - alt) * (this.dragging ? 0.4 : 1);
      const scale = 1 - alt * 0.45;
      const key = opacity.toFixed(2) + "|" + scale.toFixed(2);
      if (key === this.shadowKey) return;
      this.shadowKey = key;
      this.shadow.style.opacity = opacity.toFixed(2);
      this.shadow.style.transform = `translateX(-50%) scale(${scale.toFixed(2)})`;
    }

    say(text, ms = 1800) {
      this.bubble.textContent = text;
      this.bubble.classList.add("pkmn-show");
      clearTimeout(this.bubbleTimer);
      this.bubbleTimer = setTimeout(() => this.bubble.classList.remove("pkmn-show"), ms);
    }

    /** Re-clamp into the walkable area — after a resize, or after the stage
     *  appears or disappears and the floor changes shape under the pets. */
    clampToBounds() {
      this.yOffset = clamp(this.yOffset, this.minY, this.maxY);
      const { lo, hi } = this.xRangeAt(this.yOffset);
      this.feetX = clamp(this.feetX, lo, hi);
    }

    /** Config changed under us. */
    reconfigure(prev) {
      // Don't yank a pet out from under the pointer mid-drag.
      if (!this.dragging) {
        const stored = this.cfg.yOffsets[this.key];
        if (typeof stored === "number" && stored !== prev.yOffsets[this.key]) {
          this.yOffset = clamp(stored, this.minY, this.maxY);
        }
      }

      // Switching to ground mode grounds the heading (but not the pet — it
      // keeps walking along whatever line it's currently on).
      if (!this.freeRoam && this.vy !== 0) {
        this.setHeading(this.vx >= 0 ? 1 : -1, 0);
      }

      if (this.cfg.sound) Cries.load(this.char.cry);
      this.applySize();
    }

    /** Re-apply the zoomed box after the scale changes. */
    applySize() {
      const px = this.size + "px";
      if (this.el.style.width !== px) {
        this.el.style.width = px;
        this.el.style.height = px;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // World — the overlay, the clock and the window listeners, shared by every pet.
  // ---------------------------------------------------------------------------

  const World = {
    cfg: migrate({}),
    pets: [],
    root: null,
    mounted: false,
    stageOn: false,
    stageId: null, // which scene is currently up
    stageToken: 0, // guards async mounts against a newer toggle
    stageTimer: 0,
    petsHidden: false,
    destroyed: false, // set once superseded; a dead instance never comes back
    onStorageChanged: null,
    rafId: 0,
    lastTs: 0,
    lastActivity: 0,
    mountCheckAcc: 0,
    quakeStart: -Infinity,
    boost: 1, // pace multiplier, >1 only while a quake settles
    shaking: false, // whether the root currently carries a shake transform
    quakeAudio: null, // the rumble, while it is playing

    // -- lifecycle ----------------------------------------------------------

    mount() {
      if (this.mounted) return;
      if (!this.root) {
        this.root = document.createElement("div");
        this.root.id = "pkmn-pet-root";
      }
      (document.body || document.documentElement).appendChild(this.root);
      this.mounted = true;

      this.lastTs = performance.now();
      this.lastActivity = this.lastTs;

      addEventListener("resize", this.onResize, { passive: true });
      ACTIVITY_EVENTS.forEach((ev) =>
        addEventListener(ev, this.onActivity, { passive: true, capture: true })
      );
      document.addEventListener("visibilitychange", this.onVisibility);

      this.rafId = requestAnimationFrame(this.loop);
    },

    /** Permanent teardown, for when another copy of the engine takes over or
     *  our extension context dies. Distinct from unmount(), which is the
     *  reversible "Show pet is off" state and must stay responsive to config
     *  changes so it can come back. */
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      if (this.onStorageChanged) {
        try {
          chrome.storage.onChanged.removeListener(this.onStorageChanged);
        } catch (_) {
          // Context already invalidated — the listener is dead anyway.
        }
      }
      this.unmount();
    },

    unmount() {
      if (!this.mounted) return;
      this.mounted = false;
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;

      // Give the GPU context back rather than leaving it parked on a hidden node.
      clearTimeout(this.stageTimer);
      this.stageToken++;
      if (this.stageOn && window.PKMN_STAGE) window.PKMN_STAGE.unmount();
      this.stageOn = false;
      this.stageId = null;
      this.hidePets(false);

      this.stopQuakeSound();
      this.quakeStart = -Infinity;
      this.boost = 1;
      this.shaking = false;
      if (this.root) this.root.style.transform = "";

      removeEventListener("resize", this.onResize);
      ACTIVITY_EVENTS.forEach((ev) =>
        removeEventListener(ev, this.onActivity, { capture: true })
      );
      document.removeEventListener("visibilitychange", this.onVisibility);

      this.clearPets();
      if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    },

    clearPets() {
      this.pets.forEach((p) => p.destroy());
      this.pets = [];
    },

    // -- bounds -------------------------------------------------------------

    /** The walkable area, in sprite coordinates (x from the viewport's left
     *  edge, y up from its bottom), as a convex polygon.
     *
     *  With the scene off this is the viewport rectangle, and `fitSprite` keeps
     *  whole sprites on screen the way they always were. With the scene on it is
     *  the diorama's floor, projected — a quadrilateral that is narrower at the
     *  back, and whose shape changes as the scene is rotated, so a pet walking
     *  "up" is walking deeper into the room and can never leave it. */
    bounds() {
      if (this.stageOn && window.PKMN_STAGE) {
        const r = window.PKMN_STAGE.region();
        if (r) return { poly: r.poly, fitSprite: false, onStage: true };
      }
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      return {
        poly: [
          { x: 0, y: 0 },
          { x: vw, y: 0 },
          { x: vw, y: vh },
          { x: 0, y: vh },
        ],
        fitSprite: true,
        onStage: false,
      };
    },

    /** The floor changed shape — put everyone back inside it. */
    reclamp() {
      this.pets.forEach((p) => p.clampToBounds());
    },

    // -- stage --------------------------------------------------------------

    /** Bring the diorama up, swap it, or take it down.
     *
     *  Mounting is async — three.js is fetched on demand — so the pets keep
     *  roaming the open page until the floor actually exists, then get penned
     *  in. Two things guard the transitions, and both are load-bearing:
     *
     *  - `stageToken` invalidates callbacks from a superseded transition, so a
     *    slow load landing after a newer toggle cannot resurrect a dead scene.
     *  - `teardownStage()` finishes a pending exit *synchronously* before any
     *    new entrance. Without it, toggling off then on inside the 260ms exit
     *    animation left the stage blank forever: the entrance found the old
     *    scene still mounted, and the exit timer then removed the canvas the
     *    entrance had not replaced. */
    syncStage() {
      const Stage = window.PKMN_STAGE;
      const want = this.cfg.enabled && this.cfg.scene && !!Stage;
      const wantId = this.cfg.sceneId;

      if (this.cfg.scene && !Stage) {
        console.warn("[pkmn-pet] stage.js not loaded — scene unavailable");
      }

      if (!want) {
        if (this.stageOn) this.leaveStage();
        return;
      }

      // Nothing to do only if the scene we want is genuinely up or on its way.
      // Checking the Stage's own state as well as our flags matters: if those
      // two ever disagree, this is the branch that lets it heal instead of
      // latching a blank stage in place.
      const healthy =
        this.stageOn &&
        this.stageId === wantId &&
        (Stage.state === "ready" || Stage.state === "loading");
      if (healthy) return;

      if (this.stageOn && this.stageId !== wantId && Stage.state === "ready") {
        // A deliberate swap: let the old scene animate out, then bring the new
        // one in. enterStage's teardown makes the handover safe either way.
        this.leaveStage(() => this.enterStage(wantId));
        return;
      }

      this.enterStage(wantId);
    },

    /** Direct manipulation of the diorama: drag the corner grip to resize, drag
     *  the body to move. Both stream `committed: false` while the pointer is
     *  down so the change is visible immediately, and are written to storage
     *  only on release — a write per pointermove would hammer the store and
     *  every other tab listening to it. */
    bindStageGestures(Stage) {
      Stage.onScaleChange = (scale, committed) => {
        this.relayoutStage(() => {
          this.cfg.scale = scale;
          Stage.scale = scale;
        }, this.cfg.scale);
        if (committed) chrome.storage.local.set({ scale });
      };

      Stage.onMoveChange = (x, y, committed) => {
        // layout() clamps the offsets against the viewport.
        this.relayoutStage(() => {
          Stage.offsetX = x;
          Stage.offsetY = y;
        });
        this.cfg.stageX = Stage.offsetX;
        this.cfg.stageY = Stage.offsetY;
        if (committed) {
          chrome.storage.local.set({ stageX: Stage.offsetX, stageY: Stage.offsetY });
        }
      };

      Stage.onQuake = () => this.quake();
    },

    /** Re-lay-out the stage and carry the pets along with it.
     *
     *  Each pet's feet are expressed as a fraction of the canvas box before the
     *  change and put back at the same fraction after it. Moving and zooming
     *  both just translate/scale that box (the camera framing depends only on
     *  its aspect, which neither changes), so a pet standing by the counter is
     *  still standing by the counter — rather than being left behind on the
     *  page and shoved to whichever edge of the floor is nearest.
     *
     *  `prevScale` is the zoom the pets are currently laid out at: a pet's feet
     *  are derived from its size, so they must be read at the old one. */
    relayoutStage(change, prevScale = this.cfg.scale) {
      const Stage = window.PKMN_STAGE;
      const from = Stage.region() ? Stage.rect() : null;
      const feet = this.pets.map((p) => ({
        x: p.x + Math.round(p.char.size * prevScale) / 2,
        y: p.yOffset,
      }));

      if (change) change();
      Stage.layout();
      this.pets.forEach((p) => p.applySize());

      const to = Stage.region() ? Stage.rect() : null;
      if (from && to && from.width > 0 && from.height > 0) {
        this.pets.forEach((p, i) => {
          if (p.dragging) return; // the pointer owns that one
          const u = (feet[i].x - from.left) / from.width;
          const v = (from.vh - feet[i].y - from.top) / from.height;
          p.feetX = to.left + u * to.width;
          p.yOffset = to.vh - (to.top + v * to.height);
        });
      }
      this.reclamp();
      // Redraw now rather than on the next tick, so the pets never trail the
      // room by a frame while it is being dragged.
      const now = performance.now();
      this.pets.forEach((p) => p.render(now));
    },

    // -- earthquake ---------------------------------------------------------

    quake() {
      const now = performance.now();
      this.quakeStart = now;
      this.lastActivity = now;
      this.boost = QUAKE_SPEED;
      this.pets.forEach((p) => p.startle(now));
      // Called from pointerup, so this still counts as a user gesture.
      if (this.cfg.sound) this.quakeAudio = Cries.effect(QUAKE_SOUND);
    },

    /** Fade the rumble over its last QUAKE_FADE_MS and cut it at
     *  QUAKE_SOUND_MS, so it ends with the pets' yelps whatever the clip's
     *  length. */
    tickQuakeSound(now) {
      const a = this.quakeAudio;
      if (!a) return;
      const left = this.quakeStart + QUAKE_SOUND_MS - now;
      if (left <= 0) {
        this.stopQuakeSound();
        return;
      }
      a.volume = CRY_VOLUME * clamp(left / QUAKE_FADE_MS, 0, 1);
    },

    stopQuakeSound() {
      const a = this.quakeAudio;
      if (!a) return;
      this.quakeAudio = null;
      a.pause();
      a.volume = CRY_VOLUME;
    },

    /** Pace multiplier: holds near QUAKE_SPEED, then eases down to 1. */
    quakeBoost(now) {
      const t = (now - this.quakeStart) / QUAKE_MS;
      if (!(t >= 0 && t < 1)) return 1;
      const settled = t * t * (3 - 2 * t); // smoothstep
      return 1 + (QUAKE_SPEED - 1) * (1 - settled);
    },

    /** Shake the whole overlay — room, pets and controls move as one, like a
     *  camera shake. Done per frame rather than with CSS keyframes so the
     *  amplitude decays on the same clock as the pets' pace. Two sines per
     *  axis at unrelated frequencies read as jitter without a visible loop. */
    renderQuake(now) {
      const t = (now - this.quakeStart) / QUAKE_MS;
      if (!(t >= 0 && t < 1) || prefersReducedMotion) {
        if (this.shaking) {
          this.root.style.transform = "";
          this.shaking = false;
        }
        return;
      }
      const amp = QUAKE_SHAKE_PX * (1 - t) * (1 - t);
      const s = now / 1000;
      const x = (amp * (Math.sin(s * 71) + 0.5 * Math.sin(s * 113))) / 1.5;
      const y = (amp * 0.6 * (Math.sin(s * 89 + 1.3) + 0.5 * Math.sin(s * 131))) / 1.5;
      const r = amp * 0.05 * Math.sin(s * 53);
      this.root.style.transform =
        `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) rotate(${r.toFixed(3)}deg)`;
      this.shaking = true;
    },

    /** Cancel any pending exit animation and drop the canvas right now.
     *  Deliberately does not touch the token — callers own that. */
    teardownStage() {
      clearTimeout(this.stageTimer);
      this.stageTimer = 0;
      const Stage = window.PKMN_STAGE;
      if (Stage && Stage.state !== "off") Stage.unmount();
    },

    /** Play the exit animation, then actually tear the canvas down. */
    leaveStage(after) {
      const Stage = window.PKMN_STAGE;
      const token = ++this.stageToken;
      clearTimeout(this.stageTimer);
      this.stageOn = false;
      this.stageId = null;
      this.hidePets(true);
      if (Stage) Stage.hideControls();

      const finish = () => {
        if (token !== this.stageToken) return; // a newer transition owns us now
        this.teardownStage();
        this.reclamp();
        this.hidePets(false);
        if (after) after();
      };

      const canvas = Stage && Stage.canvas;
      if (!canvas || prefersReducedMotion) {
        finish();
        return;
      }
      canvas.classList.remove("pkmn-in");
      canvas.classList.add("pkmn-out");
      this.stageTimer = setTimeout(finish, STAGE_OUT_MS);
    },

    /** Load the scene, then fly it in and reveal the pets. */
    enterStage(sceneId) {
      const Stage = window.PKMN_STAGE;
      const token = ++this.stageToken;

      // Finish any exit that is still animating, so mount() starts from a
      // clean slate and no stale timer fires over the top of this entrance.
      this.teardownStage();

      this.stageOn = true;
      this.stageId = sceneId;
      Stage.scale = this.cfg.scale;
      Stage.offsetX = this.cfg.stageX;
      Stage.offsetY = this.cfg.stageY;
      this.bindStageGestures(Stage);
      this.hidePets(true);
      if (this.cfg.sound) Cries.load(QUAKE_SOUND); // prefetch so the first quake isn't late

      Stage.mount(this.root, sceneId, () => {
        if (token !== this.stageToken) return; // superseded while loading

        if (Stage.state === "failed") {
          this.stageOn = false;
          this.stageId = null;
          this.reclamp();
          this.hidePets(false);
          return;
        }

        // The floor exists now, so pen the pets in while they're still hidden —
        // that way they never visibly jump from the page into the room.
        this.raisePets();
        this.reclamp();

        if (prefersReducedMotion) {
          if (Stage.canvas) Stage.canvas.classList.add("pkmn-in");
          this.hidePets(false);
          return;
        }

        if (Stage.canvas) {
          Stage.canvas.classList.remove("pkmn-out");
          // Force a reflow so re-adding the class restarts the animation on a
          // rapid off/on, instead of the browser treating it as unchanged.
          void Stage.canvas.offsetWidth;
          Stage.canvas.classList.add("pkmn-in");
        }
        clearTimeout(this.stageTimer);
        this.stageTimer = setTimeout(() => {
          if (token === this.stageToken) this.hidePets(false);
        }, PETS_REVEAL_MS);
      });

      // mount() appends the canvas synchronously but only resolves once three.js
      // has downloaded. Raise the pets now, or for that whole window the canvas
      // sits on top of them in the DOM.
      this.raisePets();
    },

    /** Fade the pets out/in. Opacity only — their transform belongs to the
     *  animation loop and must not be handed to CSS. */
    hidePets(hidden) {
      this.petsHidden = hidden;
      this.pets.forEach((p) => p.el.classList.toggle("pkmn-hidden", hidden));
    },

    /** Keep the pets last in the overlay so they paint over the canvas. */
    raisePets() {
      this.pets.forEach((p) => this.root.appendChild(p.el));
    },

    // -- roster -------------------------------------------------------------

    /** Make the live pets match `cfg.characters`, keeping the ones that are
     *  already on screen exactly where they are — only the difference moves. */
    syncRoster() {
      const wanted = this.cfg.characters;

      // Remove pets that are no longer selected.
      this.pets = this.pets.filter((pet) => {
        if (wanted.includes(pet.key)) return true;
        pet.destroy();
        return false;
      });

      const missing = wanted.filter((k) => !this.pets.some((p) => p.key === k));
      if (!missing.length) return;

      // New arrivals are spread across the viewport rather than stacked. Slots
      // are numbered over the full roster so a pet added later doesn't land on
      // top of one that's already there.
      missing.forEach((key) => {
        const pet = new Pet(this, key);
        const slot = wanted.indexOf(key);
        pet.place(slot, wanted.length);
        if (this.petsHidden) pet.el.classList.add("pkmn-hidden");
        this.root.appendChild(pet.el);
        this.pets.push(pet);
      });

      // Keep DOM order stable and matching the registry, so overlapping pets
      // stack predictably instead of by whichever was checked last. Re-appending
      // also keeps every pet after the stage canvas and its grab pad.
      this.pets.sort((a, b) => CHARACTER_KEYS.indexOf(a.key) - CHARACTER_KEYS.indexOf(b.key));
      this.raisePets();
    },

    /** A pet just became its next form. The roster is a set of characters, so
     *  the evolution has to be written back to it — otherwise the very next
     *  config change would reconcile the pet straight back into its old self.
     *
     *  `cfg` is updated here as well as in storage, so when the write echoes
     *  back through applyConfig it is already a no-op and nothing is rebuilt:
     *  the pet keeps its position, its heading and its element. */
    onEvolved(pet, from, to) {
      // Evolving into a species already on screen would make two of it.
      const dupes = this.pets.filter((p) => p !== pet && p.key === to);
      dupes.forEach((p) => p.destroy());
      if (dupes.length) this.pets = this.pets.filter((p) => !dupes.includes(p));

      const characters = this.cfg.characters
        .map((k) => (k === from ? to : k))
        .filter((k, i, all) => all.indexOf(k) === i);
      // The new form stands where the old one did, under its own key.
      const yOffsets = { ...this.cfg.yOffsets, [to]: Math.round(pet.yOffset) };
      delete yOffsets[from];

      this.cfg.characters = characters;
      this.cfg.yOffsets = yOffsets;
      chrome.storage.local.set({ characters, yOffsets });

      // Registry order changed under us; keep the paint order matching it.
      // Only re-append when the order really moved — re-inserting an element
      // restarts its CSS animation, and this lands mid-flash.
      const was = this.pets.slice();
      this.pets.sort((a, b) => CHARACTER_KEYS.indexOf(a.key) - CHARACTER_KEYS.indexOf(b.key));
      if (this.pets.some((p, i) => p !== was[i])) this.raisePets();
    },

    // -- events -------------------------------------------------------------

    onResize: () => {
      // Re-project the floor first, carrying the pets with it.
      if (World.stageOn && window.PKMN_STAGE) World.relayoutStage();
      else World.reclamp();
    },

    onActivity: () => {
      World.lastActivity = performance.now();
    },

    onVisibility: () => {
      if (document.hidden) {
        cancelAnimationFrame(World.rafId);
        World.rafId = 0;
        // The fade runs off rAF, which just stopped — cut the rumble instead.
        World.stopQuakeSound();
      } else if (World.mounted && !World.rafId) {
        World.lastTs = performance.now();
        World.rafId = requestAnimationFrame(World.loop);
      }
    },

    ensureMounted(dtMs) {
      this.mountCheckAcc += dtMs;
      if (this.mountCheckAcc < 1000) return;
      this.mountCheckAcc = 0;

      // The extension was reloaded, updated or removed: every chrome.* call
      // from this copy now throws. Take ourselves down rather than lingering
      // as a zombie that animates but can never load a scene or hear a
      // settings change. background.js injects a live copy over the top.
      if (!chrome.runtime || !chrome.runtime.id) {
        this.destroy();
        return;
      }

      if (this.root && !this.root.isConnected) {
        (document.body || document.documentElement).appendChild(this.root);
      }
    },

    /** One rAF for every pet: the clock and the frame budget are shared, so
     *  adding a pet costs a transform write, not another animation loop. */
    loop: (now) => {
      const w = World;
      const dtMs = now - w.lastTs;
      const dtSec = Math.min(0.05, dtMs / 1000); // clamp: a stalled tab can't teleport

      // The scene draws first, under the sprites. It shares this loop rather
      // than starting its own, so it inherits the hidden-tab suspend below.
      // dtSec drives any animation clip the scene ships with.
      if (w.stageOn && window.PKMN_STAGE) window.PKMN_STAGE.render(dtSec);

      w.boost = w.quakeBoost(now);
      w.renderQuake(now);
      w.tickQuakeSound(now);

      for (const pet of w.pets) {
        pet.tickState(now, dtSec);
        pet.render(now);
      }

      w.ensureMounted(dtMs);
      w.lastTs = now;
      // ensureMounted() can unmount us mid-tick (an invalidated extension
      // context). Re-arming unconditionally would keep a torn-down World
      // ticking forever — and after a re-injection two of them would race,
      // each re-appending its own overlay.
      if (w.mounted) w.rafId = requestAnimationFrame(w.loop);
    },

    // -- config -------------------------------------------------------------

    applyConfig(raw) {
      // A superseded instance must stay dead. unmount() alone is not enough:
      // its storage listener is still registered, so the next settings change
      // would re-mount it and leave two overlays racing on the page.
      if (this.destroyed) return;

      const prev = this.cfg;
      this.cfg = migrate(raw);

      if (!this.cfg.enabled) {
        this.unmount();
        return;
      }

      // Reload: tear the whole overlay down — pets, stage and all — and drop
      // the root node too, so what follows rebuilds from nothing rather than
      // recycling the existing DOM. The escape hatch for a wedged state.
      if (this.cfg.reloadAt !== prev.reloadAt) {
        this.unmount();
        this.root = null;
      }

      this.mount();
      this.syncStage();
      this.syncRoster();
      this.pets.forEach((p) => p.reconfigure(prev));

      // Zooming moves the floor and the sprites at once, so the stage has to be
      // re-laid-out before the pets are re-penned into it.
      if (
        this.stageOn &&
        window.PKMN_STAGE &&
        (this.cfg.scale !== prev.scale ||
          this.cfg.stageX !== prev.stageX ||
          this.cfg.stageY !== prev.stageY)
      ) {
        const Stage = window.PKMN_STAGE;
        this.relayoutStage(() => {
          Stage.scale = this.cfg.scale;
          Stage.offsetX = this.cfg.stageX;
          Stage.offsetY = this.cfg.stageY;
        }, prev.scale);
      }
      this.reclamp();
    },
  };

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  // Let a future injection replace this instance cleanly.
  window.__pkmnPet = window.__pkmnPet || {};
  window.__pkmnPet.teardown = () => World.destroy();

  chrome.storage.local.get(DEFAULTS, (cfg) => {
    World.applyConfig(cfg);
  });

  // Kept on World so destroy() can unregister it — otherwise a superseded
  // instance keeps hearing config changes and mounts itself all over again.
  World.onStorageChanged = (changes, area) => {
    if (area !== "local") return;
    const merged = { ...World.cfg };
    for (const key of Object.keys(changes)) merged[key] = changes[key].newValue;
    World.applyConfig(merged);
  };
  chrome.storage.onChanged.addListener(World.onStorageChanged);
})();
