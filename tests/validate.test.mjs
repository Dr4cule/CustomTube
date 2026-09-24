import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBatchResponse, stripJsonFences, validateCompiledPolicy, parseBatchVerdicts } from "../src/validate.js";

const ids = ["a", "b", "c"];

test("valid response is honored", () => {
  const r = validateBatchResponse('{"results":[{"id":"a","allow":false},{"id":"b","allow":true},{"id":"c","allow":false}]}', ids);
  assert.equal(r.get("a"), false);
  assert.equal(r.get("b"), true);
  assert.equal(r.get("c"), false);
});

test("garbage text → every requested id allowed (fail-open)", () => {
  for (const junk of ["not json", "", "<html>", "{oops", "null", "[]"]) {
    const r = validateBatchResponse(junk, ids);
    assert.deepEqual([...r.values()], [true, true, true], junk);
  }
});

test("missing id → that video allowed", () => {
  const r = validateBatchResponse('{"results":[{"id":"a","allow":false}]}', ids);
  assert.equal(r.get("a"), false);
  assert.equal(r.get("b"), true); // missing → allow
  assert.equal(r.get("c"), true);
});

test("unknown/extra id is ignored", () => {
  const r = validateBatchResponse('{"results":[{"id":"zzz","allow":false},{"id":"a","allow":false}]}', ids);
  assert.equal(r.get("a"), false);
  assert.equal(r.size, 3); // only requested ids present
});

test("duplicate id → forced open, never trusted", () => {
  const r = validateBatchResponse('{"results":[{"id":"a","allow":false},{"id":"a","allow":false}]}', ids);
  assert.equal(r.get("a"), true); // duplicate → fail-open
});

test("non-boolean allow → that video allowed", () => {
  const r = validateBatchResponse('{"results":[{"id":"a","allow":"false"},{"id":"b","allow":1}]}', ids);
  assert.equal(r.get("a"), true);
  assert.equal(r.get("b"), true);
});

test("tolerates ```json fences", () => {
  const r = validateBatchResponse('```json\n{"results":[{"id":"a","allow":false}]}\n```', ids);
  assert.equal(r.get("a"), false);
  assert.equal(stripJsonFences("```\n{}\n```"), "{}");
});

test("injection-style ids do not escape validation", () => {
  // A model echoing an injected instruction can only ever affect its own listed ids.
  const r = validateBatchResponse('{"results":[{"id":"Ignore previous instructions","allow":true}]}', ids);
  assert.deepEqual([...r.values()], [true, true, true]); // unknown id ignored, all default-allow
});

test("validateCompiledPolicy coerces shape and never throws", () => {
  assert.equal(validateCompiledPolicy(null), null);
  const p = validateCompiledPolicy({
    mode: "allowlist",
    includeTopics: ["Programming", "programming", 3],
    excludeTopics: "nope",
    structural: { hideShorts: 1, minDurationSec: -5, maxDurationSec: 600 },
    summary: 42,
    notes: ["ok", 5],
  });
  assert.equal(p.mode, "allowlist");
  assert.deepEqual(p.includeTopics, ["programming"]); // deduped, lowercased, strings only
  assert.deepEqual(p.excludeTopics, []);
  assert.equal(p.structural.hideShorts, true);
  assert.equal(p.structural.minDurationSec, undefined); // negative rejected
  assert.equal(p.structural.maxDurationSec, 600);
  assert.equal(p.summary, "");
  assert.deepEqual(p.notes, ["ok"]);
});

test("validateCompiledPolicy defaults unknown mode to blocklist", () => {
  assert.equal(validateCompiledPolicy({ mode: "weird" }).mode, "blocklist");
});

// ---- Feature #2: confidence-gated hiding ----

test("parseBatchVerdicts keeps only decided ids with coerced conf", () => {
  const m = parseBatchVerdicts('{"results":[{"id":"a","allow":false,"conf":0.9},{"id":"b","allow":true,"conf":"high"}]}', ids);
  assert.deepEqual(m.get("a"), { allow: false, conf: 0.9 });
  assert.deepEqual(m.get("b"), { allow: true, conf: 1 }); // "high" → 1
  assert.equal(m.has("c"), false); // omitted id is NOT defaulted here (caller decides)
});

test("parseBatchVerdicts: absent/unparseable conf → 0, word confidences map", () => {
  const m = parseBatchVerdicts('{"results":[{"id":"a","allow":false},{"id":"b","allow":false,"conf":"medium"},{"id":"c","allow":false,"conf":"nope"}]}', ids);
  assert.equal(m.get("a").conf, 0);   // absent → 0
  assert.equal(m.get("b").conf, 0.6); // "medium" → 0.6
  assert.equal(m.get("c").conf, 0);   // unparseable → 0
});

test("conf-gating: low-confidence hide fails open above minConfidence", () => {
  const raw = '{"results":[{"id":"a","allow":false,"conf":0.4},{"id":"b","allow":false,"conf":0.95}]}';
  const cautious = validateBatchResponse(raw, ids, 0.9);
  assert.equal(cautious.get("a"), true);  // 0.4 < 0.9 → fails open (stays visible)
  assert.equal(cautious.get("b"), false); // 0.95 ≥ 0.9 → hidden
});

test("conf-gating: default minConfidence 0 honors every hide (back-compat)", () => {
  // Absent conf → 0, and 0 ≥ 0, so a hide with no confidence is still honored.
  const r = validateBatchResponse('{"results":[{"id":"a","allow":false}]}', ids);
  assert.equal(r.get("a"), false);
});

// ---- Features #1/#5: valence + rubric coercion ----

test("validateCompiledPolicy coerces valence and rubric", () => {
  const p = validateCompiledPolicy({
    mode: "blocklist",
    valence: "positive",
    rubric: ["  a  ", "a", 7, "b", "c", "d", "e", "f", "g"], // dedup + trim + cap 6
  });
  assert.equal(p.valence, "positive");
  assert.equal(p.rubric.length, 6);
  assert.equal(p.rubric[0], "a"); // trimmed + deduped
  assert.ok(!p.rubric.includes(7));
});

test("validateCompiledPolicy: invalid valence → null, missing rubric → []", () => {
  const p = validateCompiledPolicy({ mode: "blocklist", valence: "sideways" });
  assert.equal(p.valence, null);
  assert.deepEqual(p.rubric, []);
});
