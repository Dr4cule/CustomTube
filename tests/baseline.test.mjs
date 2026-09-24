import { test } from "node:test";
import assert from "node:assert/strict";
import { compilePolicyLocal } from "../src/policy.js";
import { checkBaselineRules, checkStructuralRules } from "../src/baseline.js";

const musicPolicy = compilePolicyLocal("hide music");

test("baseline HIDES strong, unambiguous music signals", () => {
  assert.equal(checkBaselineRules({ title: "Adele - Hello (Official Music Video)", channel: "AdeleVEVO" }, musicPolicy).hide, true);
  assert.equal(checkBaselineRules({ title: "Best of 2024 (Full Album)", channel: "X" }, musicPolicy).hide, true);
  assert.equal(checkBaselineRules({ title: "Karaoke - My Way", channel: "Sing" }, musicPolicy).hide, true);
});

test("baseline is UNDECIDED on ambiguous words (mix, audio, live, python, beats)", () => {
  for (const title of [
    "Chill Mix for coding",
    "Raw audio from the interview",
    "Live Q&A about databases",
    "Python tutorial: dictionaries",
    "Lofi Beats to Study To",
  ]) {
    assert.deepEqual(checkBaselineRules({ title, channel: "c" }, musicPolicy), { undecided: true }, title);
  }
});

test("baseline never returns allow, only hide or undecided", () => {
  const r = checkBaselineRules({ title: "How Graph Algorithms Work", channel: "CS" }, musicPolicy);
  assert.ok(!("allow" in r));
  assert.deepEqual(r, { undecided: true });
});

test("baseline skips non-Latin titles → undecided", () => {
  assert.deepEqual(checkBaselineRules({ title: "公式ミュージックビデオ", channel: "x" }, musicPolicy), { undecided: true });
});

test("baseline diacritic-insensitive", () => {
  assert.equal(checkBaselineRules({ title: "Café - Official Músic Vídeo", channel: "x" }, musicPolicy).hide, true);
});

test("structural: shorts, live, duration bounds", () => {
  const p = compilePolicyLocal("no shorts, no live, hide videos under 3 minutes");
  assert.equal(checkStructuralRules({ isShort: true }, p).hide, true);
  assert.equal(checkStructuralRules({ live: true }, p).hide, true);
  assert.equal(checkStructuralRules({ durationSec: 120 }, p).hide, true);
  assert.equal(checkStructuralRules({ durationSec: 600 }, p), null);
});

test("structural: music badge hides when the rule excludes music", () => {
  const hideMusic = compilePolicyLocal("hide music");
  assert.equal(checkStructuralRules({ isMusic: true }, hideMusic).reason, "structural:music-badge");
  // Allowlist that doesn't include music → music is implicitly excluded → hide.
  const only = compilePolicyLocal("only show programming");
  assert.equal(checkStructuralRules({ isMusic: true }, only).hide, true);
});

test("structural: music badge is ignored when the rule doesn't touch music", () => {
  const hideGaming = compilePolicyLocal("hide gaming");
  assert.equal(checkStructuralRules({ isMusic: true }, hideGaming), null);
  // Allowlist that includes music must keep music.
  const onlyMusic = compilePolicyLocal("only show music");
  assert.equal(checkStructuralRules({ isMusic: true }, onlyMusic), null);
});
