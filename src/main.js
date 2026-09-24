/**
 * Content-script entry (dynamically imported by content.js). Wires storage,
 * the classifier, the DOM observer and the masthead UI together, and owns all
 * chrome.* interaction. Pure logic lives in the sibling modules.
 */
import {
  SURFACE_DEFAULTS,
  DEFAULT_RPM,
  DEFAULT_RPD,
  STRICTNESS_CONFIDENCE,
  AFFECT_STRICTNESS,
  DEFAULT_STRICTNESS,
  WHY_ATTR,
  STRONG_TERMS,
} from "./constants.js";
import { compilePolicyLocal, computeRuleHash } from "./policy.js";
import { Classifier } from "./classify.js";
import { YouTubeObserver } from "./observer.js";
import { AssistantControl } from "./ui.js";
import { setPendingStyle, setReveal, removeAllAttributes } from "./apply.js";
import { pruneCache } from "./cache.js";

const STORAGE_KEYS = ["ruleText", "ruleHash", "ruleVersion", "compiledPolicy", "enabled", "settings"];
const CACHE_KEY = "cache";
const CHANNEL_KEY = "channelStats";

const DEFAULT_SETTINGS = {
  surfaces: { ...SURFACE_DEFAULTS },
  pendingStyle: "dim",
  persistCache: true,
  debug: false,
  strictness: DEFAULT_STRICTNESS,
  provider: { id: "none", baseURL: "", model: "" },
  budget: { rpm: DEFAULT_RPM, rpd: DEFAULT_RPD },
};

const state = {
  ruleText: "",
  ruleHash: "",
  ruleVersion: "",
  compiledPolicy: null,
  enabled: true,
  settings: structuredClone(DEFAULT_SETTINGS),
  compiling: false,
  inert: false,
  showAll: false,
  uiPos: null, // {left, top} of the dragged launcher, or null for the default corner
};

let classifier, observer, control, DEBUG = false;

function log(...args) {
  if (DEBUG) console.log("[YT Personalizer]", ...args);
}

function isContextValid() {
  try {
    return !!(chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

/** Ask the service worker to classify a batch. Fails open on any error. */
async function sendBatch(payload, meta) {
  if (!isContextValid()) throw new Error("context-invalidated");
  const resp = await chrome.runtime.sendMessage({
    type: "classifyBatch",
    ruleVersion: meta.ruleVersion,
    ruleHash: meta.ruleHash,
    payload,
  });
  log("semantic result", resp && resp.ok, "for", payload.videos.length, "videos");
  return resp || { ok: false, ruleVersion: meta.ruleVersion };
}

function aiConfigured() {
  return state.settings.provider && state.settings.provider.id !== "none";
}

function computeStatusKey() {
  if (!state.enabled) return "paused";
  if (state.inert) return "selectors";
  if (state.compiling) return "compiling";
  if (classifier && classifier.status.circuitOpen) return "aiDown";
  if (classifier && classifier.status.budgetExceeded) return "budget";
  if (!aiConfigured()) return "local";
  return "active";
}

function hiddenCount() {
  return document.querySelectorAll('[data-ytp="hidden"]').length;
}

// ---- Why-hidden tray + one-click repair (feature #7) ----
const CLASS_LABELS = {
  music: "Music",
  shorts: "Shorts",
  live: "Live streams",
  duration: "Too short / too long",
  term: "Blocked phrases",
  negative: "Negative / rage-bait",
  semantic: "Rule match",
  other: "Other",
};
// Classes a deterministic repair can loosen. Semantic/other need a rule edit, not a toggle.
const REPAIRABLE = new Set(["music", "shorts", "live", "duration", "term", "negative"]);

/** Tally currently-hidden cards by their hide-reason class, most-hidden first. */
function hiddenBreakdown() {
  const counts = new Map();
  document.querySelectorAll(`[${WHY_ATTR}]`).forEach((el) => {
    const cls = el.getAttribute(WHY_ATTR) || "other";
    counts.set(cls, (counts.get(cls) || 0) + 1);
  });
  return [...counts.entries()]
    .map(([cls, count]) => ({ cls, label: CLASS_LABELS[cls] || cls, count, repairable: REPAIRABLE.has(cls) }))
    .sort((a, b) => b.count - a.count);
}

const MUSIC_RX = /music|song|lofi|lo-?fi/i;

/**
 * "Show me these anyway": deterministically loosen the compiled policy for one
 * hide-reason class WITHOUT editing the user's rule text, bump the rule version
 * so every card re-evaluates, and drop the now-stale decision cache.
 */
async function repairClass(cls) {
  const p = state.compiledPolicy;
  if (!p || !REPAIRABLE.has(cls)) return;
  const s = p.structural || (p.structural = {});
  switch (cls) {
    case "music":
      p.excludeTopics = (p.excludeTopics || []).filter((t) => !MUSIC_RX.test(t));
      p.strongTerms = (p.strongTerms || []).filter((t) => !STRONG_TERMS.music.includes(t));
      if (p.mode === "allowlist" && !(p.includeTopics || []).some((t) => MUSIC_RX.test(t))) {
        (p.includeTopics ||= []).push("music");
      }
      break;
    case "shorts":
      s.hideShorts = false;
      p.excludeTopics = (p.excludeTopics || []).filter((t) => !/short/i.test(t));
      p.strongTerms = (p.strongTerms || []).filter((t) => t !== "#shorts");
      if (p.mode === "allowlist") (p.includeTopics ||= []).push("shorts");
      break;
    case "live":
      s.hideLive = false;
      break;
    case "duration":
      delete s.minDurationSec;
      delete s.maxDurationSec;
      break;
    case "term":
      p.strongTerms = [];
      break;
    case "negative":
      p.valence = null;
      break;
  }
  state.ruleVersion = crypto.randomUUID();
  syncClassifier(); // re-pushes the policy and clears the in-memory decision cache
  await persistRule();
  try {
    await chrome.storage.local.remove(CACHE_KEY); // stale hides for this ruleHash would otherwise reseed
  } catch {
    /* best effort */
  }
  observer.rescan();
  refreshUI();
  log("repaired class", cls, p);
}

function refreshUI() {
  if (control) control.update();
}

// ---- Persistent decision cache (chrome.storage.local), spec §8 ----
const pendingCacheWrites = new Map();
let cacheWriteScheduled = false;

function queuePersist(key, rec) {
  if (!state.settings.persistCache) return;
  pendingCacheWrites.set(key, { ...rec, t: Date.now() });
  if (cacheWriteScheduled) return;
  cacheWriteScheduled = true;
  // One-shot debounce (allowed) — coalesces a burst of decisions into one write.
  setTimeout(flushCacheWrites, 1000);
}

async function flushCacheWrites() {
  cacheWriteScheduled = false;
  if (pendingCacheWrites.size === 0 || !isContextValid()) return;
  const writes = new Map(pendingCacheWrites);
  pendingCacheWrites.clear();
  try {
    const { [CACHE_KEY]: existing } = await chrome.storage.local.get(CACHE_KEY);
    const merged = { ...(existing || {}) };
    for (const [k, v] of writes) merged[k] = v;
    const pruned = pruneCache(merged, { now: Date.now(), ruleHash: state.ruleHash });
    await chrome.storage.local.set({ [CACHE_KEY]: pruned });
  } catch (e) {
    log("cache persist failed", e && e.message);
  }
}

async function loadPersistedCache() {
  if (!state.settings.persistCache || !state.ruleHash) return;
  try {
    const { [CACHE_KEY]: existing } = await chrome.storage.local.get(CACHE_KEY);
    const pruned = pruneCache(existing || {}, { now: Date.now(), ruleHash: state.ruleHash });
    for (const [k, rec] of Object.entries(pruned)) classifier.cache.set(k, { allow: rec.allow, reason: rec.reason });
    if (JSON.stringify(pruned) !== JSON.stringify(existing || {})) {
      await chrome.storage.local.set({ [CACHE_KEY]: pruned });
    }
    log("seeded cache", Object.keys(pruned).length, "entries");
  } catch (e) {
    log("cache load failed", e && e.message);
  }
}

/** Load persisted state from chrome.storage.local, filling defaults. */
async function loadState() {
  const data = await chrome.storage.local.get([...STORAGE_KEYS, "uiPos"]);
  state.ruleText = data.ruleText || "";
  state.ruleHash = data.ruleHash || "";
  state.ruleVersion = data.ruleVersion || "";
  state.compiledPolicy = data.compiledPolicy || null;
  state.enabled = data.enabled !== false;
  state.uiPos = data.uiPos || null;
  state.settings = { ...structuredClone(DEFAULT_SETTINGS), ...(data.settings || {}) };
  state.settings.surfaces = { ...SURFACE_DEFAULTS, ...(data.settings?.surfaces || {}) };
  DEBUG = !!state.settings.debug;
}

/** Push the current compiled policy into the classifier. */
function syncClassifier() {
  if (state.compiledPolicy && state.ruleHash) {
    classifier.setPolicy(state.compiledPolicy, state.ruleHash, state.ruleVersion, aiConfigured());
  }
}

/** Map the strictness setting onto the confidence gate (#2) and affect threshold (#3). */
function applyStrictness() {
  if (!classifier) return;
  const s = state.settings.strictness || DEFAULT_STRICTNESS;
  classifier.minConfidence = STRICTNESS_CONFIDENCE[s] ?? STRICTNESS_CONFIDENCE[DEFAULT_STRICTNESS];
  classifier.affectThreshold = AFFECT_STRICTNESS[s] ?? AFFECT_STRICTNESS[DEFAULT_STRICTNESS];
}

// ---- Channel verdict memory persistence (feature #4) ----
// One debounced snapshot write; a burst of recorded verdicts coalesces into one set().
let channelWriteScheduled = false;
function queueChannelPersist() {
  if (channelWriteScheduled) return;
  channelWriteScheduled = true;
  setTimeout(flushChannelWrite, 1000);
}
async function flushChannelWrite() {
  channelWriteScheduled = false;
  if (!isContextValid() || !classifier) return;
  try {
    await chrome.storage.local.set({ [CHANNEL_KEY]: classifier.channels.toJSON() });
  } catch (e) {
    log("channel persist failed", e && e.message);
  }
}
async function loadChannelStats() {
  if (!state.ruleHash) return;
  try {
    const { [CHANNEL_KEY]: stored } = await chrome.storage.local.get(CHANNEL_KEY);
    if (stored) classifier.channels.load(stored); // load() no-ops unless the ruleHash matches
    log("seeded channel memory", stored && stored.ruleHash === state.ruleHash ? "hit" : "miss");
  } catch (e) {
    log("channel load failed", e && e.message);
  }
}

/**
 * Save a new rule: compile locally + immediately, then replace with the AI
 * compile if a provider is configured and the rule is still current (spec §2).
 */
async function saveUserRule(ruleText) {
  const ruleVersion = crypto.randomUUID();
  const ruleHash = await computeRuleHash(ruleText);
  const localPolicy = { ...compilePolicyLocal(ruleText), ruleHash };

  Object.assign(state, { ruleText, ruleHash, ruleVersion, compiledPolicy: localPolicy });
  state.inert = false;
  syncClassifier();
  await persistRule();
  state.compiling = aiConfigured();
  refreshUI();
  observer.rescan();
  log("rule saved", localPolicy.mode, localPolicy);

  if (aiConfigured()) {
    try {
      const resp = await chrome.runtime.sendMessage({ type: "compilePolicy", ruleText, ruleVersion });
      if (resp && resp.ok && resp.policy && state.ruleVersion === ruleVersion) {
        state.compiledPolicy = { ...resp.policy, ruleHash };
        syncClassifier();
        await persistRule();
        observer.rescan();
        log("AI compile applied", resp.policy);
      }
    } catch (e) {
      log("AI compile failed, keeping local", e && e.message);
    }
  }
  state.compiling = false;
  refreshUI();
}

async function persistRule() {
  await chrome.storage.local.set({
    ruleText: state.ruleText,
    ruleHash: state.ruleHash,
    ruleVersion: state.ruleVersion,
    compiledPolicy: state.compiledPolicy,
  });
}

async function clearRule() {
  Object.assign(state, { ruleText: "", ruleHash: "", ruleVersion: "", compiledPolicy: null });
  state.inert = false;
  if (classifier) classifier.channels.reset(""); // drop the per-rule disposition prior
  await persistRule();
  removeAllAttributes(document); // restore everything
  refreshUI();
}

async function setEnabled(enabled) {
  state.enabled = enabled;
  await chrome.storage.local.set({ enabled });
  if (!enabled) {
    removeAllAttributes(document);
  } else {
    setReveal(document, false);
    state.showAll = false;
    observer.rescan();
  }
  refreshUI();
}

function toggleShowAll() {
  state.showAll = !state.showAll;
  setReveal(document, state.showAll);
  refreshUI();
}

const uiApi = {
  getState: () => ({
    ruleText: state.ruleText,
    enabled: state.enabled,
    statusKey: computeStatusKey(),
    summary: state.compiledPolicy ? state.compiledPolicy.summary : "",
    notes: state.compiledPolicy ? state.compiledPolicy.notes : [],
    hiddenCount: hiddenCount(),
    breakdown: hiddenBreakdown(),
    showAll: state.showAll,
  }),
  apply: (text) => saveUserRule(text),
  clear: () => clearRule(),
  setEnabled: (b) => setEnabled(b),
  toggleShowAll: () => toggleShowAll(),
  repair: (cls) => repairClass(cls),
  getPos: () => state.uiPos,
  setPos: (pos) => {
    state.uiPos = pos;
    chrome.storage.local.set({ uiPos: pos });
  },
};

function onContextInvalidated() {
  log("context invalidated — restoring YouTube");
  try {
    removeAllAttributes(document);
  } catch {
    /* nothing else we can do */
  }
}

/** React to changes made in other tabs / the popup (spec §8). */
function watchStorage() {
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    const touched = STORAGE_KEYS.some((k) => k in changes);
    if (!touched) return;
    const prevVersion = state.ruleVersion;
    await loadState();
    setPendingStyle(document, state.settings.pendingStyle);
    applyStrictness();
    if (state.ruleVersion !== prevVersion || "compiledPolicy" in changes) {
      syncClassifier();
      if (state.enabled) observer.rescan();
      else removeAllAttributes(document);
    }
    if ("enabled" in changes) {
      if (!state.enabled) removeAllAttributes(document);
      else observer.rescan();
    }
    refreshUI();
  });
}

async function init() {
  await loadState();

  classifier = new Classifier({ sendBatch });
  classifier.onStatusChange = () => refreshUI();
  classifier.onCache = (key, rec) => queuePersist(key, rec);
  classifier.onChannel = () => queueChannelPersist();
  applyStrictness();
  syncClassifier();
  await loadPersistedCache();
  await loadChannelStats();

  setPendingStyle(document, state.settings.pendingStyle);

  observer = new YouTubeObserver({
    doc: document,
    classifier,
    isEnabled: () => state.enabled && !state.inert,
    isSurfaceEnabled: (id) => state.settings.surfaces[id] === true,
    getRuleVersion: () => state.ruleVersion,
    getPolicy: () => state.compiledPolicy,
    onHealth: () => {
      state.inert = true;
      removeAllAttributes(document);
      refreshUI();
      log("selector health: going inert");
    },
    isContextValid,
    onContextInvalidated,
  });

  control = new AssistantControl(uiApi);
  mountUIWhenReady();

  observer.start();
  watchStorage();
  refreshUI();
  log("initialized", { enabled: state.enabled, provider: state.settings.provider.id });
}

/** <body> exists by document_idle, but retry on its arrival just in case (no polling loop). */
function mountUIWhenReady() {
  if (control.mount()) return;
  const mo = new MutationObserver(() => {
    if (control.mount()) mo.disconnect();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
}

// Surface any startup failure loudly — a silent init() rejection means no UI.
init().catch((e) => console.error("[YT Personalizer] init failed:", e));

