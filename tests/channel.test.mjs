import { test } from "node:test";
import assert from "node:assert/strict";
import { wilsonLower, ChannelMemory } from "../src/channel.js";
import { CHANNEL_CONFIDENCE } from "../src/constants.js";

// ---- wilsonLower: conservative, streak-resistant, and REACHABLE ----

test("wilsonLower stays below the trust bar for short streaks", () => {
  assert.equal(wilsonLower(0, 0), 0);
  assert.ok(wilsonLower(2, 2) < CHANNEL_CONFIDENCE, "a 2/2 streak must not clear the bar");
  assert.ok(wilsonLower(4, 4) < CHANNEL_CONFIDENCE, "a 4/4 streak must not clear the bar");
});

test("wilsonLower is actually reachable under the count cap (regression: 0.9 never fired)", () => {
  // With the per-side cap of 20, n tops out ~20; a 0.9 bar (needs n>=35) could never fire.
  assert.ok(wilsonLower(9, 9) >= CHANNEL_CONFIDENCE, "~9 agreeing verdicts should clear the bar");
});

// ---- decide: sample floor, confidence gate, majority side ----

test("decide abstains below the sample floor", () => {
  const m = new ChannelMemory();
  m.reset("rule-A");
  m.record("Doom News", false);
  m.record("Doom News", false);
  m.record("Doom News", false); // n=3 < minSamples(4)
  assert.equal(m.decide("Doom News"), null);
});

test("decide trusts a channel after enough agreeing confident verdicts", () => {
  const m = new ChannelMemory();
  m.reset("rule-A");
  for (let i = 0; i < 9; i++) m.record("Calm Cooking", true);
  assert.deepEqual(m.decide("Calm Cooking"), { allow: true, reason: "channel:prior" });
});

test("decide resolves to the majority side (confident hide)", () => {
  const m = new ChannelMemory();
  m.reset("rule-A");
  for (let i = 0; i < 9; i++) m.record("Rage Bait Central", false);
  assert.deepEqual(m.decide("Rage Bait Central"), { allow: false, reason: "channel:prior" });
});

test("a wobbly (mixed) history never entrenches", () => {
  const m = new ChannelMemory();
  m.reset("rule-A");
  for (let i = 0; i < 5; i++) m.record("Mixed Bag", true);
  for (let i = 0; i < 4; i++) m.record("Mixed Bag", false); // 5/9 majority is far from confident
  assert.equal(m.decide("Mixed Bag"), null);
});

test("channel name is normalized, so casing/spacing doesn't split a channel", () => {
  const m = new ChannelMemory();
  m.reset("rule-A");
  for (let i = 0; i < 9; i++) m.record("  Calm   COOKING ", true);
  assert.deepEqual(m.decide("calm cooking"), { allow: true, reason: "channel:prior" });
});

test("blank channel is ignored by both record and decide", () => {
  const m = new ChannelMemory();
  m.reset("rule-A");
  m.record("", true);
  assert.equal(m.decide(""), null);
  assert.equal(m.decide("   "), null);
});

// ---- overflow: an early streak decays, it can't run away ----

test("counts halve on overflow so an early streak can be reversed", () => {
  const m = new ChannelMemory();
  m.reset("rule-A");
  for (let i = 0; i < 21; i++) m.record("Streaky", true); // 21st trips the cap → halve
  const [pos, neg] = m.toJSON().counts[Object.keys(m.toJSON().counts)[0]];
  assert.equal(pos, 10);
  assert.equal(neg, 0);
  assert.deepEqual(m.decide("Streaky"), { allow: true, reason: "channel:prior" }); // 10/0 still confident
});

// ---- rule scoping: verdicts are rule-specific ----

test("reset clears the map only when the ruleHash changes", () => {
  const m = new ChannelMemory();
  m.reset("rule-A");
  for (let i = 0; i < 9; i++) m.record("Ch", true);
  m.reset("rule-A"); // same rule → kept
  assert.deepEqual(m.decide("Ch"), { allow: true, reason: "channel:prior" });
  m.reset("rule-B"); // different rule → wiped
  assert.equal(m.decide("Ch"), null);
});

// ---- persistence round-trip ----

test("toJSON/load restores counts only for the matching rule", () => {
  const src = new ChannelMemory();
  src.reset("rule-A");
  for (let i = 0; i < 9; i++) src.record("Ch", true);
  const blob = src.toJSON();
  assert.equal(blob.ruleHash, "rule-A");

  const same = new ChannelMemory();
  same.reset("rule-A");
  same.load(blob);
  assert.deepEqual(same.decide("Ch"), { allow: true, reason: "channel:prior" });

  const other = new ChannelMemory();
  other.reset("rule-B");
  other.load(blob); // ruleHash mismatch → ignored
  assert.equal(other.decide("Ch"), null);
});

test("load tolerates malformed blobs", () => {
  const m = new ChannelMemory();
  m.reset("rule-A");
  for (const bad of [null, undefined, {}, { ruleHash: "rule-A" }, { ruleHash: "rule-A", counts: "x" },
    { ruleHash: "rule-A", counts: { Ch: [1] } }, { ruleHash: "rule-A", counts: { Ch: ["a", "b"] } }]) {
    assert.doesNotThrow(() => m.load(bad));
  }
  assert.equal(m.decide("Ch"), null);
});
