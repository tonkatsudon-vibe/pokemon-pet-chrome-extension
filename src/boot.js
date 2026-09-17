/* Pokémon Browser Pet — takeover handshake. Runs before everything else.
 *
 * Reloading the extension leaves every already-open tab with a content script
 * whose extension context is INVALIDATED: `chrome.runtime.id` is undefined and
 * `chrome.runtime.getURL()` throws. The pets carry on animating — once running
 * they are just DOM and rAF, needing no chrome.* calls — so the tab looks fine
 * while actually being dead. The 3D scene is where it shows, because mounting
 * it needs getURL() and a dynamic import(), which both throw.
 *
 * background.js re-injects a working copy into those tabs, but each module
 * guarded itself with "if I'm already defined, do nothing". That is right for a
 * genuine double-injection and exactly wrong here: the fresh, working copy bowed
 * out and left the dead one in charge, so the scene only ever appeared after a
 * manual page refresh.
 *
 * This file resolves that. It tears the previous instance down and clears the
 * shared globals, so the modules loaded after it define fresh copies instead of
 * short-circuiting. It must stay FIRST in the manifest's content_scripts list
 * and in background.js's JS_FILES: the teardown has to run while the old
 * PKMN_STAGE is still reachable, or its canvas is orphaned in the page.
 */

(() => {
  "use strict";
  if (window.top !== window) return;

  const prev = window.__pkmnPet;
  if (prev && typeof prev.teardown === "function") {
    try {
      prev.teardown();
    } catch (_) {
      // A teardown that throws must not stop the new copy from starting.
    }
  }

  for (const key of [
    "PKMN_CHARACTERS",
    "PKMN_CHARACTER_KEYS",
    "PKMN_SCENES",
    "PKMN_SCENE_KEYS",
    "PKMN_STAGE",
  ]) {
    try {
      delete window[key];
    } catch (_) {
      window[key] = undefined;
    }
  }

  // content.js fills in `teardown` once its engine exists.
  window.__pkmnPet = { teardown: null };
})();
