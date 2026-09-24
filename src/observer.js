/**
 * YouTube DOM engine: one MutationObserver, time-boxed rAF flush, element-recycling
 * and late-hydration handling, SPA navigation, and selector-health detection.
 * No polling: no setInterval / recursive setTimeout. One-shot debounce timers only.
 */
import { SURFACES, FLUSH_TIME_BUDGET_MS } from "./constants.js";
import { extractVideoMetadata, cardSignature } from "./metadata.js";
import { applyVisibility, setPending, restoreVideo, hideShortsShelves } from "./apply.js";
import { reasonClass } from "./baseline.js";

const STABLE_ROOTS = ["ytd-page-manager", "ytd-app"];

// Real video links YouTube renders inside every card, used for the
// content-anchored discovery fallback and the selector-health signal.
const WATCH_LINK_SEL = "a[href*='/watch'],a[href*='/shorts/']";

/**
 * Climb from a node to the nearest enclosing YouTube "card" custom element.
 * YouTube's naming convention (`*-renderer`, `*lockup*`, `*view-model*`) is far
 * more stable than any exact tag, so this keeps filtering working even when a
 * specific renderer tag is renamed. Grid/shelf/section containers are excluded
 * so the fallback can never hide a whole feed.
 */
function cardAncestor(node, root) {
  let el = node;
  for (let i = 0; i < 8 && el && el !== root; i++) {
    const tag = el.tagName ? el.tagName.toLowerCase() : "";
    const cardLike = /renderer$/.test(tag) || tag.includes("lockup") || tag.includes("view-model");
    if (cardLike && !/grid|shelf|section|list|page|app|masthead|header/.test(tag)) return el;
    el = el.parentElement;
  }
  return null;
}

export function resolveSurface(location) {
  let url;
  try {
    url = new URL(location.href);
  } catch {
    return null;
  }
  for (const surface of Object.values(SURFACES)) {
    if (surface.match(url)) return surface;
  }
  return null;
}

export class YouTubeObserver {
  /**
   * @param {{
   *   doc: Document,
   *   classifier: import('./classify.js').Classifier,
   *   isSurfaceEnabled: (surfaceId:string)=>boolean,
   *   isEnabled: ()=>boolean,
   *   getRuleVersion: ()=>string,
   *   getPolicy: ()=>object,
   *   onHealth: (state:string)=>void,
   *   isContextValid: ()=>boolean,
   *   onContextInvalidated: ()=>void,
   * }} ctx
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.doc = ctx.doc;
    this.processed = new WeakMap();
    this.queue = new Set();
    this.observer = null;
    this.root = null;
    this.rafHandle = 0;
    this.surface = null;
    this.matchedCards = 0;
    this.mutationsSeen = 0;
    this.healthTimer = 0;
    this._onMutations = this._onMutations.bind(this);
    this._flush = this._flush.bind(this);
  }

  start() {
    this._onNavigate();
    this.doc.addEventListener("yt-navigate-finish", () => this._onNavigate(), true);
    this.doc.addEventListener("yt-page-data-updated", () => this._onNavigate(), true);
  }

  teardown() {
    if (this.observer) this.observer.disconnect();
    this.observer = null;
    this.root = null;
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.queue.clear();
  }

  _findRoot() {
    for (const sel of STABLE_ROOTS) {
      const el = this.doc.querySelector(sel);
      if (el) return el;
    }
    return this.doc.body;
  }

  _attachIfNeeded() {
    const root = this._findRoot();
    if (this.observer && this.root === root && root.isConnected) return;
    if (this.observer) this.observer.disconnect();
    this.root = root;
    this.observer = new MutationObserver(this._onMutations);
    this.observer.observe(root, { childList: true, subtree: true });
  }

  _guard() {
    if (!this.ctx.isContextValid()) {
      this.teardown();
      this.ctx.onContextInvalidated();
      return false;
    }
    return true;
  }

  _onNavigate() {
    if (!this._guard()) return;
    this.surface = resolveSurface(this.doc.location);
    this._attachIfNeeded();
    this.matchedCards = 0;
    this.mutationsSeen = 0;
    // Targeted initial pass over cards already present.
    if (this._surfaceActive()) {
      this._discover(this.root).forEach((card) => this._processCard(card));
      hideShortsShelves(this.root, this.surface, !!this.ctx.getPolicy()?.structural?.hideShorts);
    }
    // One-shot selector-health check (spec §6): a debounce timer is allowed.
    if (this.healthTimer) clearTimeout(this.healthTimer);
    if (this._surfaceActive()) {
      this.healthTimer = setTimeout(() => {
        if (!this._surfaceActive()) return;
        // Genuine selector drift only: YouTube rendered video links, yet neither
        // our selectors NOR the content-anchored fallback found any card. Late
        // hydration (cards present, titles pending) is NOT drift, so it can't
        // latch us inert while a slow feed finishes rendering.
        const cardsFound = this._discover(this.root).size;
        const watchLinks = this.root.querySelectorAll(WATCH_LINK_SEL).length;
        if (cardsFound === 0 && watchLinks > 3) this.ctx.onHealth("selectors");
      }, 1500);
    }
  }

  _surfaceActive() {
    return !!(this.surface && this.ctx.isEnabled() && this.ctx.isSurfaceEnabled(this.surface.id) && this.root);
  }

  /**
   * Find card elements within `scope`: configured selectors first, then a
   * content-anchored fallback (climb from real video links) so a renamed
   * renderer tag still gets filtered instead of silently slipping through.
   * @returns {Set<Element>}
   */
  _discover(scope) {
    const sel = this.surface.cardSelectors.join(",");
    const found = new Set();
    if (scope.matches && scope.matches(sel)) found.add(scope);
    if (scope.querySelectorAll) scope.querySelectorAll(sel).forEach((c) => found.add(c));
    if (found.size === 0) {
      const links = scope.querySelectorAll ? scope.querySelectorAll(WATCH_LINK_SEL) : [];
      links.forEach((a) => {
        const card = cardAncestor(a, this.root);
        if (card && this.root.contains(card)) found.add(card);
      });
    }
    return found;
  }

  /** Re-process every card currently in the root (used after a rule/enable change). */
  rescan() {
    if (!this._guard()) return;
    if (!this._surfaceActive()) return;
    this._discover(this.root).forEach((card) => this._processCard(card));
    hideShortsShelves(this.root, this.surface, !!this.ctx.getPolicy()?.structural?.hideShorts);
  }

  _onMutations(records) {
    if (!this._guard()) return;
    this.mutationsSeen += records.length;
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (node.nodeType === 1) this.queue.add(node);
      }
      // Late hydration: content filled inside an existing card. Re-enqueue that card.
      if (rec.type === "childList" && rec.target && rec.target.nodeType === 1 && this.surface) {
        const sel = this.surface.cardSelectors.join(",");
        const card = (rec.target.closest && rec.target.closest(sel)) || cardAncestor(rec.target, this.root);
        if (card) this.queue.add(card);
      }
    }
    this._scheduleFlush();
  }

  _scheduleFlush() {
    if (this.rafHandle) return;
    this.rafHandle = requestAnimationFrame(this._flush);
  }

  _flush() {
    this.rafHandle = 0;
    if (!this._guard()) return;
    if (!this._surfaceActive()) {
      this.queue.clear();
      return;
    }
    const shelfSel = (this.surface.shortsShelfSelectors || []).join(",");
    const deadline = Date.now() + FLUSH_TIME_BUDGET_MS;
    const it = this.queue.values();
    for (let cur = it.next(); !cur.done; cur = it.next()) {
      const node = cur.value;
      this.queue.delete(node);
      if (!node.isConnected) continue;
      if (shelfSel && this.ctx.getPolicy()?.structural?.hideShorts && node.matches && node.matches(shelfSel)) {
        node.setAttribute("data-ytp", "hidden");
      }
      this._discover(node).forEach((c) => this._processCard(c));
      if (Date.now() > deadline) break; // yield; remaining nodes flush next frame
    }
    if (this.queue.size > 0) this._scheduleFlush();
  }

  _processCard(card) {
    if (!this._surfaceActive()) return;
    const ruleVersion = this.ctx.getRuleVersion();
    const signature = cardSignature(card);
    const prev = this.processed.get(card);

    if (prev && prev.ruleVersion === ruleVersion && prev.signature === signature) return; // done

    // Element recycling: same element, different video → restore and re-evaluate.
    if (prev && prev.signature !== signature) restoreVideo(card);

    const meta = extractVideoMetadata(card);
    if (!meta) return; // skeleton / not hydrated — do NOT mark processed; retry on next mutation

    this.processed.set(card, { videoId: meta.id, ruleVersion, signature });
    this.matchedCards++;
    setPending(card);

    this.ctx.classifier.checkSemanticMatch(meta).then((decision) => {
      // Stale guard: ignore if the rule changed or the element got recycled meanwhile.
      const now = this.processed.get(card);
      if (!now || now.ruleVersion !== ruleVersion || now.signature !== cardSignature(card)) return;
      applyVisibility(card, decision.allow, decision.allow ? null : reasonClass(decision.reason));
    });
  }
}

