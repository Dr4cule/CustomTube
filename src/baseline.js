/**
 * Deterministic classification layers: structural + conservative baseline. Pure/testable.
 * The baseline only ever returns `hide` (on strong signals) or `undecided`.
 * It never returns `allow` on keywords alone (spec §3).
 */
import { normalizeText, isLatinScript, phraseIncludes } from "./text.js";

const MUSIC_TOPIC_RX = /music|song|lofi|lo-fi/;

/**
 * True if the policy calls for hiding music: music is explicitly excluded, or
 * (allowlist) music is not among the included topics. Works for both the local
 * and AI compilers since both put "music" in excludeTopics / omit it from includeTopics.
 */
function policyHidesMusic(policy) {
  const exc = policy.excludeTopics || [];
  if (exc.some((t) => MUSIC_TOPIC_RX.test(t))) return true;
  const inc = policy.includeTopics || [];
  return policy.mode === "allowlist" && !inc.some((t) => MUSIC_TOPIC_RX.test(t));
}

/**
 * Structural rules (Shorts, duration, live, music badge). Deterministic.
 * @param {{isShort?:boolean, live?:boolean, isMusic?:boolean, durationSec?:number|null}} meta
 * @param {import('./policy.js').CompiledPolicy} policy
 * @returns {{hide:true, reason:string}|null}
 */
export function checkStructuralRules(meta, policy) {
  const s = policy.structural || {};
  if (s.hideShorts && meta.isShort) return { hide: true, reason: "structural:shorts" };
  if (s.hideLive && meta.live) return { hide: true, reason: "structural:live" };
  // YouTube's own ♪ badge is an authoritative music signal — hide obvious music
  // locally (no AI) when the rule excludes music.
  if (meta.isMusic && policyHidesMusic(policy)) return { hide: true, reason: "structural:music-badge" };
  if (typeof meta.durationSec === "number") {
    if (typeof s.minDurationSec === "number" && meta.durationSec < s.minDurationSec)
      return { hide: true, reason: "structural:tooShort" };
    if (typeof s.maxDurationSec === "number" && meta.durationSec > s.maxDurationSec)
      return { hide: true, reason: "structural:tooLong" };
  }
  return null;
}

/**
 * Conservative baseline. Only strong, unambiguous terms may hide a video locally.
 * Non-Latin titles are skipped (undecided) and left to the semantic layer.
 * @param {{title?:string, channel?:string}} meta
 * @param {import('./policy.js').CompiledPolicy} policy
 * @returns {{hide:true, reason:string}|{undecided:true}}
 */
export function checkBaselineRules(meta, policy) {
  const title = meta.title || "";
  if (!isLatinScript(title)) return { undecided: true };

  const terms = policy.strongTerms || [];
  if (terms.length === 0) return { undecided: true };

  const hay = normalizeText(title + " " + (meta.channel || ""));
  for (const term of terms) {
    const normTerm = normalizeText(term);
    if (phraseIncludes(hay, normTerm)) {
      return { hide: true, reason: `baseline:${normTerm}` };
    }
  }
  return { undecided: true };
}

/**
 * Map a decision `reason` to a coarse, user-facing class (feature #7). The class
 * is what the "why-hidden" tray groups by and what one-click repair acts on.
 * @param {string} [reason]
 * @returns {"music"|"shorts"|"live"|"duration"|"term"|"negative"|"semantic"|"other"}
 */
export function reasonClass(reason) {
  const r = typeof reason === "string" ? reason : "";
  if (r === "structural:music-badge") return "music";
  if (r === "structural:shorts") return "shorts";
  if (r === "structural:live") return "live";
  if (r === "structural:tooShort" || r === "structural:tooLong") return "duration";
  if (r.startsWith("baseline:")) return "term";
  if (r.startsWith("affect:")) return "negative";
  if (r.startsWith("semantic") || r.startsWith("channel")) return "semantic";
  return "other";
}
