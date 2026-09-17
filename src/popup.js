/* Popup settings — reads/writes chrome.storage.local.
 * The content script reacts to storage changes live, so no messaging needed. */

/* The roster comes from the shared registry (characters.js), loaded just
 * before this file, so the popup can never list a Pokémon the engine doesn't
 * know about — or miss one it does. */
const CHARACTERS = window.PKMN_CHARACTERS;
const CHARACTER_KEYS = window.PKMN_CHARACTER_KEYS;
const SCENES = window.PKMN_SCENES;
const SCENE_KEYS = window.PKMN_SCENE_KEYS;

/* `characters` / `yOffsets` default to null so we can tell "never written"
 * from "deliberately empty" — unchecking every Pokémon has to stick. */
const DEFAULTS = {
  enabled: true,
  speed: 5,
  characters: null,
  movement: "free",
  sound: true,
  scene: false,
  sceneId: null,
  yOffsets: null,
  reloadAt: 0,
  scale: 1,
  // Legacy single-pet keys, read only so an older profile migrates cleanly.
  character: null,
  yOffset: null,
};

const enabledEl = document.getElementById("enabled");
const speedEl = document.getElementById("speed");
const speedValEl = document.getElementById("speedVal");
const scaleEl = document.getElementById("scale");
const scaleValEl = document.getElementById("scaleVal");
const soundEl = document.getElementById("sound");
const sceneEl = document.getElementById("scene");
const sceneIdEl = document.getElementById("sceneId");
const sceneRowEl = document.getElementById("sceneRow");
const reloadEl = document.getElementById("hardReload");

// Options come from the registry, so adding a scene needs no markup change.
for (const key of SCENE_KEYS) {
  const opt = document.createElement("option");
  opt.value = key;
  opt.textContent = SCENES[key].name;
  sceneIdEl.appendChild(opt);
}
const movementEl = document.getElementById("movement");
const rosterHintEl = document.getElementById("rosterHint");
const pickerEl = document.getElementById("picker");

/* Build a checkbox per registered character. Doing it here rather than in the
 * markup means adding a Pokémon to characters.js is enough to make it
 * selectable — no parallel edit to popup.html. */
const charEls = CHARACTER_KEYS.map((key) => {
  const label = document.createElement("label");
  label.className = "pick";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "char";
  input.value = key;

  const span = document.createElement("span");
  span.textContent = CHARACTERS[key].name;
  span.title = CHARACTERS[key].name;

  label.appendChild(input);
  label.appendChild(span);
  pickerEl.appendChild(label);
  return input;
});

/** Mirror of the content script's migration, so the popup shows the same
 * roster the engine is actually running. */
function roster(cfg) {
  if (!Array.isArray(cfg.characters)) {
    return [CHARACTER_KEYS.includes(cfg.character) ? cfg.character : CHARACTER_KEYS[0]];
  }
  return cfg.characters.filter((k, i) => CHARACTER_KEYS.includes(k) && cfg.characters.indexOf(k) === i);
}

function render(cfg) {
  const picked = roster(cfg);

  enabledEl.checked = !!cfg.enabled;
  soundEl.checked = !!cfg.sound;
  sceneEl.checked = !!cfg.scene;
  sceneIdEl.value = SCENES[cfg.sceneId] ? cfg.sceneId : SCENE_KEYS[0];
  // A one-option dropdown is just noise; it comes back on its own once a
  // second scene is registered in scenes.js.
  sceneRowEl.hidden = SCENE_KEYS.length < 2;
  speedEl.value = cfg.speed;
  speedValEl.textContent = cfg.speed;
  // Stored as a multiplier, shown as a percentage.
  const pct = Math.round((Number(cfg.scale) || 1) * 100);
  scaleEl.value = pct;
  scaleValEl.textContent = pct + "%";
  movementEl.value = cfg.movement;
  charEls.forEach((el) => (el.checked = picked.includes(el.value)));

  // Unchecking everything is allowed — say so rather than silently showing
  // nothing, since it looks identical to the pet being switched off.
  if (!picked.length) {
    rosterHintEl.textContent = "No Pokémon selected — nothing will show.";
  } else {
    rosterHintEl.textContent = `${picked.length} on screen`;
  }
}

function save(patch) {
  chrome.storage.local.set(patch);
}

chrome.storage.local.get(DEFAULTS, render);

enabledEl.addEventListener("change", () => save({ enabled: enabledEl.checked }));
soundEl.addEventListener("change", () => save({ sound: soundEl.checked }));
sceneEl.addEventListener("change", () => save({ scene: sceneEl.checked }));
sceneIdEl.addEventListener("change", () => save({ sceneId: sceneIdEl.value }));
movementEl.addEventListener("change", () => save({ movement: movementEl.value }));
speedEl.addEventListener("input", () => {
  speedValEl.textContent = speedEl.value;
  save({ speed: Number(speedEl.value) });
});
scaleEl.addEventListener("input", () => {
  scaleValEl.textContent = scaleEl.value + "%";
  save({ scale: Number(scaleEl.value) / 100 });
});

// A stamp rather than a flag: the engine reacts to the value *changing*, so
// consecutive reloads each fire even though nothing else differs.
reloadEl.addEventListener("click", () => {
  save({ reloadAt: Date.now() });
  reloadEl.disabled = true;
  reloadEl.textContent = "Reloading…";
  setTimeout(() => {
    reloadEl.disabled = false;
    reloadEl.textContent = "Reload";
  }, 900);
});

// Write the roster in registry order, so it doesn't depend on click order.
charEls.forEach((el) =>
  el.addEventListener("change", () => {
    const picked = charEls.filter((c) => c.checked).map((c) => c.value);
    save({ characters: CHARACTER_KEYS.filter((k) => picked.includes(k)) });
  })
);

// Keep the popup in sync when a pet is dragged, or another popup changes something.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  chrome.storage.local.get(DEFAULTS, render);
});
