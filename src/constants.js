/**
 * Centralized constants for YouTube Personalizer.
 * Pure data + no chrome.* references, so this module imports cleanly in Node tests.
 */

export const ATTR = "data-ytp";
export const REVEAL_ATTR = "data-ytp-reveal";
/** Per-card hide-reason class for the why-hidden tray (feature #7). */
export const WHY_ATTR = "data-ytp-why";

/** Debug default; the popup toggle overrides this at runtime via settings. */
export const DEBUG_DEFAULT = false;

/** Timeouts, caps and guards. */
export const REQUEST_TIMEOUT_MS = 8000;
export const MAX_BATCH = 20;
export const MAX_CONCURRENT_BATCHES = 2;
export const LRU_CAP = 5000;
export const PERSIST_CACHE_CAP = 5000;
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const CIRCUIT_FAILURE_THRESHOLD = 5;
export const CIRCUIT_OPEN_MS = 5 * 60 * 1000; // 5 minutes
export const DEFAULT_RPM = 30;
export const DEFAULT_RPD = 500;
export const FLUSH_TIME_BUDGET_MS = 8;
export const TITLE_MAX = 200;
export const CHANNEL_MAX = 80;
export const RETRY_BASE_MS = 400;

/**
 * Confidence-gated hiding (feature #2). A semantic hide is honored only when the
 * model's confidence clears the strictness threshold; below it the card fails open.
 * Higher confidence requirement = "cautious" = hides less.
 */
export const STRICTNESS_CONFIDENCE = Object.freeze({ cautious: 0.9, balanced: 0.6, aggressive: 0.3 });
export const DEFAULT_STRICTNESS = "balanced";

/**
 * Local affect prefilter (feature #3). Minimum weighted-negativity magnitude, by
 * strictness, before a title may be hidden locally. Higher = hides less.
 */
export const AFFECT_STRICTNESS = Object.freeze({ cautious: 6, balanced: 4, aggressive: 3 });

/**
 * Valence detection for the LOCAL compiler (feature #1). If the rule asks for
 * positive/uplifting content — or asks to be rid of negativity — we compile a
 * "keep-neutral" blocklist (hide confident-negative) instead of a strict
 * allowlist that would blank the whole feed. Topic words like "drama" are
 * deliberately absent so a topic rule never reads as a mood rule.
 */
export const POSITIVITY_CUES = Object.freeze([
  "positive", "positivity", "uplifting", "wholesome", "feel good", "feel-good", "feelgood",
  "good vibes", "happy", "cheerful", "optimistic", "heartwarming", "motivational", "motivating",
  "inspiring", "inspirational", "good news", "calming", "relaxing", "soothing", "wholesome content",
]);
export const NEGATIVITY_CUES = Object.freeze([
  "negativity", "negative", "doom", "doomscroll", "doomscrolling", "rage bait", "ragebait", "rage-bait",
  "outrage", "toxic", "toxicity", "depressing", "fear mongering", "fearmongering", "fear-mongering",
  "misery", "gloom", "despair", "pessimistic",
]);

/**
 * Channel verdict memory (feature #4). A per-(rule,channel) prior short-circuits the
 * model once enough confident verdicts agree (Wilson lower bound clears CONFIDENCE).
 */
export const CHANNEL_MIN_SAMPLES = 4;    // need this many confident verdicts before trusting
// Wilson (z=1.96) lower bound the majority must clear. Must be REACHABLE under the
// MAX_COUNT cap below: all-agree LB is n/(n+3.84), which maxes at ~0.84 for n=20, so
// a 0.9 bar could never fire. 0.7 → trusts a channel after ~9 agreeing confident
// verdicts, still resisting a 4-streak (LB 0.51) or 8-streak (0.68).
export const CHANNEL_CONFIDENCE = 0.7;
export const CHANNEL_MAX_COUNT = 20;     // per-side cap; halved on overflow so an early streak can't entrench
export const CHANNEL_RECORD_CONF = 0.8;  // only verdicts this confident feed the prior

/** Default per-surface enablement (spec §1). */
export const SURFACE_DEFAULTS = Object.freeze({
  home: true,
  watch: true,
  subscriptions: false,
  search: false,
});

/**
 * Per-surface DOM config. Selector lists are tried in order (fallbacks).
 * Supports both legacy renderers and newer lockup view-model markup.
 * `match(url)` decides which surface a location belongs to.
 */
export const SURFACES = Object.freeze({
  home: {
    id: "home",
    label: "Home",
    match: (u) => u.pathname === "/" || u.pathname === "/feed/trending",
    cardSelectors: [
      "ytd-rich-item-renderer",
      "yt-lockup-view-model",
      "ytd-video-renderer",
    ],
    shortsShelfSelectors: [
      "ytd-rich-shelf-renderer[is-shorts]",
      "ytd-reel-shelf-renderer",
      "grid-shelf-view-model",
    ],
  },
  watch: {
    id: "watch",
    label: "Watch sidebar",
    match: (u) => u.pathname === "/watch",
    cardSelectors: [
      "ytd-compact-video-renderer",
      "yt-lockup-view-model",
      "ytd-compact-radio-renderer",
    ],
    shortsShelfSelectors: ["ytd-reel-shelf-renderer"],
  },
  subscriptions: {
    id: "subscriptions",
    label: "Subscriptions",
    match: (u) => u.pathname === "/feed/subscriptions",
    cardSelectors: [
      "ytd-rich-item-renderer",
      "yt-lockup-view-model",
      "ytd-video-renderer",
    ],
    shortsShelfSelectors: ["ytd-rich-shelf-renderer[is-shorts]", "ytd-reel-shelf-renderer"],
  },
  search: {
    id: "search",
    label: "Search",
    match: (u) => u.pathname === "/results",
    cardSelectors: [
      "ytd-video-renderer",
      "yt-lockup-view-model",
      "ytd-rich-item-renderer",
    ],
    shortsShelfSelectors: ["ytd-reel-shelf-renderer", "ytd-shorts-shelf-renderer"],
  },
});

/** Surfaces we never touch, for documentation/guarding. */
export const NEVER_TOUCH_PATHS = ["/channel/", "/@", "/playlist", "/c/", "/user/"];

/**
 * Selectors used to read a card's fields, tried in order (first non-empty wins).
 * Two markup generations coexist: newer camelCase view-model classes
 * (`ytLockupMetadataViewModelTitle`, `ytContentMetadataViewModelMetadataText`,
 * `ytBadgeShapeText`) on home/watch/subscriptions lockups, and the older
 * `#video-title` / `ytd-channel-name` / `-wiz` markup still used by search's
 * `ytd-video-renderer`. Both kept so every surface resolves. Verified live 2026-09-24.
 */
export const FIELD_SELECTORS = Object.freeze({
  title: [
    // newer lockup view-model (home/watch/subscriptions)
    "a.ytLockupMetadataViewModelTitle",
    ".ytLockupMetadataViewModelTitle",
    "h3.ytLockupMetadataViewModelHeadingReset",
    // older / search markup
    "#video-title",
    "a#video-title-link",
    "yt-formatted-string#video-title",
    ".yt-lockup-metadata-view-model-wiz__title",
    "h3 a .yt-core-attributed-string",
    "h3 span.yt-core-attributed-string",
  ],
  channel: [
    // older / search markup (a real channel link)
    "ytd-channel-name #text a",
    "ytd-channel-name #text",
    "#channel-name #text",
    // newer lockup: channel is the FIRST metadata-text span (a plain span, not a link);
    // on our surfaces row 0 is always the channel. querySelector returns it first in DOM order.
    ".ytLockupMetadataViewModelMetadata .ytContentMetadataViewModelMetadataText",
    ".ytContentMetadataViewModelMetadataText",
    ".yt-content-metadata-view-model-wiz__metadata-row a",
    ".yt-content-metadata-view-model-wiz__metadata-row span",
  ],
  link: [
    "a.ytLockupMetadataViewModelTitle",
    "a#video-title-link",
    "a#thumbnail",
    "a.ytLockupViewModelContentImage",
    "a.yt-lockup-view-model-wiz__content-image",
    "a.yt-simple-endpoint[href]",
    "a[href*='/watch']",
    "a[href*='/shorts/']",
  ],
  duration: [
    "badge-shape .ytBadgeShapeText",
    ".ytBadgeShapeText",
    "ytd-thumbnail-overlay-time-status-renderer #text",
    "ytd-thumbnail-overlay-time-status-renderer span",
    "badge-shape .yt-badge-shape__text",
    ".yt-badge-shape__text",
    ".badge-shape-wiz__text",
    ".ytd-thumbnail-overlay-time-status-renderer",
    "thumbnail-overlay-badge-view-model .badge-shape-wiz__text",
  ],
});

/**
 * Curated topic lexicon for the LOCAL heuristic compiler.
 * Maps a canonical topic to the phrases that, when found in the rule text,
 * mean "the user is talking about this topic". This never classifies videos;
 * it only interprets the rule the user typed. Order-insensitive.
 */
export const TOPIC_LEXICON = Object.freeze({
  music: ["music", "songs", "song", "musician", "album", "playlist", "lofi", "lo-fi", "beats"],
  gaming: ["gaming", "gameplay", "video games", "videogames", "gamer", "let's play", "lets play", "esports", "speedrun"],
  shorts: ["shorts", "short-form", "short form", "reels"],
  news: ["news", "breaking news", "headlines", "current events"],
  politics: ["politics", "political", "election", "government", "policy debate"],
  celebrity: ["celebrity", "celebrities", "gossip", "drama", "tabloid", "kardashian"],
  reaction: ["reaction", "reactions", "reacts", "reacting"],
  clickbait: ["clickbait", "click bait", "clickbaity"],
  sports: ["sports", "sport", "football", "soccer", "basketball", "nba", "nfl", "highlights"],
  comedy: ["comedy", "memes", "meme", "funny", "humor", "humour", "skits", "stand-up", "standup"],
  entertainment: ["entertainment", "vlogs", "vlog", "lifestyle", "prank", "pranks"],
  programming: ["programming", "coding", "software", "developer", "dev", "code", "cs", "computer science", "algorithms", "data structures", "leetcode", "web development", "backend", "frontend", "linux", "kernel", "operating system", "compiler", "database", "networking", "devops"],
  education: ["education", "educational", "study", "studying", "learning", "lectures", "tutorial", "tutorials", "science", "math", "mathematics", "physics"],
  cooking: ["cooking", "recipe", "recipes", "food", "baking"],
  tech: ["tech", "technology", "gadgets", "reviews", "unboxing"],
});

/**
 * Strong exclude phrases for the deterministic BASELINE layer.
 * Only unambiguous phrases live here — they may hide a video locally with no AI.
 * Ambiguous single words ("mix", "audio", "live", "python", "beats") are intentionally absent.
 */
export const STRONG_TERMS = Object.freeze({
  music: [
    "official music video",
    "official video",
    "official audio",
    "lyric video",
    "lyrics video",
    "official lyric",
    "lofi hip hop",
    "lo-fi hip hop",
    "karaoke",
    "full album",
    "official visualizer",
  ],
  gaming: ["gameplay walkthrough", "no commentary gameplay", "full gameplay", "speedrun world record"],
  reaction: ["reaction video", "reacts to", "reacting to"],
  clickbait: ["you won't believe", "you wont believe", "gone wrong", "gone sexual", "*emotional*"],
  shorts: ["#shorts"],
});

/** Negation / inclusion phrase markers for the local compiler (spec §2). */
export const NEGATION_MARKERS = Object.freeze([
  "no ", "don't show", "dont show", "do not show", "hide", "block", "skip", "avoid", "without", "except", "not ", "less ",
  // Negation is tested before inclusion, so these override a co-occurring "want"/"show"
  // in the same clause ("i dont want to see music" → exclude, not the inverse).
  "don't", "dont", "do not", "never", "stop showing", "stop recommending", "rid of", "tired of", "sick of", "no more", "hate ",
]);
export const INCLUSION_MARKERS = Object.freeze([
  "show ", "only ", "want ", "about ", "prioritize", "prioritise", "focus on", "give me", "i want",
]);
export const ALLOWLIST_TRIGGERS = Object.freeze(["everything else", "only ", "nothing but", "just ", "exclusively"]);

/** Shared status vocabulary for the masthead control and the popup (spec §10). */
export const STATUS_LABELS = Object.freeze({
  active: { text: "Active", dot: "#2ba640" },
  paused: { text: "Paused", dot: "#909090" },
  compiling: { text: "Compiling…", dot: "#f1c40f" },
  local: { text: "Local rules only", dot: "#3ea6ff" },
  aiDown: { text: "AI unavailable, using local rules", dot: "#f39c12" },
  budget: { text: "Budget reached, using local rules", dot: "#f39c12" },
  selectors: { text: "Selectors need an update", dot: "#e74c3c" },
});

