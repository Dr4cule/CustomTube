/**
 * The single decision gate + request batcher (content-script side).
 *
 * checkSemanticMatch(meta, policy) is the one place a card's fate is decided:
 *   cache → structural → baseline → semantic(batched) → apply.
 * Every path normalizes to a strict boolean and fails OPEN (allow) on any error.
 *
 * `sendBatch` is injected so this module is unit-testable without chrome.*.
 */
import { LRU, cacheKey } from "./cache.js";
import { checkStructuralRules, checkBaselineRules } from "./baseline.js";
import { checkAffectRules } from "./affect.js";
import { ChannelMemory } from "./channel.js";
import { parseBatchVerdicts } from "./validate.js";
import { MAX_BATCH, AFFECT_STRICTNESS, DEFAULT_STRICTNESS, CHANNEL_RECORD_CONF } from "./constants.js";

/** Reduce a policy to only what the classifier needs (spec §4: minimal data). */
export function sanitizePolicyForRequest(policy) {
  const out = {
    mode: policy.mode,
    includeTopics: policy.includeTopics || [],
    excludeTopics: policy.excludeTopics || [],
  };
  // Feature #1/#5: only carry these when set, so the request stays minimal.
  if (policy.valence) out.valence = policy.valence;
  if (Array.isArray(policy.rubric) && policy.rubric.length) out.rubric = policy.rubric;
  return out;
}

/** Reduce a card's metadata to the allowed request fields (spec §4). */
export function sanitizeVideoForRequest(meta) {
  const v = { id: meta.id, title: meta.title, channel: meta.channel };
  if (meta.duration) v.duration = meta.duration;
  if (typeof meta.live === "boolean") v.live = meta.live;
  return v;
}

export class Classifier {
  /**
   * @param {{sendBatch: (payload, meta) => Promise<{ok:boolean, results?:string, status?:object, ruleVersion?:string}>}} deps
   */
  constructor({ sendBatch }) {
    this.sendBatch = sendBatch;
    this.cache = new LRU();
    this.queue = [];
    this.inFlight = new Map();
    this.scheduled = false;
    this.aiConfigured = false;
    this.status = { circuitOpen: false, budgetExceeded: false, source: null };
    this.policy = null;
    this.ruleHash = "";
    this.ruleVersion = "";
    this.onStatusChange = null;
    // Feature #2: hide only on verdicts at/above this confidence (0 = honor every hide).
    this.minConfidence = 0;
    // Feature #3: local affect prefilter magnitude, tuned by strictness.
    this.affectThreshold = AFFECT_STRICTNESS[DEFAULT_STRICTNESS];
    // Feature #4: per-(rule,channel) disposition prior that short-circuits the LLM.
    this.channels = new ChannelMemory();
    this.onChannel = null;
  }

  /** Point the classifier at a new rule. Aborts in-flight work and clears the cache. */
  setPolicy(policy, ruleHash, ruleVersion, aiConfigured) {
    this.policy = policy;
    this.ruleHash = ruleHash;
    this.ruleVersion = ruleVersion;
    this.aiConfigured = !!aiConfigured;
    this.status = { circuitOpen: false, budgetExceeded: false, source: null };
    // Abort queued/in-flight requests: resolve them fail-open, they belong to the old rule.
    for (const item of this.queue) item.resolve({ allow: true, reason: "rule-changed", source: "failsafe" });
    this.queue = [];
    this.inFlight.clear();
    this.cache.clear();
    this.channels.reset(ruleHash); // verdicts are rule-specific
  }

  semanticAvailable() {
    return this.aiConfigured && !this.status.circuitOpen && !this.status.budgetExceeded;
  }

  /**
   * The decision gate. Always resolves; never rejects.
   * @returns {Promise<{allow:boolean, reason:string, source:string}>}
   */
  async checkSemanticMatch(meta, policy = this.policy) {
    if (!policy) return { allow: true, reason: "no-policy", source: "failsafe" };
    const key = cacheKey(this.ruleHash, meta.id);

    const cached = this.cache.get(key);
    if (cached) return { ...cached, source: "cache" };

    const structural = checkStructuralRules(meta, policy);
    if (structural) return this.cacheAndReturn(key, { allow: false, reason: structural.reason, source: "structural" });

    const baseline = checkBaselineRules(meta, policy);
    if (baseline.hide) return this.cacheAndReturn(key, { allow: false, reason: baseline.reason, source: "baseline" });

    // Feature #3: local affect prefilter (only for positive-valence rules).
    const affect = checkAffectRules(meta, policy, this.affectThreshold);
    if (affect.hide) return this.cacheAndReturn(key, { allow: false, reason: affect.reason, source: "affect" });

    // Feature #4: a confident per-channel prior short-circuits the LLM (works even if AI is down).
    const prior = this.channels.decide(meta.channel);
    if (prior) return this.cacheAndReturn(key, { allow: prior.allow, reason: prior.reason, source: "channel" });

    // Undecided: needs the semantic layer.
    if (!this.semanticAvailable()) {
      // Fail-open in both modes when AI is unavailable (spec §3). Not cached — provisional.
      return { allow: true, reason: "local-only", source: "failsafe" };
    }

    // Dedupe concurrent requests for the same key.
    if (this.inFlight.has(key)) {
      try {
        return await this.inFlight.get(key);
      } catch {
        return { allow: true, reason: "dedupe-error", source: "failsafe" };
      }
    }

    const p = new Promise((resolve) => {
      this.queue.push({ meta, key, ruleVersion: this.ruleVersion, resolve });
    });
    this.inFlight.set(key, p);
    this.schedule();
    return p;
  }

  cacheAndReturn(key, decision) {
    const rec = { allow: decision.allow, reason: decision.reason };
    this.cache.set(key, rec);
    if (this.onCache) this.onCache(key, rec);
    return decision;
  }

  /** Coalesce the current synchronous burst into one flush (microtask, no timers). */
  schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.flush());
  }

  async flush() {
    this.scheduled = false;
    const batch = this.queue.splice(0, this.queue.length);
    if (batch.length === 0) return;
    for (let i = 0; i < batch.length; i += MAX_BATCH) {
      this.sendChunk(batch.slice(i, i + MAX_BATCH));
    }
  }

  async sendChunk(items) {
    const ruleVersion = this.ruleVersion;
    const payload = {
      policy: sanitizePolicyForRequest(this.policy),
      videos: items.map((it) => sanitizeVideoForRequest(it.meta)),
    };
    const ids = payload.videos.map((v) => v.id);
    let verdicts;
    try {
      const resp = await this.sendBatch(payload, { ruleVersion, ruleHash: this.ruleHash });
      if (resp && resp.status) this.updateStatus(resp.status);
      // Stale rule → drop results, fail-open, do not cache.
      if (!resp || resp.ruleVersion !== ruleVersion || resp.ok === false || typeof resp.results !== "string") {
        this.resolveFailOpen(items, "stale-or-error");
        return;
      }
      verdicts = parseBatchVerdicts(resp.results, ids);
    } catch {
      this.resolveFailOpen(items, "send-error");
      return;
    }
    let recorded = false;
    for (const it of items) {
      // If the rule changed while in flight, the item was already resolved by setPolicy.
      const v = verdicts.get(it.meta.id);
      // Hide only on a confident negative (feature #2); everything else fails open.
      const allow = !(v && v.allow === false && v.conf >= this.minConfidence);
      // Feature #4: feed the channel prior only from confident, genuine verdicts.
      if (v && v.conf >= CHANNEL_RECORD_CONF) {
        this.channels.record(it.meta.channel, v.allow);
        recorded = true;
      }
      const decision = { allow, reason: "semantic", source: "semantic" };
      const rec = { allow: decision.allow, reason: decision.reason };
      this.cache.set(it.key, rec);
      if (this.onCache) this.onCache(it.key, rec);
      this.inFlight.delete(it.key);
      it.resolve(decision);
    }
    if (recorded && this.onChannel) this.onChannel(this.channels.toJSON());
  }

  resolveFailOpen(items, reason) {
    for (const it of items) {
      this.inFlight.delete(it.key);
      it.resolve({ allow: true, reason, source: "failsafe" });
    }
  }

  updateStatus(status) {
    const prev = JSON.stringify(this.status);
    this.status = {
      circuitOpen: !!status.circuitOpen,
      budgetExceeded: !!status.budgetExceeded,
      source: status.source || null,
    };
    if (this.onStatusChange && JSON.stringify(this.status) !== prev) this.onStatusChange(this.status);
  }
}

/** Naming alias from the spec's suggested function list. */
export function classifyVideo(classifier, meta) {
  return classifier.checkSemanticMatch(meta);
}
