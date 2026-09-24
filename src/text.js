/**
 * Pure text utilities. No chrome.* / DOM references so this imports in Node.
 * globalThis.crypto.subtle exists in modern browsers and Node >= 20.
 */

/** Lowercase, strip diacritics, collapse whitespace. */
export function normalizeText(s) {
  if (typeof s !== "string") return "";
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // combining marks
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip ASCII/Unicode control characters (spec §4: sanitize before sending). */
export function stripControlChars(s) {
  if (typeof s !== "string") return "";
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    out += c < 0x20 || (c >= 0x7f && c <= 0x9f) ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Truncate to n code units, safely. */
export function truncate(s, n) {
  s = typeof s === "string" ? s : "";
  return s.length > n ? s.slice(0, n) : s;
}

/**
 * Heuristic: does the string contain meaningful Latin-script letters?
 * Baseline matching is Latin-only; non-Latin titles fall through to semantic (spec §3).
 */
export function isLatinScript(s) {
  if (typeof s !== "string" || !s) return false;
  const letters = s.match(/\p{L}/gu);
  if (!letters || letters.length === 0) return false;
  const latin = s.match(/\p{Script=Latin}/gu) || [];
  return latin.length / letters.length >= 0.6;
}

/**
 * Word-boundary, phrase-aware containment on already-normalized text.
 * Treats any non-alphanumeric run as a boundary so "python" does not match "pythons"
 * incorrectly but "official music video" matches within a longer title.
 */
export function phraseIncludes(normalizedHaystack, normalizedPhrase) {
  if (!normalizedHaystack || !normalizedPhrase) return false;
  // Phrases containing '#' (e.g. "#shorts") or '*' are matched loosely as substrings,
  // since '#' is a boundary char and would otherwise never anchor.
  if (/[#*]/.test(normalizedPhrase)) {
    return normalizedHaystack.includes(normalizedPhrase.replace(/\*/g, ""));
  }
  const escaped = normalizedPhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u");
  return re.test(normalizedHaystack);
}

/** Synchronous 32-bit FNV-1a hash → hex. Used for non-security fallback identities. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** SHA-256 hex of a string via WebCrypto (async). Used for the rule hash. */
export async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const buf = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Parse a YouTube duration badge ("12:34", "1:02:03") → seconds or null. */
export function parseDurationToSeconds(text) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!/^\d{1,2}(:\d{2}){1,2}$/.test(t)) return null;
  const parts = t.split(":").map((n) => parseInt(n, 10));
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}
