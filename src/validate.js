/**
 * Strict validation of a classifier batch response. Pure — testable in Node.
 * Fail-open contract (spec §4): any missing / unknown / duplicated / malformed
 * entry means that video is ALLOWED. Structural failure → every video allowed.
 */

/** Strip a single leading/trailing ```json ... ``` fence, if present. */
export function stripJsonFences(text) {
  if (typeof text !== "string") return "";
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) t = fence[1].trim();
  return t;
}

const CONF_WORDS = { high: 1, medium: 0.6, low: 0.3 };
/**
 * Coerce a verdict's confidence to 0..1 (feature #2). Absent or unparseable
 * confidence → 0, so a hide from it is honored ONLY at minConfidence 0 (the
 * default) and falls open the moment the user asks for any confidence at all.
 */
function normConf(v) {
  if (typeof v === "number" && isFinite(v)) return Math.min(1, Math.max(0, v));
  if (typeof v === "string") {
    const w = CONF_WORDS[v.trim().toLowerCase()];
    if (w !== undefined) return w;
  }
  return 0;
}

/**
 * Parse raw model output into per-id {allow, conf}, keeping ONLY validly-decided
 * ids (no fail-open default fill — the caller decides what an omitted id means).
 * Duplicate / non-boolean entries collapse to a distrusted open verdict.
 * @param {string} rawText
 * @param {string[]} requestedIds
 * @returns {Map<string, {allow:boolean, conf:number}>}
 */
export function parseBatchVerdicts(rawText, requestedIds) {
  const decided = new Map();
  let parsed;
  try {
    parsed = JSON.parse(stripJsonFences(rawText));
  } catch {
    return decided; // invalid JSON → nothing decided
  }
  if (!parsed || !Array.isArray(parsed.results)) return decided;

  const requested = new Set(requestedIds);
  const seen = new Set();
  for (const entry of parsed.results) {
    if (!entry || typeof entry !== "object") continue; // malformed → skip
    const { id, allow } = entry;
    if (typeof id !== "string" || !requested.has(id)) continue; // malformed / unknown id
    if (seen.has(id)) {
      decided.set(id, { allow: true, conf: 0 }); // duplicate → force open, never trust either
      continue;
    }
    seen.add(id);
    if (typeof allow !== "boolean") {
      decided.set(id, { allow: true, conf: 0 }); // non-boolean → fail-open
      continue;
    }
    decided.set(id, { allow, conf: normConf(entry.conf) });
  }
  return decided;
}

/**
 * Validate raw model output against the requested id set.
 * @param {string} rawText   The model's textual response.
 * @param {string[]} requestedIds  Ids that were sent in the request.
 * @param {number} [minConfidence=0]  A hide is honored only if conf ≥ this (feature #2);
 *   below it the video fails open (stays visible). Default 0 = honor every hide.
 * @returns {Map<string, boolean>} decision per requested id; default true (allow).
 */
export function validateBatchResponse(rawText, requestedIds, minConfidence = 0) {
  // Start fully fail-open: every requested id allowed.
  const out = new Map();
  for (const id of requestedIds) out.set(id, true);
  for (const [id, v] of parseBatchVerdicts(rawText, requestedIds)) {
    // Hide only on a confident negative; a low-confidence hide falls open.
    out.set(id, !(v.allow === false && v.conf >= minConfidence));
  }
  return out;
}

/**
 * Coerce/validate a CompiledPolicy object returned by the AI compiler (spec §2/§4).
 * Never throws; returns a well-formed policy. `ruleHash` is attached by the caller.
 * @param {any} obj
 * @returns {import('./policy.js').CompiledPolicy|null} null if unusable.
 */
export function validateCompiledPolicy(obj) {
  if (!obj || typeof obj !== "object") return null;
  const mode = obj.mode === "allowlist" ? "allowlist" : "blocklist";
  const strArr = (v) =>
    Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().toLowerCase()))] : [];
  const s = obj.structural && typeof obj.structural === "object" ? obj.structural : {};
  const num = (v) => (typeof v === "number" && isFinite(v) && v >= 0 ? v : undefined);
  const valence = obj.valence === "positive" ? "positive" : obj.valence === "negative" ? "negative" : null;
  return {
    mode,
    includeTopics: strArr(obj.includeTopics),
    excludeTopics: strArr(obj.excludeTopics),
    structural: {
      hideShorts: !!s.hideShorts,
      hideLive: !!s.hideLive,
      minDurationSec: num(s.minDurationSec),
      maxDurationSec: num(s.maxDurationSec),
    },
    strongTerms: strArr(obj.strongTerms),
    valence,
    rubric: Array.isArray(obj.rubric)
      ? [...new Set(obj.rubric.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().slice(0, 120)))].slice(0, 6)
      : [],
    summary: typeof obj.summary === "string" ? obj.summary.slice(0, 200) : "",
    notes: Array.isArray(obj.notes) ? obj.notes.filter((x) => typeof x === "string").slice(0, 8) : [],
  };
}
