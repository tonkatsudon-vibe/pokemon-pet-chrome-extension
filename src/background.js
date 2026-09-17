/* Service worker — only job is to make settings apply without a page refresh.
 *
 * Content scripts are injected at page load and nowhere else, so every tab that
 * was already open when the extension was installed, updated or reloaded has no
 * engine in it. Those tabs never see `chrome.storage.onChanged`, so toggling
 * anything in the popup appears to do nothing until you reload the page — which
 * during development is essentially every tab, every time.
 *
 * Injecting into the already-open tabs on install/update closes that gap. The
 * `window.__pkmnPetLoaded` guard in content.js makes a double-injection a no-op,
 * so this is safe to fire blindly.
 */

// Must match manifest.content_scripts, and stay in this order — characters.js
// and stage.js both publish globals that content.js reads at startup.
const JS_FILES = ["src/boot.js", "src/characters.js", "src/scenes.js", "src/stage.js", "src/content.js"];
const CSS_FILES = ["src/pet.css"];

async function injectIntoOpenTabs() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  } catch (err) {
    console.warn("[pkmn-pet] could not enumerate tabs:", err);
    return;
  }

  await Promise.all(
    tabs.map(async (tab) => {
      if (!tab.id) return;
      try {
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: CSS_FILES });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: JS_FILES });
      } catch (_) {
        // Expected on pages no extension may touch: chrome://, the Web Store,
        // other extensions' pages, the PDF viewer, and tabs still discarded.
      }
    })
  );
}

chrome.runtime.onInstalled.addListener(injectIntoOpenTabs);
