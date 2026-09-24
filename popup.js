/**
 * Popup: provider config, surface toggles, behavior settings, budget caps,
 * clear-data, and a live status readout. Writes settings (WITHOUT the key) and
 * the API key separately; the key is only ever read by the service worker.
 */
import { STATUS_LABELS, SURFACE_DEFAULTS, DEFAULT_RPM, DEFAULT_RPD, DEFAULT_STRICTNESS } from "./src/constants.js";
import { GEMINI_PRESET, OPENROUTER_PRESET } from "./providers.js";

const $ = (id) => document.getElementById(id);
const SURFACE_IDS = ["home", "watch", "subscriptions", "search"];

/** One-click backends that prefill Base URL + Model. */
const PRESETS = { gemini: GEMINI_PRESET, openrouter: OPENROUTER_PRESET };

const DEFAULT_SETTINGS = {
  surfaces: { ...SURFACE_DEFAULTS },
  pendingStyle: "dim",
  persistCache: true,
  debug: false,
  strictness: DEFAULT_STRICTNESS,
  provider: { id: "none", baseURL: "", model: "" },
  budget: { rpm: DEFAULT_RPM, rpd: DEFAULT_RPD },
};

let settings = structuredClone(DEFAULT_SETTINGS);

async function load() {
  const data = await chrome.storage.local.get(["settings", "apiKey", "enabled", "ruleText", "compiledPolicy"]);
  settings = { ...structuredClone(DEFAULT_SETTINGS), ...(data.settings || {}) };
  settings.surfaces = { ...SURFACE_DEFAULTS, ...(data.settings?.surfaces || {}) };
  settings.provider = { ...DEFAULT_SETTINGS.provider, ...(data.settings?.provider || {}) };
  settings.budget = { ...DEFAULT_SETTINGS.budget, ...(data.settings?.budget || {}) };

  $("providerId").value = settings.provider.id;
  $("baseURL").value = settings.provider.baseURL || "";
  $("model").value = settings.provider.model || "";
  $("apiKey").value = data.apiKey || "";
  for (const s of SURFACE_IDS) $(`surface-${s}`).checked = settings.surfaces[s] === true;
  $("pendingStyle").value = settings.pendingStyle;
  $("strictness").value = settings.strictness || DEFAULT_STRICTNESS;
  $("rpm").value = settings.budget.rpm;
  $("rpd").value = settings.budget.rpd;
  $("persistCache").checked = settings.persistCache !== false;
  $("debug").checked = !!settings.debug;

  const policy = data.compiledPolicy;
  $("ruleSummary").textContent = data.ruleText
    ? (policy && policy.summary ? policy.summary : data.ruleText)
    : "No rule set. Open YouTube and click the personalize icon next to the mic in the search bar.";

  toggleProviderFields();
  await refreshStatus(data.enabled !== false);
  await refreshPerm();
}

function toggleProviderFields() {
  const id = $("providerId").value;
  $("providerFields").hidden = id === "none";
  $("geminiHelp").hidden = id !== "gemini";
  $("openrouterHelp").hidden = id !== "openrouter";
}

/** User picked a backend: prefill preset fields, then persist. */
function onProviderChange() {
  const preset = PRESETS[$("providerId").value];
  if (preset) {
    $("baseURL").value = preset.baseURL;
    $("model").value = preset.model;
  }
  save();
}

function collect() {
  return {
    surfaces: Object.fromEntries(SURFACE_IDS.map((s) => [s, $(`surface-${s}`).checked])),
    pendingStyle: $("pendingStyle").value,
    strictness: $("strictness").value,
    persistCache: $("persistCache").checked,
    debug: $("debug").checked,
    provider: {
      id: $("providerId").value,
      baseURL: $("baseURL").value.trim(),
      model: $("model").value.trim(),
    },
    budget: {
      rpm: clampInt($("rpm").value, 1, 600, DEFAULT_RPM),
      rpd: clampInt($("rpd").value, 1, 100000, DEFAULT_RPD),
    },
  };
}

function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

async function save() {
  settings = collect();
  await chrome.storage.local.set({ settings }); // NEVER contains the key
  const key = $("apiKey").value;
  await chrome.storage.local.set({ apiKey: key || "" });
  toggleProviderFields();
  await refreshStatus();
  await refreshPerm();
}

async function refreshStatus(enabledArg) {
  const { enabled } = enabledArg === undefined ? await chrome.storage.local.get("enabled") : { enabled: enabledArg };
  const { ypCounters } = await chrome.storage.session.get("ypCounters");
  const c = ypCounters || {};
  const now = Date.now();
  let key = "active";
  if (enabled === false) key = "paused";
  else if (c.openUntil && now < c.openUntil) key = "aiDown";
  else if ((c.minuteCount || 0) >= (settings.budget.rpm || DEFAULT_RPM) || (c.dayCount || 0) >= (settings.budget.rpd || DEFAULT_RPD)) key = "budget";
  else if (settings.provider.id === "none") key = "local";
  const label = STATUS_LABELS[key] || STATUS_LABELS.paused;
  $("statusDot").style.background = label.dot;
  $("statusText").textContent = label.text;
}

async function refreshPerm() {
  const origin = originPattern();
  if (!origin) {
    $("permState").textContent = "";
    return;
  }
  const granted = await chrome.permissions.contains({ origins: [origin] });
  $("permState").textContent = granted ? "Access granted for this endpoint." : "Access not yet granted — click the button above.";
}

function originPattern() {
  const url = $("baseURL").value.trim();
  if (!url) return null;
  try {
    return new URL(url).origin + "/*";
  } catch {
    return null;
  }
}

async function requestPermission() {
  const origin = originPattern();
  if (!origin) {
    $("permState").textContent = "Enter a valid Base URL first.";
    return;
  }
  try {
    const granted = await chrome.permissions.request({ origins: [origin] });
    $("permState").textContent = granted ? "Access granted." : "Access denied.";
  } catch (e) {
    $("permState").textContent = "Request failed: " + (e && e.message);
  }
}

async function clearData() {
  await chrome.storage.local.remove("cache");
  await chrome.storage.session.remove("ypCounters");
  $("clearData").textContent = "Cleared";
  setTimeout(() => ($("clearData").textContent = "Clear cached decisions"), 1500);
  await refreshStatus();
}

function wire() {
  for (const id of ["baseURL", "model", "pendingStyle", "strictness", "rpm", "rpd", "persistCache", "debug",
    ...SURFACE_IDS.map((s) => `surface-${s}`)]) {
    $(id).addEventListener("change", save);
  }
  $("providerId").addEventListener("change", onProviderChange);
  $("apiKey").addEventListener("change", save);
  $("requestPerm").addEventListener("click", requestPermission);
  $("clearData").addEventListener("click", clearData);
}

wire();
load();
