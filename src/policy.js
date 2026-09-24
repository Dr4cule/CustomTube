/**
 * Rule → CompiledPolicy local heuristic compiler + rule hashing. Pure/testable.
 *
 * @typedef {Object} CompiledPolicy
 * @property {string} [ruleHash]   SHA-256 of normalized rule text (attached by caller)
 * @property {"blocklist"|"allowlist"} mode
 * @property {string[]} includeTopics
 * @property {string[]} excludeTopics  always win over includeTopics
 * @property {{hideShorts:boolean, hideLive?:boolean, minDurationSec?:number, maxDurationSec?:number}} structural
 * @property {string[]} strongTerms
 * @property {"positive"|"negative"|null} [valence]  mood filter: keep-neutral hide-negative
 * @property {string[]} [rubric]   observable sub-criteria (AI-compiled; feature #5)
 * @property {string} summary
 * @property {string[]} notes
 */
import { normalizeText, sha256Hex, phraseIncludes } from "./text.js";
import {
  TOPIC_LEXICON,
  STRONG_TERMS,
  NEGATION_MARKERS,
  INCLUSION_MARKERS,
  ALLOWLIST_TRIGGERS,
  POSITIVITY_CUES,
  NEGATIVITY_CUES,
} from "./constants.js";

const STUDY_CUES = ["studying", "study", "focus", "focused", "productivity", "deep work", "revision", "exam"];
const RELAX_CUES = ["relax", "relaxing", "chill", "chilling", "unwind", "wind down", "wind-down"];

/** Normalize rule text for a stable hash. */
export function normalizeRule(text) {
  return normalizeText(text);
}

/** SHA-256 hex of the normalized rule (async). */
export async function computeRuleHash(text) {
  return sha256Hex(normalizeRule(text));
}

/** True if the haystack contains any of the markers as a whole word/phrase. */
function hasAny(haystack, markers) {
  return markers.some((m) => phraseIncludes(haystack, m.trim()));
}

/**
 * Detect a mood/valence preference in the rule (feature #1). A positivity request,
 * or a negation of negativity ("no doom", "less rage bait"), reads as "positive"
 * = keep neutral, hide only clearly negative. Topic words like "drama" are NOT
 * cues, so a topic rule never misfires as a mood rule.
 */
function detectValence(norm) {
  if (hasAny(norm, POSITIVITY_CUES)) return "positive";
  if (hasAny(norm, NEGATIVITY_CUES) && hasAny(norm, NEGATION_MARKERS)) return "positive";
  return null;
}

/** Detect topics mentioned in a piece of text via the lexicon. */
function detectTopics(normText) {
  const found = new Set();
  for (const [topic, phrases] of Object.entries(TOPIC_LEXICON)) {
    for (const p of phrases) {
      if (phraseIncludes(normText, p)) {
        found.add(topic);
        break;
      }
    }
  }
  return found;
}

/**
 * Parse duration constraints. minDurationSec = floor (hide shorter);
 * maxDurationSec = ceiling (hide longer), matching checkStructuralRules.
 * The mapping depends on both the comparator (short vs long side) and whether
 * the clause is a hide-intent ("hide videos under 5 min" → floor of 5 min).
 */
function parseDuration(norm) {
  const out = {};
  const hideIntent = /\b(hide|no|don't|dont|do not|block|without|remove|skip|avoid)\b/.test(norm);
  const rx = /(longer than|shorter than|less than|more than|at least|at most|over|under|below|above)\s+(\d+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)?/g;
  let match;
  while ((match = rx.exec(norm))) {
    const n = parseInt(match[2], 10);
    const unit = match[3] || "min";
    const sec = /^s/.test(unit) ? n : /^h/.test(unit) ? n * 3600 : n * 60;
    const longSide = /longer than|more than|at least|over|above/.test(match[1]);
    if (longSide) {
      if (hideIntent) out.maxDurationSec = sec; // hide long videos
      else out.minDurationSec = sec; // keep long → hide the short ones below it
    } else {
      if (hideIntent) out.minDurationSec = sec; // hide short videos
      else out.maxDurationSec = sec; // keep short → hide the long ones above it
    }
  }
  return out;
}

/**
 * Compile rule text into a CompiledPolicy using local heuristics only.
 * Deterministic and synchronous; ruleHash is attached by the caller.
 * @param {string} ruleText
 * @returns {CompiledPolicy}
 */
export function compilePolicyLocal(ruleText) {
  const raw = typeof ruleText === "string" ? ruleText : "";
  const norm = normalizeText(raw);
  const notes = [];

  // Split into clauses on separators and coordinating conjunctions so each
  // "show X and hide Y" half keeps its own polarity (not the last marker's).
  const clauses = norm
    .split(/[,;.&]|\b(?:but|and)\b/g)
    .map((c) => c.trim())
    .filter(Boolean);

  const include = new Set();
  const exclude = new Set();
  let currentPolarity = null; // "include" | "exclude"

  for (const clause of clauses) {
    let polarity = currentPolarity;
    if (hasAny(clause, NEGATION_MARKERS)) polarity = "exclude";
    else if (hasAny(clause, INCLUSION_MARKERS)) polarity = "include";
    if (!polarity) polarity = "include"; // a bare leading topic reads as "show this"
    currentPolarity = polarity;

    for (const topic of detectTopics(clause)) {
      (polarity === "exclude" ? exclude : include).add(topic);
    }
  }

  // Excludes always win over includes (spec §2).
  for (const t of exclude) include.delete(t);

  const hasPrioritize = /prioriti[sz]e/.test(norm);
  const hasAllowlistTrigger = hasAny(norm, ALLOWLIST_TRIGGERS);
  const hasPrioritizeOnly = hasPrioritize && !hasAllowlistTrigger;
  const studyRelax = hasAny(norm, STUDY_CUES) || hasAny(norm, RELAX_CUES);
  const hasInclusionMarker = hasAny(norm, INCLUSION_MARKERS);

  let mode = "blocklist";
  if (hasAllowlistTrigger) mode = "allowlist";
  else if (studyRelax && include.size > 0 && !hasPrioritizeOnly) mode = "allowlist";
  else if (include.size > 0 && exclude.size === 0 && hasInclusionMarker && !hasPrioritizeOnly) mode = "allowlist";

  if (hasPrioritizeOnly) {
    notes.push("Reordering ('prioritize') is not supported; treated as a filter only.");
  }

  const includeTopics = [...include];
  const excludeTopics = [...exclude];

  // Feature #1: a positivity rule with no concrete topics must NOT become an empty
  // allowlist (which hides the entire feed). Keep neutral instead — hide only the
  // clearly-negative, via the valence flag the classifier honors.
  const valence = detectValence(norm);
  if (valence === "positive" && includeTopics.length === 0 && mode === "allowlist") {
    mode = "blocklist";
    notes.push("Positivity rule with no topics: keeping positive & neutral videos and hiding only clearly negative ones, instead of blanking the feed.");
  }

  // Structural rules.
  const structural = {
    hideShorts: excludeTopics.includes("shorts") || (mode === "allowlist" && !includeTopics.includes("shorts")),
    hideLive: /\b(no|hide|block|without)\b[^.]*\blive\b|\blivestream|\blive stream/.test(norm),
    ...parseDuration(norm),
  };

  // Strong terms for the deterministic baseline: only from excluded topics.
  const strongTerms = new Set();
  for (const t of excludeTopics) {
    for (const term of STRONG_TERMS[t] || []) strongTerms.add(term);
  }
  // In allowlist mode, excluding a topic the user didn't include is implicit, but we do
  // NOT add strong terms for un-included topics — the semantic layer handles those.

  if (mode === "allowlist" && includeTopics.length === 0) {
    notes.push("No specific topics recognized locally; configure an AI provider for better results.");
  }

  const summary = buildSummary(mode, includeTopics, excludeTopics, structural, valence);
  return { mode, includeTopics, excludeTopics, structural, strongTerms: [...strongTerms], valence, rubric: [], summary, notes };
}

/** One-line human restatement shown in the UI tooltip. */
function buildSummary(mode, include, exclude, structural, valence) {
  const parts = [];
  if (mode === "allowlist") {
    parts.push(include.length ? `Show only: ${include.join(", ")}` : "Show only matching videos");
    if (exclude.length) parts.push(`always hide: ${exclude.join(", ")}`);
  } else if (exclude.length) {
    parts.push(`Hide: ${exclude.join(", ")}`);
  } else if (valence === "positive") {
    parts.push("Keep positive & neutral videos, hide clearly negative ones");
  } else {
    parts.push("No filtering");
  }
  const s = [];
  if (structural.hideShorts) s.push("Shorts");
  if (structural.hideLive) s.push("live");
  if (structural.minDurationSec) s.push(`< ${Math.round(structural.minDurationSec / 60)}m`);
  if (structural.maxDurationSec) s.push(`> ${Math.round(structural.maxDurationSec / 60)}m`);
  if (s.length) parts.push(`hide ${s.join(", ")}`);
  return parts.join("; ");
}
