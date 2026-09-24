import { test } from "node:test";
import assert from "node:assert/strict";
import { getVideoId, isValidId, fallbackIdentity, resolveIdentity } from "../src/videoid.js";

test("getVideoId: /watch?v=", () => {
  assert.equal(getVideoId("/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(getVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLx"), "dQw4w9WgXcQ");
});

test("getVideoId: /shorts/", () => {
  assert.equal(getVideoId("/shorts/abc123DEF45"), "abc123DEF45");
  assert.equal(getVideoId("https://www.youtube.com/shorts/abc123DEF45?feature=share"), "abc123DEF45");
});

test("getVideoId: youtu.be", () => {
  assert.equal(getVideoId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(getVideoId("https://youtu.be/dQw4w9WgXcQ?t=42"), "dQw4w9WgXcQ");
});

test("getVideoId: playlist/mix cards without v → null", () => {
  assert.equal(getVideoId("/watch?list=PLabc"), null);
  assert.equal(getVideoId("/playlist?list=PLabc"), null);
});

test("getVideoId: garbage → null", () => {
  assert.equal(getVideoId(""), null);
  assert.equal(getVideoId(null), null);
  assert.equal(getVideoId("not a url at all"), null);
  assert.equal(getVideoId("/watch?v=tooShort"), null); // must be 11 chars
});

test("isValidId enforces 11-char id charset", () => {
  assert.ok(isValidId("dQw4w9WgXcQ"));
  assert.ok(!isValidId("short"));
  assert.ok(!isValidId("has spaces!!"));
});

test("fallbackIdentity is deterministic and prefixed", () => {
  const a = fallbackIdentity("Chill Mix", "YouTube");
  const b = fallbackIdentity("chill   mix", "youtube"); // normalized identically
  assert.equal(a, b);
  assert.match(a, /^fb_[0-9a-f]{8}$/);
  assert.equal(fallbackIdentity("", ""), null);
});

test("resolveIdentity prefers real id, else fallback", () => {
  assert.deepEqual(resolveIdentity("/watch?v=dQw4w9WgXcQ", "t", "c"), { id: "dQw4w9WgXcQ", fallback: false });
  const r = resolveIdentity("/watch?list=PL", "Mix", "Chan");
  assert.equal(r.fallback, true);
  assert.match(r.id, /^fb_/);
});
