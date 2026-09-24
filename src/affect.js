/**
 * Local affect + typographic prefilter (feature #3). Pure, synchronous, ZERO egress:
 * scores a title's negativity from a small CURATED lexicon plus typographic tells
 * (SHOUTING, punctuation runs, shock emoji, outrage n-grams). Used only when the
 * rule's valence is "positive", to hide the obvious rage-bait for free before any AI.
 *
 * ponytail: curated ~90-word lexicon, not full AFINN-165. Upgrade path: swap LEX for
 * a vendored AFINN map (word→[-5..5], keep the negatives) if precision needs it.
 */
import { normalizeText, isLatinScript, phraseIncludes } from "./text.js";

/** Curated negative-affect terms → weight (2 = negative, 3 = strongly negative). */
const LEX = Object.freeze({
  // strongly negative
  hate: 3, kill: 3, killed: 3, dead: 3, death: 3, murder: 3, war: 3, tragedy: 3, tragic: 3,
  disaster: 3, horror: 3, horrifying: 3, brutal: 3, violent: 3, violence: 3, destroy: 3, destroyed: 3,
  outrage: 3, outrageous: 3, furious: 3, terrifying: 3, terror: 3, nightmare: 3, apocalypse: 3,
  crisis: 3, catastrophe: 3, devastating: 3, devastated: 3, shocking: 3, disgusting: 3, toxic: 3,
  cruel: 3, cruelty: 3, abuse: 3, scam: 3, fraud: 3, panic: 3, doom: 3, rage: 3, slams: 3, slammed: 3,
  // negative
  angry: 2, anger: 2, sad: 2, crying: 2, cries: 2, tears: 2, fear: 2, scared: 2, afraid: 2,
  worst: 2, awful: 2, terrible: 2, horrible: 2, disturbing: 2, creepy: 2, painful: 2, pain: 2,
  suffering: 2, miserable: 2, misery: 2, depressing: 2, depressed: 2, gloom: 2, despair: 2,
  betrayed: 2, betrayal: 2, ruined: 2, ruins: 2, collapse: 2, chaos: 2, warning: 2, danger: 2,
  dangerous: 2, threat: 2, attack: 2, attacked: 2, exposed: 2, humiliated: 2, embarrassing: 2,
  cringe: 2, meltdown: 2, feud: 2, backlash: 2, controversy: 2, controversial: 2,
});

/** Outrage / clickbait n-grams (phrase-matched on the normalized title). */
const NGRAMS = Object.freeze([
  "you won't believe", "you wont believe", "gone wrong", "gone too far", "caught on camera",
  "destroys", "owned", "obliterated", "reacts to", "exposed for", "worst ever", "goes off",
  "loses it", "breaks down", "you need to see", "what happened next", "will shock you",
]);

/** Shock / outrage emoji. */
const SHOCK_EMOJI = /[\u{1F621}\u{1F620}\u{1F92C}\u{1F631}\u{1F628}\u{1F62D}\u{1F92F}\u{1F480}\u{1F494}\u{1F915}\u{1F922}]/u;

/**
 * Score a raw title. Returns weighted negativity `neg` and the count of distinct
 * feature CATEGORIES that fired (`cats`) — used to require multi-feature agreement.
 * @param {string} rawTitle
 * @returns {{neg:number, cats:number}}
 */
export function scoreAffect(rawTitle) {
  const raw = typeof rawTitle === "string" ? rawTitle : "";
  const norm = normalizeText(raw);
  let neg = 0;
  let cats = 0;

  // 1. Curated lexicon (one category no matter how many words hit).
  let lexHit = 0;
  for (const [word, w] of Object.entries(LEX)) {
    if (phraseIncludes(norm, word)) lexHit += w;
  }
  if (lexHit > 0) { neg += lexHit; cats++; }

  // 2. SHOUTING: high uppercase ratio over a title long enough to mean it.
  const letters = raw.match(/\p{L}/gu) || [];
  const upper = raw.match(/\p{Lu}/gu) || [];
  if (letters.length >= 8 && upper.length / letters.length >= 0.6) { neg += 2; cats++; }

  // 3. Punctuation runs (!!!, ???, !?, ?!).
  if (/([!?])\1{1,}|!\?|\?!/.test(raw)) { neg += 2; cats++; }

  // 4. Shock emoji.
  if (SHOCK_EMOJI.test(raw)) { neg += 2; cats++; }

  // 5. Outrage n-grams.
  if (NGRAMS.some((p) => phraseIncludes(norm, p))) { neg += 3; cats++; }

  return { neg, cats };
}

/**
 * Local hide decision for the affect layer. Only fires for positive-valence rules,
 * on Latin-script titles of ≥3 words, and only when the negativity clears `threshold`
 * AND at least two independent feature categories agree (prevents lone-word misfires).
 * @param {{title?:string}} meta
 * @param {import('./policy.js').CompiledPolicy} policy
 * @param {number} threshold
 * @returns {{hide:true, reason:string}|{undecided:true}}
 */
export function checkAffectRules(meta, policy, threshold) {
  if (!policy || policy.valence !== "positive") return { undecided: true };
  const title = (meta && meta.title) || "";
  if (!isLatinScript(title)) return { undecided: true };
  if (normalizeText(title).split(" ").filter(Boolean).length < 3) return { undecided: true };

  const { neg, cats } = scoreAffect(title);
  if (neg >= threshold && cats >= 2) return { hide: true, reason: "affect:negative" };
  return { undecided: true };
}
