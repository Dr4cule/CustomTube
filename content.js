/**
 * Thin content-script loader. Dynamic-imports the ES module entry so the same
 * modules run in-page AND import cleanly in Node unit tests, with no build step
 * (spec §11). Requires web_accessible_resources for src/*.js restricted to YouTube.
 */
(async () => {
  try {
    const url = chrome.runtime.getURL("src/main.js");
    await import(url);
  } catch (e) {
    // Extension reloaded/updated between injection and import → nothing to do.
    if (!/context invalidated|Extension context/.test(String(e))) {
      console.debug("[YT Personalizer] loader error:", e);
    }
  }
})();
