/**
 * MV3 service worker (ES module). Owns all AI calls and the API key.
 * The content script never sees the key and never talks to AI endpoints.
 * Fail-safe: on any failure the worker returns ok:false and the content script
 * fails OPEN (keeps the card visible).
 */
import { makeProvider, parseRetryAfter } from "./providers.js";
import { validateCompiledPolicy, stripJsonFences, parseBatchVerdicts } from "./src/validate.js";
import { LRU, cacheKey } from "./src/cache.js";
import {
  REQUEST_TIMEOUT_MS,
  RETRY_BASE_MS,
  MAX_CONCURRENT_BATCHES,
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_OPEN_MS,
  DEFAULT_RPM,
  DEFAULT_RPD,
} from "./src/constants.js";

/**
 * API-key protection (spec §8): the key lives under its own `apiKey` storage
 * entry that ONLY the service worker reads (getConfig). The content script
 * fetches STORAGE_KEYS — which never includes `apiKey` — so it never sees the
 * key, and web pages can't touch chrome.storage at all.
 *
 * Do NOT call storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }):
 * content scripts are UNTRUSTED contexts, so that throws "Access to storage is
 * not allowed from this context" on every read the content script makes
 * (rule/settings/enabled/cache), aborting init() before the masthead UI mounts.
 * The default level (TRUSTED_AND_UNTRUSTED) is what the content script needs.
 */

// ---- Concurrency: at most MAX_CONCURRENT_BATCHES in flight (in-memory, transient) ----
let active = 0;
const waiters = [];

// Feature #6: worker-level shared verdict cache (ruleHash:id → {allow, conf}).
// Lives only as long as the service worker; MV3 evicts it after ~30s idle.
const verdictCache = new LRU();

function acquire() {
  if (active < MAX_CONCURRENT_BATCHES) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}
function release() {
  active--;
  const next = waiters.shift();
  if (next) {
    active++;
    next();
  }
}

// ---- Budget + circuit-breaker counters, persisted in storage.session ----
async function getCounters() {
  const { ypCounters } = await chrome.storage.session.get("ypCounters");
  return ypCounters || { minuteStart: 0, minuteCount: 0, dayStart: 0, dayCount: 0, failures: 0, openUntil: 0 };
}
async function setCounters(c) {
  await chrome.storage.session.set({ ypCounters: c });
}

async function getConfig() {
  const { settings, apiKey } = await chrome.storage.local.get(["settings", "apiKey"]);
  const provider = (settings && settings.provider) || { id: "none" };
  const budget = (settings && settings.budget) || { rpm: DEFAULT_RPM, rpd: DEFAULT_RPD };
  return { provider: { ...provider, apiKey: apiKey || "" }, budget };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True for transient errors worth one retry: timeout, network, 5xx, 429. */
function isRetriable(e) {
  if (!e) return false;
  if (e.name === "AbortError") return true;
  if (typeof e.status === "number") return e.status >= 500 || e.status === 429;
  return e instanceof TypeError; // fetch network failure
}

/** Call provider fn(signal) with an 8s timeout and one jittered retry (spec §9). */
async function callWithTimeoutRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fn(ctrl.signal);
    } catch (e) {
      lastErr = e;
      if (attempt === 0 && isRetriable(e)) {
        const backoff = e.retryAfter != null ? e.retryAfter : RETRY_BASE_MS * (1 + Math.random());
        await sleep(Math.min(backoff, REQUEST_TIMEOUT_MS));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/**
 * Check budget + circuit, run the provider call, and update counters.
 * Returns { status, run() } where run resolves the raw provider result or throws.
 */
async function guardedCall(providerCall) {
  const now = Date.now();
  const c = await getCounters();
  const { budget } = await getConfig();

  // Circuit breaker open?
  if (c.openUntil && now < c.openUntil) {
    return { blocked: true, status: statusOf(c, true, false) };
  }
  // Budget windows.
  if (now - c.minuteStart >= 60_000) {
    c.minuteStart = now;
    c.minuteCount = 0;
  }
  if (now - c.dayStart >= 86_400_000) {
    c.dayStart = now;
    c.dayCount = 0;
  }
  const rpm = Number(budget.rpm) || DEFAULT_RPM;
  const rpd = Number(budget.rpd) || DEFAULT_RPD;
  if (c.minuteCount >= rpm || c.dayCount >= rpd) {
    await setCounters(c);
    return { blocked: true, status: statusOf(c, false, true) };
  }

  c.minuteCount++;
  c.dayCount++;
  await setCounters(c);

  await acquire();
  try {
    const raw = await callWithTimeoutRetry(providerCall);
    const fresh = await getCounters();
    fresh.failures = 0;
    await setCounters(fresh);
    return { raw, status: statusOf(fresh, false, false) };
  } catch (e) {
    const fresh = await getCounters();
    fresh.failures = (fresh.failures || 0) + 1;
    if (fresh.failures >= CIRCUIT_FAILURE_THRESHOLD) fresh.openUntil = Date.now() + CIRCUIT_OPEN_MS;
    await setCounters(fresh);
    throw Object.assign(e, { status: statusOf(fresh, fresh.failures >= CIRCUIT_FAILURE_THRESHOLD, false) });
  } finally {
    release();
  }
}

function statusOf(c, circuitOpen, budgetExceeded) {
  return {
    circuitOpen: !!circuitOpen || (c.openUntil && Date.now() < c.openUntil),
    budgetExceeded: !!budgetExceeded,
    source: "semantic",
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  if (msg.type === "classifyBatch") {
    handleClassify(msg).then(sendResponse).catch((e) =>
      sendResponse({ ok: false, ruleVersion: msg.ruleVersion, status: e && e.status })
    );
    return true; // async response
  }
  if (msg.type === "compilePolicy") {
    handleCompile(msg).then(sendResponse).catch(() => sendResponse({ ok: false, ruleVersion: msg.ruleVersion }));
    return true;
  }
  if (msg.type === "ping") {
    getConfig().then((cfg) => sendResponse({ ok: true, provider: cfg.provider.id }));
    return true;
  }
  return false;
});

async function handleClassify(msg) {
  const { provider: pconf } = await getConfig();
  const provider = makeProvider(pconf);
  if (!provider) return { ok: false, ruleVersion: msg.ruleVersion, status: { circuitOpen: false, budgetExceeded: false, source: "none" } };

  // Feature #6: a worker-level verdict cache (keyed ruleHash:id) dedupes decisions
  // across tabs so a video already judged for this rule never spends another call.
  // Transient by design — MV3 evicts the worker after ~30s idle, and that's fine.
  const videos = msg.payload && Array.isArray(msg.payload.videos) ? msg.payload.videos : [];
  const ruleHash = msg.ruleHash || "";
  const results = []; // merged { id, allow, conf }
  const misses = [];
  for (const v of videos) {
    const hit = verdictCache.get(cacheKey(ruleHash, v.id));
    if (hit) results.push({ id: v.id, allow: hit.allow, conf: hit.conf });
    else misses.push(v);
  }

  // Everything served from cache → no provider call, no budget spend.
  if (misses.length === 0) {
    return { ok: true, results: JSON.stringify({ results }), ruleVersion: msg.ruleVersion, status: { circuitOpen: false, budgetExceeded: false, source: "cache" } };
  }

  // ponytail: no worker-level in-flight dedup — the LRU covers the common
  // sequential case; two tabs racing the SAME id may each call once. Add a
  // pending-promise map if that redundancy ever shows up in metrics.
  const missPayload = { ...msg.payload, videos: misses };
  const result = await guardedCall((signal) => provider.classifyBatch(missPayload, signal));
  if (result.blocked) {
    // Blocked (budget/circuit): still return any cached verdicts we have; the
    // uncached ids are simply omitted and fail open on the content side.
    if (results.length) return { ok: true, results: JSON.stringify({ results }), ruleVersion: msg.ruleVersion, status: result.status };
    return { ok: false, ruleVersion: msg.ruleVersion, status: result.status };
  }
  const fresh = parseBatchVerdicts(result.raw, misses.map((v) => v.id));
  for (const [id, v] of fresh) {
    verdictCache.set(cacheKey(ruleHash, id), v);
    results.push({ id, allow: v.allow, conf: v.conf });
  }
  return { ok: true, results: JSON.stringify({ results }), ruleVersion: msg.ruleVersion, status: result.status };
}

async function handleCompile(msg) {
  const { provider: pconf } = await getConfig();
  const provider = makeProvider(pconf);
  if (!provider) return { ok: false, ruleVersion: msg.ruleVersion };

  const result = await guardedCall((signal) => provider.compilePolicy(msg.ruleText, signal));
  if (result.blocked) return { ok: false, ruleVersion: msg.ruleVersion, status: result.status };
  let policy = null;
  try {
    policy = validateCompiledPolicy(JSON.parse(stripJsonFences(result.raw)));
  } catch {
    policy = null;
  }
  if (!policy) return { ok: false, ruleVersion: msg.ruleVersion };
  return { ok: true, policy, ruleVersion: msg.ruleVersion, status: result.status };
}
