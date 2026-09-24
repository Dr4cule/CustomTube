import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreAffect, checkAffectRules } from "../src/affect.js";

// ---- scoreAffect: per-category scoring ----

test("benign title scores nothing", () => {
  const { neg, cats } = scoreAffect("cute puppies playing in the garden today");
  assert.equal(neg, 0);
  assert.equal(cats, 0);
});

test("lexicon is ONE category no matter how many words hit", () => {
  // war+death+murder+tragedy all in LEX (3 each) → lexHit 12, but still cats=1.
  const { neg, cats } = scoreAffect("war death murder and tragedy everywhere");
  assert.equal(cats, 1, "many lexicon hits still count as a single category");
  assert.ok(neg >= 12);
});

test("SHOUTING fires as its own category on a long all-caps title", () => {
  const { cats } = scoreAffect("THIS IS THE WORST DISASTER EVER RECORDED");
  // lexicon (worst, disaster) + SHOUTING → two categories.
  assert.ok(cats >= 2);
});

test("short all-caps does NOT trip SHOUTING (needs >=8 letters)", () => {
  const { cats } = scoreAffect("OK GO");
  assert.equal(cats, 0);
});

test("punctuation runs are a category", () => {
  const { cats, neg } = scoreAffect("wait what happened here!!!");
  assert.equal(cats, 1);
  assert.ok(neg >= 2);
});

test("shock emoji is a category", () => {
  const { cats } = scoreAffect("everything is totally fine 💀");
  assert.equal(cats, 1);
});

test("outrage n-gram is a category", () => {
  const { cats, neg } = scoreAffect("he reacts to the news calmly");
  assert.equal(cats, 1);
  assert.ok(neg >= 3);
});

test("multiple independent categories accumulate", () => {
  // lexicon (shocking, disaster) + n-gram (you won't believe) + punct run.
  const { cats, neg } = scoreAffect("shocking disaster you won't believe what happened!!!");
  assert.ok(cats >= 3, `expected >=3 categories, got ${cats}`);
  assert.ok(neg >= 8);
});

// ---- checkAffectRules: gating + multi-feature agreement ----

const POS = { valence: "positive" };

test("does nothing unless the rule's valence is positive", () => {
  const nasty = "shocking disaster you won't believe what happened!!!";
  assert.deepEqual(checkAffectRules({ title: nasty }, { valence: null }, 4), { undecided: true });
  assert.deepEqual(checkAffectRules({ title: nasty }, {}, 4), { undecided: true });
});

test("hides confident rage-bait under a positive-valence rule", () => {
  const r = checkAffectRules({ title: "shocking disaster you won't believe what happened!!!" }, POS, 4);
  assert.deepEqual(r, { hide: true, reason: "affect:negative" });
});

test("single-category negativity fails open (needs >=2 categories)", () => {
  // Heavy lexicon score but only ONE category → must not hide.
  const r = checkAffectRules({ title: "war death murder and tragedy everywhere" }, POS, 4);
  assert.deepEqual(r, { undecided: true });
});

test("below the negativity threshold fails open", () => {
  // "sad" (2) is the only lexicon hit and no other category → neg 2 < 4, cats 1.
  const r = checkAffectRules({ title: "a slightly sad afternoon walk" }, POS, 4);
  assert.deepEqual(r, { undecided: true });
});

test("non-Latin titles are left for the model", () => {
  const r = checkAffectRules({ title: "衝撃の大惨事!!!" }, POS, 4);
  assert.deepEqual(r, { undecided: true });
});

test("titles under 3 words fail open", () => {
  const r = checkAffectRules({ title: "WORST DISASTER!!!" }, POS, 4);
  assert.deepEqual(r, { undecided: true });
});

test("threshold is honored: same title, stricter threshold keeps it visible", () => {
  const title = "wow the worst meltdown ever caught on camera!!!";
  // neg here clears 4 (balanced) but a cautious threshold of 12 should not.
  assert.deepEqual(checkAffectRules({ title }, POS, 4), { hide: true, reason: "affect:negative" });
  assert.deepEqual(checkAffectRules({ title }, POS, 12), { undecided: true });
});

test("missing/blank title fails open", () => {
  assert.deepEqual(checkAffectRules({}, POS, 4), { undecided: true });
  assert.deepEqual(checkAffectRules({ title: "" }, POS, 4), { undecided: true });
});
