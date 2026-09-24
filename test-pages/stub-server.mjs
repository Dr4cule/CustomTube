/**
 * Local stub AI server for fixtures + Playwright acceptance tests.
 * Serves the fixture pages and the extension's src/ modules, and exposes an
 * OpenAI-compatible POST /v1/chat/completions that classifies using the same
 * topic lexicon the extension ships. Start: node test-pages/stub-server.mjs
 *
 * Query/header switches for failure testing:
 *   ?mode=garbage   → returns non-JSON content (exercises fail-open)
 *   ?mode=down      → returns HTTP 500
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { TOPIC_LEXICON } from "../src/constants.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const PORT = Number(process.env.PORT) || 8730;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json" };

// Extra keywords for fixture titles the lexicon doesn't cover by name.
const EXTRA = { music: ["taylor swift", "blank space", "vevo", "chillhop"] };

function keywordsFor(topics) {
  const out = new Set();
  for (const t of topics || []) {
    for (const w of TOPIC_LEXICON[t] || []) out.add(w);
    for (const w of EXTRA[t] || []) out.add(w);
    out.add(t);
  }
  return [...out];
}

function classify(policy, videos) {
  const inc = keywordsFor(policy.includeTopics);
  const exc = keywordsFor(policy.excludeTopics);
  return videos.map((v) => {
    const hay = `${v.title} ${v.channel || ""}`.toLowerCase();
    const exMatch = exc.some((w) => hay.includes(w));
    const inMatch = inc.some((w) => hay.includes(w));
    const allow = policy.mode === "allowlist" ? inMatch && !exMatch : !exMatch;
    return { id: v.id, allow };
  });
}

async function serveStatic(res, absPath) {
  try {
    const body = await readFile(absPath);
    res.writeHead(200, { "Content-Type": MIME[extname(absPath)] || "application/octet-stream", "Access-Control-Allow-Origin": "*" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const mode = url.searchParams.get("mode");
      if (mode === "down") return res.writeHead(500).end("boom");
      let content;
      try {
        const body = JSON.parse(raw);
        const userMsg = JSON.parse(body.messages[body.messages.length - 1].content);
        if (mode === "garbage") content = "this is not json at all";
        else if (userMsg.rule !== undefined) content = JSON.stringify({ mode: "blocklist", includeTopics: [], excludeTopics: [], structural: { hideShorts: false }, summary: "stub", notes: [] });
        else content = JSON.stringify({ results: classify(userMsg.policy, userMsg.videos) });
      } catch {
        content = "bad request";
      }
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
    return;
  }

  if (url.pathname === "/" || url.pathname === "") return serveStatic(res, join(here, "legacy.html"));
  if (url.pathname === "/watch") return serveStatic(res, join(here, "lockup.html")); // watch-sidebar surface
  if (url.pathname === "/styles.css") return serveStatic(res, join(repo, "styles.css"));
  if (url.pathname.startsWith("/src/")) return serveStatic(res, join(repo, url.pathname));
  if (url.pathname === "/harness.js") return serveStatic(res, join(here, "harness.js"));
  return serveStatic(res, join(here, url.pathname.slice(1)));
});

server.listen(PORT, () => console.log(`stub server on http://localhost:${PORT}`));
