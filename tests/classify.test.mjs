import { test } from "node:test";
import assert from "node:assert/strict";
import { Classifier } from "../src/classify.js";
import { compilePolicyLocal } from "../src/policy.js";

const blockMusic = compilePolicyLocal("hide music");

function makeSend(responder) {
  const send = async (payload, meta) => {
    send.calls.push({ payload, meta });
    return responder(payload, meta);
  };
  send.calls = [];
  return send;
}

function newClassifier(send, aiConfigured = true) {
  const c = new Classifier({ sendBatch: send });
  c.setPolicy(blockMusic, "h", "v1", aiConfigured);
  return c;
}

test("semantic path: valid results applied, batched into one request", async () => {
  const send = makeSend((payload, meta) => ({
    ok: true,
    ruleVersion: meta.ruleVersion,
    results: JSON.stringify({ results: payload.videos.map((v) => ({ id: v.id, allow: v.id === "keep" })) }),
    status: {},
  }));
  const c = newClassifier(send);
  const [d1, d2] = await Promise.all([
    c.checkSemanticMatch({ id: "keep", title: "Graph Algorithms Explained", channel: "CS" }),
    c.checkSemanticMatch({ id: "drop", title: "Some ambiguous clip", channel: "X" }),
  ]);
  assert.equal(d1.allow, true);
  assert.equal(d1.source, "semantic");
  assert.equal(d2.allow, false);
  assert.equal(send.calls.length, 1, "both videos in one batch");
});

test("provider garbage → every card allowed (fail-open, scenario 3)", async () => {
  const send = makeSend(() => ({ ok: true, ruleVersion: "v1", results: "totally not json", status: {} }));
  const c = newClassifier(send);
  const d = await c.checkSemanticMatch({ id: "x", title: "Ambiguous title", channel: "c" });
  assert.equal(d.allow, true);
});

test("stale ruleVersion response is dropped → fail-open (scenario 2)", async () => {
  const send = makeSend(() => ({ ok: true, ruleVersion: "OLD", results: JSON.stringify({ results: [{ id: "x", allow: false }] }), status: {} }));
  const c = newClassifier(send);
  const d = await c.checkSemanticMatch({ id: "x", title: "Ambiguous", channel: "c" });
  assert.equal(d.allow, true, "results for a different ruleVersion must not hide");
});

test("no AI configured → undecided resolves to allow (fail-open), no request", async () => {
  const send = makeSend(() => ({ ok: true, ruleVersion: "v1", results: "{}", status: {} }));
  const c = newClassifier(send, false);
  const d = await c.checkSemanticMatch({ id: "x", title: "Ambiguous", channel: "c" });
  assert.equal(d.allow, true);
  assert.equal(d.source, "failsafe");
  assert.equal(send.calls.length, 0);
});

test("baseline strong hide resolves without a semantic request", async () => {
  const send = makeSend(() => ({ ok: true, ruleVersion: "v1", results: "{}", status: {} }));
  const c = newClassifier(send);
  const d = await c.checkSemanticMatch({ id: "m", title: "Adele - Hello (Official Music Video)", channel: "VEVO" });
  assert.equal(d.allow, false);
  assert.equal(d.source, "baseline");
  assert.equal(send.calls.length, 0);
});

test("concurrent duplicate ids are deduped into one send", async () => {
  const send = makeSend((payload, meta) => ({
    ok: true,
    ruleVersion: meta.ruleVersion,
    results: JSON.stringify({ results: [{ id: "dup", allow: false }] }),
    status: {},
  }));
  const c = newClassifier(send);
  const meta = { id: "dup", title: "Ambiguous", channel: "c" };
  const [a, b] = await Promise.all([c.checkSemanticMatch(meta), c.checkSemanticMatch(meta)]);
  assert.equal(a.allow, false);
  assert.equal(b.allow, false);
  assert.equal(send.calls.length, 1);
});

test("cache hit avoids re-requesting", async () => {
  const send = makeSend((payload, meta) => ({
    ok: true,
    ruleVersion: meta.ruleVersion,
    results: JSON.stringify({ results: [{ id: "x", allow: false }] }),
    status: {},
  }));
  const c = newClassifier(send);
  const meta = { id: "x", title: "Ambiguous", channel: "c" };
  await c.checkSemanticMatch(meta);
  const again = await c.checkSemanticMatch(meta);
  assert.equal(again.source, "cache");
  assert.equal(send.calls.length, 1);
});
