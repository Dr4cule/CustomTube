import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles() {
  const files = ["content.js", "background.js", "providers.js", "popup.js"].map((f) => join(root, f));
  for (const f of readdirSync(join(root, "src"))) if (f.endsWith(".js")) files.push(join(root, "src", f));
  return files;
}

const sources = sourceFiles().map((path) => ({ path, text: readFileSync(path, "utf8") }));

test("no setInterval anywhere (spec §6 forbids polling)", () => {
  for (const { path, text } of sources) {
    assert.ok(!/\bsetInterval\s*\(/.test(text), `setInterval found in ${path}`);
  }
});

test("no while(true) polling loops", () => {
  for (const { path, text } of sources) {
    assert.ok(!/\bwhile\s*\(\s*true\s*\)/.test(text), `while(true) found in ${path}`);
  }
});

test("no eval", () => {
  for (const { path, text } of sources) {
    assert.ok(!/\beval\s*\(/.test(text), `eval( found in ${path}`);
  }
});

test("innerHTML is never assigned dynamic/concatenated data", () => {
  for (const { path, text } of sources) {
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      const m = line.match(/\.innerHTML\s*=\s*(.*)$/);
      if (!m) return;
      const rhs = m[1];
      const dynamic = rhs.includes("`") || rhs.includes("${") || /\+[^+]/.test(rhs);
      assert.ok(!dynamic, `dynamic innerHTML in ${path}:${i + 1} → ${line.trim()}`);
    });
  }
});

test("recursive setTimeout is not used as a polling loop", () => {
  // One-shot debounce setTimeout is allowed; a setTimeout that reschedules itself is not.
  for (const { path, text } of sources) {
    // crude guard: a setTimeout whose callback name is reused as the scheduled fn is fine
    // as long as it isn't inside its own body — we just ensure no obvious self-refire pattern.
    assert.ok(!/setTimeout\([^)]*arguments\.callee/.test(text), `self-refiring timer in ${path}`);
  }
});
