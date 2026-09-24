/**
 * Apply/restore visibility via attributes only (never inline styles, never node
 * removal). styles.css turns [data-ytp="hidden"] into display:none. Restore = remove attr.
 */
import { ATTR, WHY_ATTR } from "./constants.js";

/**
 * @param {Element} el
 * @param {boolean} allow  true → visible (restore); false → hidden.
 * @param {string} [why]   hide-reason class (feature #7), recorded on hidden cards.
 */
export function applyVisibility(el, allow, why) {
  if (!el || !el.setAttribute) return;
  if (allow) {
    el.removeAttribute(ATTR);
    el.removeAttribute(WHY_ATTR);
  } else {
    el.setAttribute(ATTR, "hidden");
    if (why) el.setAttribute(WHY_ATTR, why);
    else el.removeAttribute(WHY_ATTR);
  }
}

/** Mark a card as pending decision. pendingStyle handled by a root attr + CSS. */
export function setPending(el) {
  if (el && el.setAttribute && el.getAttribute(ATTR) !== "hidden") {
    el.setAttribute(ATTR, "pending");
  }
}

/** Restore a single card. */
export function restoreVideo(el) {
  if (el && el.removeAttribute) {
    el.removeAttribute(ATTR);
    el.removeAttribute(WHY_ATTR);
  }
}

/** Set the document-level pending style ("show" | "dim"). */
export function setPendingStyle(doc, style) {
  const root = doc.documentElement;
  if (root) root.setAttribute("data-ytp-pending", style === "show" ? "show" : "dim");
}

/** Global "Show all" switch — reveals hidden cards without re-classifying. */
export function setReveal(doc, on) {
  const root = doc.documentElement;
  if (!root) return;
  if (on) root.setAttribute("data-ytp-reveal", "");
  else root.removeAttribute("data-ytp-reveal");
}

/**
 * Structurally hide (or restore) the enclosing Shorts shelf sections.
 * `on` false restores shelves we previously hid — so flipping the rule off
 * un-hides them on the next rescan instead of leaving them stuck hidden.
 */
export function hideShortsShelves(root, surface, on = true) {
  if (!root || !surface || !surface.shortsShelfSelectors) return;
  for (const sel of surface.shortsShelfSelectors) {
    root.querySelectorAll(sel).forEach((shelf) =>
      on ? shelf.setAttribute(ATTR, "hidden") : shelf.removeAttribute(ATTR)
    );
  }
}

/**
 * Full teardown: remove every data-ytp attribute so YouTube is fully restored
 * (used on extension context invalidation, spec §5).
 */
export function removeAllAttributes(doc) {
  doc.querySelectorAll(`[${ATTR}]`).forEach((el) => {
    el.removeAttribute(ATTR);
    el.removeAttribute(WHY_ATTR);
  });
  const root = doc.documentElement;
  if (root) {
    root.removeAttribute("data-ytp-reveal");
    root.removeAttribute("data-ytp-pending");
  }
}
