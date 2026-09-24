/**
 * Video identity extraction. Pure — no DOM/chrome. Testable in Node.
 */
import { fnv1a, normalizeText } from "./text.js";

/**
 * Extract a canonical YouTube video id from an href.
 * Handles /watch?v=ID, /shorts/ID, youtu.be/ID, and embed/ID.
 * Returns the 11-char id, or null when none can be safely extracted.
 * @param {string|null|undefined} href
 * @returns {string|null}
 */
export function getVideoId(href) {
  if (typeof href !== "string" || !href) return null;
  let url;
  try {
    url = new URL(href, "https://www.youtube.com");
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "");

  if (host === "youtu.be") {
    const seg = url.pathname.split("/").filter(Boolean)[0];
    return isValidId(seg) ? seg : null;
  }

  // /watch?v=ID  (a Mix/playlist card may have ?list=... and no v → not a video)
  if (url.pathname === "/watch") {
    const v = url.searchParams.get("v");
    return isValidId(v) ? v : null;
  }

  // /shorts/ID and /embed/ID
  const m = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/);
  if (m && isValidId(m[1])) return m[1];

  return null;
}

/** YouTube ids are 11 chars from [A-Za-z0-9_-]. */
export function isValidId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{11}$/.test(id);
}

/**
 * Fallback identity for cards with no canonical video id (Mix/playlist lockups).
 * Deterministic, synchronous, and collision-resistant enough for a local cache key.
 * Marked with an "fb_" prefix so callers can tell it is a fallback identity.
 * ponytail: 32-bit FNV instead of SHA-256 — this runs per-card in the hot path and is
 * only a local cache identity, not security-sensitive. Upgrade to SHA if collisions bite.
 * @returns {string|null}
 */
export function fallbackIdentity(title, channel) {
  const t = normalizeText(title);
  const c = normalizeText(channel);
  if (!t && !c) return null;
  return "fb_" + fnv1a(t + "|" + c);
}

/**
 * Resolve an identity for a card given its link href and text fields.
 * @returns {{id: string, fallback: boolean}|null}
 */
export function resolveIdentity(href, title, channel) {
  const real = getVideoId(href);
  if (real) return { id: real, fallback: false };
  const fb = fallbackIdentity(title, channel);
  return fb ? { id: fb, fallback: true } : null;
}
