import { test } from "node:test";
import assert from "node:assert/strict";
import { compilePolicyLocal } from "../src/policy.js";

test("blocklist: 'No music' hides only music, mode blocklist", () => {
  const p = compilePolicyLocal("No music");
  assert.equal(p.mode, "blocklist");
  assert.ok(p.excludeTopics.includes("music"));
  assert.equal(p.includeTopics.length, 0);
});

test("blocklist: 'Don't show clickbait or reactions'", () => {
  const p = compilePolicyLocal("Don't show clickbait or reactions");
  assert.equal(p.mode, "blocklist");
  assert.ok(p.excludeTopics.includes("clickbait"));
  assert.ok(p.excludeTopics.includes("reaction"));
});

test("allowlist: 'Only show cybersecurity'", () => {
  const p = compilePolicyLocal("Only show programming");
  assert.equal(p.mode, "allowlist");
  assert.ok(p.includeTopics.includes("programming"));
});

test("allowlist: study framing names what to show", () => {
  const p = compilePolicyLocal("I'm studying. Show programming and data structures but block distractors, lofi, or music.");
  assert.equal(p.mode, "allowlist");
  assert.ok(p.includeTopics.includes("programming"));
  assert.ok(p.excludeTopics.includes("music"));
  assert.equal(p.structural.hideShorts, true, "studying → hide shorts shelf");
});

test("excludeTopics always win over includeTopics", () => {
  const p = compilePolicyLocal("Show music but no music");
  assert.ok(p.excludeTopics.includes("music"));
  assert.ok(!p.includeTopics.includes("music"));
});

test("'prioritize X' alone adds a note and is not allowlist", () => {
  const p = compilePolicyLocal("Prioritize programming");
  assert.equal(p.mode, "blocklist");
  assert.ok(p.notes.some((n) => /reorder|prioritize/i.test(n)));
});

test("'prioritize X and hide everything else' → allowlist", () => {
  const p = compilePolicyLocal("Prioritize programming and hide everything else");
  assert.equal(p.mode, "allowlist");
});

test("duration constraints parsed to seconds (hide short under N, hide long over N)", () => {
  const p = compilePolicyLocal("hide videos under 5 minutes and longer than 2 hours");
  assert.equal(p.structural.minDurationSec, 300, "hide videos under 5 min → floor 300s");
  assert.equal(p.structural.maxDurationSec, 7200, "hide videos longer than 2h → ceiling 7200s");
});

test("keep-intent duration: 'only videos longer than 10 minutes' → floor", () => {
  const p = compilePolicyLocal("show only videos longer than 10 minutes");
  assert.equal(p.structural.minDurationSec, 600);
  assert.equal(p.structural.maxDurationSec, undefined);
});

test("summary and strongTerms populated for excluded music", () => {
  const p = compilePolicyLocal("hide music");
  assert.ok(p.summary.length > 0);
  assert.ok(p.strongTerms.includes("official music video"));
});

test("negated 'want' is a blocklist exclude, not an allowlist include", () => {
  const p = compilePolicyLocal("i dont want to see any music please");
  assert.equal(p.mode, "blocklist", "must not invert to show-only-music");
  assert.ok(p.excludeTopics.includes("music"));
  assert.equal(p.includeTopics.length, 0);
  assert.equal(p.structural.hideShorts, false, "must not spuriously hide Shorts");
});

test("common negative phrasings exclude the topic", () => {
  for (const rule of ["stop showing me reactions", "i'm sick of clickbait", "get rid of gaming", "no more music"]) {
    const p = compilePolicyLocal(rule);
    assert.equal(p.mode, "blocklist", rule);
    assert.ok(p.excludeTopics.length > 0, rule);
  }
});

test("word-boundary markers: 'piano' does not trigger the 'no' negation", () => {
  const p = compilePolicyLocal("i want piano music");
  assert.ok(!p.excludeTopics.includes("music"), "'piano' must not read as 'no' → hide music");
});

test("word-boundary topics: 'physics' is not the 'cs' programming topic", () => {
  const p = compilePolicyLocal("hide physics");
  assert.ok(!p.excludeTopics.includes("programming"), "'physics' must not match 'cs'");
});

test("intra-clause 'and' keeps each half's own polarity", () => {
  const p = compilePolicyLocal("show programming and hide music");
  assert.ok(p.includeTopics.includes("programming"), "'show programming' half → include");
  assert.ok(p.excludeTopics.includes("music"), "'hide music' half → exclude");
});

test("duration in seconds parsed correctly", () => {
  const p = compilePolicyLocal("hide videos under 30 seconds");
  assert.equal(p.structural.minDurationSec, 30);
});

// ---- Feature #1: valence (keep-neutral) ----

test("positivity rule with no topics → blocklist, not an empty allowlist", () => {
  const p = compilePolicyLocal("only show me positive uplifting videos");
  assert.equal(p.valence, "positive");
  assert.equal(p.mode, "blocklist", "must NOT become an empty allowlist that blanks the feed");
  assert.equal(p.includeTopics.length, 0);
  assert.ok(p.notes.some((n) => /positiv/i.test(n)));
  assert.ok(/positive|negative/i.test(p.summary));
});

test("negated negativity ('no more doom and rage bait') reads as positive valence", () => {
  const p = compilePolicyLocal("no more doom and rage bait");
  assert.equal(p.valence, "positive");
});

test("topic word 'drama' does NOT trigger valence (topic rule, not mood rule)", () => {
  const p = compilePolicyLocal("hide celebrity drama");
  assert.equal(p.valence, null, "'drama' is a celebrity-topic cue, not a mood cue");
  assert.ok(p.excludeTopics.includes("celebrity"));
});

test("positivity WITH a concrete topic keeps the allowlist (topic wins)", () => {
  const p = compilePolicyLocal("only show uplifting cooking videos");
  assert.equal(p.valence, "positive");
  assert.equal(p.mode, "allowlist");
  assert.ok(p.includeTopics.includes("cooking"));
});
