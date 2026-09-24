/**
 * Channel verdict memory (feature #4). A per-(ruleHash, channel) prior that
 * short-circuits the LLM once enough CONFIDENT verdicts agree. Pure/testable:
 * no chrome.* / DOM. Counts are seeded/persisted by the caller (main.js).
 *
 * Only fires when the Wilson lower bound of the majority proportion clears a high
 * bar, so a couple of coincidences never entrench a channel — and counts decay on
 * overflow so an early streak can be overturned by a later reversal.
 */
import { normalizeText } from "./text.js";
import { CHANNEL_MIN_SAMPLES, CHANNEL_CONFIDENCE, CHANNEL_MAX_COUNT } from "./constants.js";

/**
 * Wilson score interval lower bound for a binomial proportion. Conservative:
 * with few samples it stays well below the raw rate, so we don't trust a 2/2 streak.
 * @returns {number} lower bound in 0..1
 */
export function wilsonLower(pos, n, z = 1.96) {
  if (n <= 0) return 0;
  const phat = pos / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denom);
}

export class ChannelMemory {
  constructor({ minSamples = CHANNEL_MIN_SAMPLES, confidence = CHANNEL_CONFIDENCE, maxCount = CHANNEL_MAX_COUNT } = {}) {
    this.minSamples = minSamples;
    this.confidence = confidence;
    this.maxCount = maxCount;
    this.ruleHash = null;
    /** @type {Map<string, {pos:number, neg:number}>} pos = confident-allow, neg = confident-hide */
    this.map = new Map();
  }

  /** Point the memory at a rule; a new rule starts fresh (verdicts are rule-specific). */
  reset(ruleHash) {
    if (ruleHash !== this.ruleHash) this.map.clear();
    this.ruleHash = ruleHash || null;
  }

  _key(channel) {
    return normalizeText(channel || "");
  }

  /**
   * Resolve a channel from its prior, or null if not confident enough yet.
   * @returns {{allow:boolean, reason:string}|null}
   */
  decide(channel) {
    const key = this._key(channel);
    if (!key) return null;
    const c = this.map.get(key);
    if (!c) return null;
    const n = c.pos + c.neg;
    if (n < this.minSamples) return null;
    const allow = c.pos >= c.neg;
    const majority = allow ? c.pos : c.neg;
    if (wilsonLower(majority, n) < this.confidence) return null;
    return { allow, reason: "channel:prior" };
  }

  /** Record one confident verdict for a channel. Decays both sides on overflow. */
  record(channel, allow) {
    const key = this._key(channel);
    if (!key) return;
    const c = this.map.get(key) || { pos: 0, neg: 0 };
    if (allow) c.pos++;
    else c.neg++;
    // Cap + halve so a long early streak can't entrench; a later reversal can still flip it.
    if (c.pos > this.maxCount || c.neg > this.maxCount) {
      c.pos = Math.floor(c.pos / 2);
      c.neg = Math.floor(c.neg / 2);
    }
    this.map.set(key, c);
  }

  /** Serialize for persistence (scoped to the current ruleHash). */
  toJSON() {
    const counts = {};
    for (const [k, c] of this.map) counts[k] = [c.pos, c.neg];
    return { ruleHash: this.ruleHash, counts };
  }

  /** Restore persisted counts, but only if they belong to the current rule. */
  load(obj) {
    if (!obj || obj.ruleHash !== this.ruleHash || !obj.counts || typeof obj.counts !== "object") return;
    for (const [k, v] of Object.entries(obj.counts)) {
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number") {
        this.map.set(k, { pos: Math.max(0, v[0]), neg: Math.max(0, v[1]) });
      }
    }
  }
}
