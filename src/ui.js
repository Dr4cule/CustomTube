/**
 * Floating personalizer assistant — a fixed launcher pinned to the viewport,
 * mounted in a Shadow DOM so YouTube's CSS can't leak in and ours can't leak out.
 *
 * Why floating and not spliced beside the mic: anchoring into YouTube's masthead
 * depends on its internal, frequently-changing DOM (#voice-search-button, #center …)
 * and its render timing. A viewport-fixed launcher only needs <body>, so it shows
 * reliably no matter how YouTube reflows its header. No frameworks.
 */
import { STATUS_LABELS } from "./constants.js";

const HOST_ID = "ytp-assistant-host";

const UI_CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: "Roboto","Arial",sans-serif; }
.wrap { position: relative; }
button { font: inherit; color: inherit; background: none; border: none; cursor: pointer; }
input { font: inherit; }

/* Explicit palettes keyed by [data-theme] so we stay legible even where YouTube's
   --yt-spec-* custom properties don't reach a <body>-level node. */
:host { --bg:#fff; --raised:#fff; --text:#0f0f0f; --text2:#606060; --border:rgba(0,0,0,.12); --hover:rgba(0,0,0,.05); --accent:#065fd4; }
:host([data-theme="dark"]) { --bg:#181818; --raised:#212121; --text:#f1f1f1; --text2:#aaa; --border:rgba(255,255,255,.15); --hover:rgba(255,255,255,.1); --accent:#3ea6ff; }

/* Sized and styled to read as one of YouTube's ~40px round header icon buttons
   (like the mic beside the search bar): text-colored glyph on the surface color,
   subtle border + shadow so it stays visible floating over thumbnails. */
.fab {
  position: relative; width: 40px; height: 40px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--raised); color: var(--text); border: 1px solid var(--border);
  box-shadow: 0 1px 6px rgba(0,0,0,.28);
  cursor: grab; touch-action: none; /* draggable launcher; touch-action lets pointer drag work on touch */
}
.fab:active { cursor: grabbing; }
.fab:hover { background: var(--hover); }
.fab svg { width: 24px; height: 24px; fill: currentColor; }
.badge {
  position: absolute; top: -2px; right: -2px; min-width: 18px; height: 18px; padding: 0 4px;
  border-radius: 9px; background: #cc0000; color: #fff; font-size: 11px; line-height: 18px;
  font-weight: 500; text-align: center; display: none;
}
.badge[data-show="1"] { display: block; }

.panel {
  position: absolute; bottom: 52px; right: 0;
  display: flex; flex-direction: column; align-items: stretch; gap: 10px;
  padding: 14px; border-radius: 12px; width: 320px;
  background: var(--raised); color: var(--text);
  box-shadow: 0 6px 32px rgba(0,0,0,.35); border: 1px solid var(--border);
}
.panel.collapsed { display: none; }
/* The panel opens up-and-left from the launcher by default; these flip it when the
   launcher is dragged near the top or left edge so it never opens off-screen. */
.panel.flip-down { top: 52px; bottom: auto; }
.panel.anchor-left { left: 0; right: auto; }
.title { font-size: 13px; font-weight: 500; color: var(--text2); }

.inputrow {
  display: flex; align-items: center; height: 40px; padding: 0 6px 0 12px;
  border: 1px solid var(--border); border-radius: 20px; background: var(--bg); min-width: 0;
}
.inputrow:focus-within { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.inputrow svg.search { width: 18px; height: 18px; margin-right: 8px; fill: var(--text2); flex: 0 0 auto; }
input.rule { flex: 1 1 auto; min-width: 0; border: none; outline: none; background: transparent; color: var(--text); font-size: 14px; }
input.rule::placeholder { color: var(--text2); }

.btn { display: inline-flex; align-items: center; justify-content: center; height: 32px; padding: 0 10px; border-radius: 16px; color: var(--text); font-size: 13px; white-space: nowrap; }
.btn:hover { background: var(--hover); }
.btn.icon { width: 32px; padding: 0; font-size: 18px; }
.apply { color: var(--accent); font-weight: 500; }

.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.toggle { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 8px; border-radius: 16px; color: var(--text2); font-size: 13px; }
.toggle[aria-checked="true"] { color: var(--text); }
.switch { width: 30px; height: 16px; border-radius: 8px; background: var(--border); position: relative; transition: background .15s; }
.toggle[aria-checked="true"] .switch { background: var(--accent); }
.knob { position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #fff; transition: left .15s; }
.toggle[aria-checked="true"] .knob { left: 16px; }

.status { display: inline-flex; align-items: center; gap: 6px; padding: 0 6px; height: 32px; font-size: 12px; color: var(--text2); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #909090; flex: 0 0 auto; }
.stext { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.chip { display: none; height: 28px; padding: 0 10px; border-radius: 14px; font-size: 12px; background: var(--hover); color: var(--text); }
.chip[data-show="1"] { display: inline-flex; align-items: center; }
.chip[aria-pressed="true"] { background: var(--accent); color: #fff; }

/* Why-hidden tray (feature #7): one row per hide-reason class, with a one-click
   "Show these" that loosens the policy for that whole class. */
.tray { display: flex; flex-direction: column; gap: 4px; margin-top: 2px; }
.tray.collapsed { display: none; }
.trayhead { font-size: 12px; color: var(--text2); }
.trayrow { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.trayrow .tlabel2 { font-size: 13px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trayrow .cnt { font-size: 12px; color: var(--text2); flex: 0 0 auto; }
.trayrow .fix { color: var(--accent); font-size: 12px; font-weight: 500; height: 26px; padding: 0 8px; border-radius: 13px; flex: 0 0 auto; }
.trayrow .fix:hover { background: var(--hover); }

@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

const SEARCH_ICON = `<svg class="search" viewBox="0 0 24 24"><path d="M20.87 20.17l-5.59-5.59A6.5 6.5 0 1 0 14.17 15.28l5.59 5.59.71-.7zM10.5 16a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11z"/></svg>`;
const TUNE_ICON = `<svg viewBox="0 0 24 24"><path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/></svg>`;

const PANEL_HTML = `
<div class="wrap">
  <button class="fab" aria-label="Personalize your feed" aria-haspopup="dialog" aria-expanded="false">
    ${TUNE_ICON}<span class="badge" data-show="0"></span>
  </button>
  <div class="panel collapsed" role="dialog" aria-label="Personalize your feed">
    <span class="title">Personalize your feed</span>
    <label class="inputrow">
      ${SEARCH_ICON}
      <input class="rule" type="text" placeholder="e.g. show CS, hide music &amp; gaming" aria-label="Personalization rule"
             autocomplete="off" spellcheck="false" enterkeyhint="done">
      <button class="btn apply" title="Apply">Apply</button>
      <button class="btn icon clear" title="Clear personalization" aria-label="Clear personalization">×</button>
    </label>
    <div class="row">
      <button class="toggle" role="switch" aria-checked="true" title="Turn personalization on/off">
        <span class="switch"><span class="knob"></span></span><span class="tlabel">On</span>
      </button>
      <button class="chip" aria-pressed="false" title="Temporarily show hidden videos"></button>
    </div>
    <div class="tray collapsed" aria-label="Why videos are hidden"></div>
    <button class="status" type="button" aria-live="polite">
      <span class="dot"></span><span class="stext">Active</span>
    </button>
  </div>
</div>`;
export class AssistantControl {
  /** @param {{getState:Function, apply:Function, clear:Function, setEnabled:Function, toggleShowAll:Function}} api */
  constructor(api) {
    this.api = api;
    this.host = null;
    this.shadow = null;
    this.els = {};
    this.removalObserver = null;
    this._drag = null;          // active pointer-drag state, or null
    this._suppressClick = false; // true right after a drag, so the synthetic click doesn't toggle the panel
  }

  _theme() {
    // YouTube marks dark mode with a `dark` attribute on <html>.
    return document.documentElement.hasAttribute("dark") ? "dark" : "light";
  }

  /** Ensure the host is parented to <body> (fixed positioning) and themed. */
  _attach() {
    const parent = document.body || document.documentElement;
    if (!parent) return false;
    if (this.host.parentNode !== parent) parent.appendChild(this.host);
    this.host.setAttribute("data-theme", this._theme());
    return true;
  }

  mount() {
    if (document.getElementById(HOST_ID)) return true; // idempotent
    if (!(document.body || document.documentElement)) return false;

    this.host = document.createElement("div");
    this.host.id = HOST_ID;
    // Fixed launcher, bottom-right, above YouTube content. Very high z-index so
    // shelves/the player don't bury it; still below native browser chrome.
    this.host.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:2147483000;";
    this.shadow = this.host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = UI_CSS;
    this.shadow.appendChild(style);
    // Content-script isolated worlds are exempt from the page's Trusted Types,
    // so innerHTML on this static, trusted constant is fine even on YouTube.
    const tpl = document.createElement("template");
    tpl.innerHTML = PANEL_HTML;
    this.shadow.appendChild(tpl.content.cloneNode(true));

    this._cacheEls();
    this._wire();
    this._attach();
    this._applyStoredPos();
    this._observeRemoval();
    this.update();
    return true;
  }

  _cacheEls() {
    const q = (s) => this.shadow.querySelector(s);
    this.els = {
      wrap: q(".wrap"),
      fab: q(".fab"),
      badge: q(".badge"),
      panel: q(".panel"),
      input: q("input.rule"),
      apply: q(".apply"),
      clear: q(".clear"),
      toggle: q(".toggle"),
      tlabel: q(".tlabel"),
      status: q(".status"),
      dot: q(".dot"),
      stext: q(".stext"),
      chip: q(".chip"),
      tray: q(".tray"),
    };
  }

  _observeRemoval() {
    // If YouTube's SPA wipes <body> children on a hard nav, re-attach. We act
    // only when our host actually vanishes — no work on ordinary mutations.
    if (this.removalObserver) this.removalObserver.disconnect();
    this.removalObserver = new MutationObserver(() => {
      if (!document.getElementById(HOST_ID)) this._attach();
    });
    this.removalObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
  _wire() {
    const { input, apply, clear, toggle, chip, status, fab, panel } = this.els;

    // Keep YouTube's single-key player shortcuts (k/f/m/arrows) from firing while
    // the user types. Stop all three keyboard phases inside the input.
    for (const type of ["keydown", "keypress", "keyup"]) {
      input.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type === "keydown" && e.key === "Enter") {
          e.preventDefault();
          this._apply();
        } else if (type === "keydown" && e.key === "Escape") {
          this._close();
          input.blur();
        }
      });
    }

    apply.addEventListener("click", () => this._apply());
    clear.addEventListener("click", () => {
      input.value = "";
      this.api.clear();
    });
    toggle.addEventListener("click", () => {
      this.api.setEnabled(toggle.getAttribute("aria-checked") !== "true");
    });
    chip.addEventListener("click", () => this.api.toggleShowAll());
    status.addEventListener("click", () => this._close());

    fab.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this._suppressClick) { this._suppressClick = false; return; } // just finished a drag
      if (panel.classList.contains("collapsed")) this._open();
      else this._close();
    });
    // Drag the launcher anywhere. Pointer capture keeps move/up flowing to the fab
    // even when the pointer leaves it; a sub-threshold press stays a plain click.
    fab.addEventListener("pointerdown", (e) => this._onPointerDown(e));
    fab.addEventListener("pointermove", (e) => this._onPointerMove(e));
    fab.addEventListener("pointerup", (e) => this._onPointerUp(e));
    // Keep the launcher on-screen if the window shrinks under a dragged position.
    window.addEventListener("resize", () => {
      if (this.host && this.host.style.left) this._setHostPos(parseFloat(this.host.style.left), parseFloat(this.host.style.top));
    });
    // Click anywhere outside the launcher closes the panel (shadow retargets
    // inside-clicks to the host, so contains() keeps the panel open for them).
    document.addEventListener("click", (e) => {
      if (!panel.classList.contains("collapsed") && this.host && !this.host.contains(e.target)) this._close();
    });
  }

  // ---- Dragging ----
  _onPointerDown(e) {
    if (e.button > 0) return; // primary button / touch only
    const r = this.host.getBoundingClientRect();
    this._drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, startX: e.clientX, startY: e.clientY, moved: false };
    try { this.els.fab.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
  }

  _onPointerMove(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    if (!d.moved && Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) < 5) return; // below threshold: still a click
    d.moved = true;
    this._setHostPos(e.clientX - d.dx, e.clientY - d.dy);
  }

  _onPointerUp(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    this._drag = null;
    try { this.els.fab.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (!d.moved) return;
    this._suppressClick = true; // the click this pointerup synthesizes must not toggle the panel
    const r = this.host.getBoundingClientRect();
    if (this.api.setPos) this.api.setPos({ left: Math.round(r.left), top: Math.round(r.top) });
  }

  /** Set the fixed host to an absolute top-left, clamped to the viewport. */
  _setHostPos(left, top) {
    const size = 40;
    const l = Math.min(Math.max(0, window.innerWidth - size), Math.max(0, left));
    const t = Math.min(Math.max(0, window.innerHeight - size), Math.max(0, top));
    this.host.style.left = l + "px";
    this.host.style.top = t + "px";
    this.host.style.right = "auto";
    this.host.style.bottom = "auto";
  }

  _applyStoredPos() {
    const pos = this.api.getPos && this.api.getPos();
    if (pos && typeof pos.left === "number" && typeof pos.top === "number") this._setHostPos(pos.left, pos.top);
  }

  _open() {
    // Flip the panel's anchor so it never opens off-screen from a dragged launcher.
    const r = this.els.fab.getBoundingClientRect();
    this.els.panel.classList.toggle("flip-down", r.top < window.innerHeight / 2);
    this.els.panel.classList.toggle("anchor-left", r.left < window.innerWidth / 2);
    this.els.panel.classList.remove("collapsed");
    this.els.fab.setAttribute("aria-expanded", "true");
    this.els.input.focus();
  }

  _close() {
    this.els.panel.classList.add("collapsed");
    this.els.fab.setAttribute("aria-expanded", "false");
  }

  _apply() {
    const text = this.els.input.value.trim();
    if (text) this.api.apply(text);
  }

  /** Reflect the current app state. Never uses innerHTML with dynamic data. */
  update() {
    const st = this.api.getState();
    if (!this.els.input) return;
    if (this.host) this.host.setAttribute("data-theme", this._theme());
    if (document.activeElement !== this.host) this.els.input.value = st.ruleText || "";

    const checked = !!st.enabled;
    this.els.toggle.setAttribute("aria-checked", String(checked));
    this.els.tlabel.textContent = checked ? "On" : "Off";

    const meta = STATUS_LABELS[st.statusKey] || STATUS_LABELS.paused;
    this.els.dot.style.background = meta.dot;
    this.els.stext.textContent = meta.text;

    const tip = [st.summary, ...(st.notes || [])].filter(Boolean).join(" • ");
    this.els.status.title = tip || meta.text;

    const n = st.hiddenCount || 0;
    this.els.badge.setAttribute("data-show", n > 0 && checked ? "1" : "0");
    this.els.badge.textContent = n > 99 ? "99+" : String(n);
    this.els.chip.setAttribute("data-show", n > 0 ? "1" : "0");
    this.els.chip.setAttribute("aria-pressed", String(!!st.showAll));
    this.els.chip.textContent = st.showAll ? `Showing all (${n})` : `${n} hidden`;

    // Why-hidden tray: shown only while cards are actually hidden (feature #7).
    this._renderTray(st.breakdown || [], n > 0 && checked && !st.showAll);
  }

  /** Rebuild the why-hidden tray from a breakdown list. createElement/textContent only. */
  _renderTray(items, show) {
    const tray = this.els.tray;
    if (!tray) return;
    const visible = show && items.length > 0;
    tray.classList.toggle("collapsed", !visible);
    if (!visible) {
      tray.replaceChildren();
      return;
    }
    const head = document.createElement("span");
    head.className = "trayhead";
    head.textContent = "Hidden by";
    const nodes = [head];
    for (const it of items) {
      const row = document.createElement("div");
      row.className = "trayrow";
      const label = document.createElement("span");
      label.className = "tlabel2";
      label.textContent = `${it.label} (${it.count})`;
      row.appendChild(label);
      if (it.repairable) {
        const btn = document.createElement("button");
        btn.className = "btn fix";
        btn.type = "button";
        btn.textContent = "Show these";
        btn.title = `Stop hiding: ${it.label}`;
        btn.addEventListener("click", () => this.api.repair && this.api.repair(it.cls));
        row.appendChild(btn);
      } else {
        const cnt = document.createElement("span");
        cnt.className = "cnt";
        cnt.textContent = "edit rule";
        row.appendChild(cnt);
      }
      nodes.push(row);
    }
    tray.replaceChildren(...nodes);
  }

  destroy() {
    if (this.removalObserver) this.removalObserver.disconnect();
    if (this.host && this.host.parentNode) this.host.parentNode.removeChild(this.host);
    this.host = null;
  }
}



