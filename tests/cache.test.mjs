import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheKey, LRU, pruneCache } from "../src/cache.js";

test("cacheKey combines ruleHash and videoId", () => {
  assert.equal(cacheKey("abc", "vid1"), "abc:vid1");
});

test("LRU evicts least-recently-used beyond cap", () => {
  const lru = new LRU(2);
  lru.set("a", 1);
  lru.set("b", 2);
  lru.get("a"); // refresh a → b is now LRU
  lru.set("c", 3); // evicts b
  assert.equal(lru.has("a"), true);
  assert.equal(lru.has("b"), false);
  assert.equal(lru.has("c"), true);
  assert.equal(lru.size, 2);
});

test("LRU get returns undefined for missing, moves to recent on hit", () => {
  const lru = new LRU(2);
  assert.equal(lru.get("x"), undefined);
  lru.set("a", 1);
  lru.set("b", 2);
  assert.equal(lru.get("a"), 1);
  lru.set("c", 3); // b evicted (a was refreshed)
  assert.equal(lru.has("b"), false);
});

test("pruneCache drops entries from other rules", () => {
  const now = Date.now();
  const obj = {
    "hash1:v1": { allow: true, t: now },
    "hash2:v2": { allow: false, t: now },
  };
  const out = pruneCache(obj, { now, ruleHash: "hash1" });
  assert.deepEqual(Object.keys(out), ["hash1:v1"]);
});

test("pruneCache drops expired entries (TTL)", () => {
  const now = Date.now();
  const obj = {
    "h:fresh": { allow: true, t: now - 1000 },
    "h:stale": { allow: true, t: now - 8 * 24 * 60 * 60 * 1000 },
  };
  const out = pruneCache(obj, { now, ttl: 7 * 24 * 60 * 60 * 1000, ruleHash: "h" });
  assert.ok(out["h:fresh"]);
  assert.ok(!out["h:stale"]);
});

test("pruneCache enforces cap, keeping newest", () => {
  const now = Date.now();
  const obj = {};
  for (let i = 0; i < 10; i++) obj[`h:v${i}`] = { allow: true, t: now - i * 1000 };
  const out = pruneCache(obj, { now, cap: 3, ruleHash: "h" });
  assert.equal(Object.keys(out).length, 3);
  assert.ok(out["h:v0"] && out["h:v1"] && out["h:v2"]); // newest (largest t) kept
});

test("pruneCache ignores malformed records", () => {
  const now = Date.now();
  const out = pruneCache({ "h:bad": { allow: true }, "h:ok": { allow: true, t: now } }, { now, ruleHash: "h" });
  assert.deepEqual(Object.keys(out), ["h:ok"]);
});
