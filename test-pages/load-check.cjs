/**
 * End-to-end load check (run: `npm run test:load`). Loads the REAL unpacked
 * extension into Chromium and hits a page that
 * (a) matches https://www.youtube.com/*  so the manifest content script injects,
 * (b) carries a YouTube-like CSP incl. require-trusted-types-for 'script'.
 * Asserts the floating #ytp-assistant-host launcher mounts on <body> and its
 * .fab is visible. Exercises the real content.js -> dynamic import(src/main.js)
 * -> mount() path that the fixture harness (which imports the modules directly)
 * cannot reach. Headed: it opens a short-lived Chromium window because
 * extensions don't load in old headless.
 */
const path = require("path");
const os = require("os");
const fs = require("fs");
const { chromium } = require("playwright");

const EXT = path.resolve(__dirname, "..");

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>yt-like</title></head>
<body>
  <ytd-app>
    <ytd-masthead>
      <div id="container">
        <div id="start">= YouTube</div>
        <div id="center">
          <yt-searchbox><input placeholder="Search"></yt-searchbox>
          <yt-icon-button id="search-button-narrow"></yt-icon-button>
          <div id="voice-search-button">mic</div>
          <div id="ai-companion-button">ai</div>
        </div>
        <div id="end"><div id="buttons"></div></div>
      </div>
    </ytd-masthead>
    <ytd-page-manager><div id="contents"></div></ytd-page-manager>
  </ytd-app>
</body></html>`;

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytp-repro-"));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false, // extensions only load in headed / new-headless
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
    ],
  });

  // Confirm the extension actually loaded (its MV3 service worker registers).
  let sw = ctx.serviceWorkers()[0];
  if (!sw) {
    try {
      sw = await ctx.waitForEvent("serviceworker", { timeout: 5000 });
    } catch {
      /* none */
    }
  }
  console.log("EXTENSION SW:", sw ? sw.url() : "(NOT LOADED)");

  const logs = [];
  const page = await ctx.newPage();
  page.on("console", (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

  // Serve our own HTML for youtube.com with a YouTube-like CSP.
  await page.route("https://www.youtube.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      headers: {
        "content-security-policy":
          "require-trusted-types-for 'script'; script-src 'self' 'unsafe-inline' https://www.youtube.com; object-src 'none'",
      },
      body: PAGE_HTML,
    })
  );

  await page.goto("https://www.youtube.com/watch?v=repro", { waitUntil: "load" });

  // Give the content script + dynamic import + mount time to run.
  await page.waitForTimeout(2500);

  const probe = await page.evaluate(() => {
    const host = document.getElementById("ytp-assistant-host");
    let hostRect = null,
      fabVisible = null,
      hostParent = null,
      position = null;
    if (host) {
      position = getComputedStyle(host).position;
      hostParent = host.parentElement ? host.parentElement.id || host.parentElement.tagName : null;
      const fab = host.shadowRoot && host.shadowRoot.querySelector(".fab");
      if (fab) {
        const r = fab.getBoundingClientRect();
        hostRect = { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
        fabVisible = getComputedStyle(fab).display !== "none" && r.width > 0 && r.height > 0;
      }
    }
    return {
      hostExists: !!host,
      position,
      hostRect,
      hostParent,
      fabVisible,
    };
  });

  console.log("PROBE:", JSON.stringify(probe, null, 2));
  console.log("---- page logs ----");
  console.log(logs.length ? logs.join("\n") : "(none)");

  await ctx.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });

  // Regression guard: the launcher must actually mount and be visible under a
  // real extension load + YouTube-like CSP. This is the ONLY check that would
  // have caught storage.local.setAccessLevel("TRUSTED_CONTEXTS") locking the
  // content script out and aborting init() before mount().
  const ok = probe.hostExists && probe.fabVisible && probe.position === "fixed" && probe.hostParent === "BODY";
  console.log(ok ? "\nPASS: floating launcher mounted and visible" : "\nFAIL: launcher did not mount");
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("REPRO ERROR:", e);
  process.exit(1);
});
