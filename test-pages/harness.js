/**
 * Test harness (module). Wires the real extension modules against a fixture page
 * with a stub provider, so the observer/metadata/apply/classify pipeline runs
 * exactly as in-page — minus chrome.* — for manual and Playwright verification.
 */
import { compilePolicyLocal, computeRuleHash } from "/src/policy.js";
import { Classifier } from "/src/classify.js";
import { YouTubeObserver } from "/src/observer.js";
import { AssistantControl } from "/src/ui.js";
import { setPendingStyle, removeAllAttributes } from "/src/apply.js";
import { extractVideoMetadata } from "/src/metadata.js";
import { checkBaselineRules } from "/src/baseline.js";

const state = {
  ruleText: "",
  ruleVersion: "",
  ruleHash: "",
  policy: null,
  enabled: true,
  failMode: null,
  surfaces: { home: true, watch: true, subscriptions: true, search: true },
};

async function sendBatch(payload, meta) {
  const q = state.failMode ? `?mode=${state.failMode}` : "";
  try {
    const res = await fetch("/v1/chat/completions" + q, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "stub", messages: [{ role: "system", content: "c" }, { role: "user", content: JSON.stringify(payload) }] }),
    });
    if (!res.ok) return { ok: false, ruleVersion: meta.ruleVersion, status: {} };
    const data = await res.json();
    return { ok: true, results: data.choices[0].message.content, ruleVersion: meta.ruleVersion, status: {} };
  } catch {
    return { ok: false, ruleVersion: meta.ruleVersion, status: {} };
  }
}

const classifier = new Classifier({ sendBatch });

const observer = new YouTubeObserver({
  doc: document,
  classifier,
  isEnabled: () => state.enabled,
  isSurfaceEnabled: (id) => state.surfaces[id] === true,
  getRuleVersion: () => state.ruleVersion,
  getPolicy: () => state.policy,
  onHealth: () => (window.__ytpHealth = "selectors"),
  isContextValid: () => window.__ytpContextValid !== false,
  onContextInvalidated: () => {
    window.__ytpInvalidated = true;
    removeAllAttributes(document); // mirror main.js: fully restore YouTube
  },
});

async function applyRule(text) {
  state.ruleText = text;
  state.ruleVersion = crypto.randomUUID();
  state.ruleHash = await computeRuleHash(text);
  state.policy = { ...compilePolicyLocal(text), ruleHash: state.ruleHash };
  classifier.setPolicy(state.policy, state.ruleHash, state.ruleVersion, true);
  observer.rescan();
}

const control = new AssistantControl({
  getState: () => ({
    ruleText: state.ruleText,
    enabled: state.enabled,
    statusKey: state.enabled ? "active" : "paused",
    summary: state.policy ? state.policy.summary : "",
    notes: state.policy ? state.policy.notes : [],
    hiddenCount: document.querySelectorAll('[data-ytp="hidden"]').length,
    showAll: false,
  }),
  apply: (t) => applyRule(t),
  clear: () => {
    state.policy = null;
    document.querySelectorAll("[data-ytp]").forEach((e) => e.removeAttribute("data-ytp"));
  },
  setEnabled: (b) => {
    state.enabled = b;
    if (!b) document.querySelectorAll("[data-ytp]").forEach((e) => e.removeAttribute("data-ytp"));
    else observer.rescan();
  },
  toggleShowAll: () => document.documentElement.toggleAttribute("data-ytp-reveal"),
});

setPendingStyle(document, "dim");
control.mount();
observer.start();

// Driving API for tests / manual use.
window.__ytp = {
  applyRule,
  setFailMode: (m) => (state.failMode = m),
  navigate: (path) => {
    history.pushState({}, "", path);
    document.dispatchEvent(new CustomEvent("yt-navigate-finish"));
  },
  invalidate: () => {
    window.__ytpContextValid = false;
    document.dispatchEvent(new CustomEvent("yt-navigate-finish")); // triggers a guarded pass
  },
  hiddenCount: () => document.querySelectorAll('[data-ytp="hidden"]').length,
  observer,
  classifier,
  extract: (testid) => extractVideoMetadata(document.querySelector(`[data-testid="${testid}"]`)),
  baseline: (testid) => checkBaselineRules(extractVideoMetadata(document.querySelector(`[data-testid="${testid}"]`)), state.policy),
  state,
};
