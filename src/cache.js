/**
 * Cache primitives. Pure — no chrome/DOM. Testable in Node.
 * Persistence to chrome.storage.local lives in the content script; the TTL/cap
 * pruning logic is kept here as a pure function so it can be unit-tested.
 */
import { LRU_CAP, PERSIST_CACHE_CAP, CACHE_TTL_MS } from "./constants.js";

/** Cache key is ruleHash:videoId — the decision depends on the rule, never the id alone. */
export function cacheKey(ruleHash, videoId) {
  return `${ruleHash}:${videoId}`;
}

/**
 * Small insertion-ordered LRU over a Map. `get` refreshes recency.
 * Values are decision records { allow, reason, source }.
 */
export class LRU {
  constructor(cap = LRU_CAP) {
    this.cap = cap;
    this.map = new Map();
  }
  has(key) {
    return this.map.has(key);
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, v); // move to most-recent
    return v;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    return value;
  }
  delete(key) {
    return this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
  get size() {
    return this.map.size;
  }
}

/**
 * Prune a persisted cache object down to the current rule hash, dropping expired
 * and over-cap entries. Pure function of its inputs.
 * @param {Record<string,{allow:boolean,reason?:string,source?:string,t:number}>} obj
 * @param {{now:number, ttl?:number, cap?:number, ruleHash:string}} opts
 * @returns {Record<string,object>} a new pruned object
 */
export function pruneCache(obj, { now, ttl = CACHE_TTL_MS, cap = PERSIST_CACHE_CAP, ruleHash }) {
  const out = {};
  const kept = [];
  for (const [key, rec] of Object.entries(obj || {})) {
    if (!rec || typeof rec.t !== "number") continue;
    // Only entries for the current rule hash survive (key is `${ruleHash}:${id}`).
    if (ruleHash && !key.startsWith(ruleHash + ":")) continue;
    if (now - rec.t > ttl) continue; // expired
    kept.push([key, rec]);
  }
  // Newest first, cap.
  kept.sort((a, b) => b[1].t - a[1].t);
  for (const [key, rec] of kept.slice(0, cap)) out[key] = rec;
  return out;
}
