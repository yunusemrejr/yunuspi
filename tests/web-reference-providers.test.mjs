import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((dir) => fs.existsSync(path.join(dir, "extensions/pi-web-access/free-search.ts")));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-reference-providers-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = scratch;
const originalFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = originalFetch;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  fs.rmSync(scratch, { recursive: true, force: true });
});
const load = (relative) => import(pathToFileURL(path.join(agent, relative)));
const clearPace = () => fs.rmSync(path.join(scratch, "web-search-pacing"), { recursive: true, force: true });

test("Hacker News, Stack Overflow and npm are keyless reference providers with honest scope and recency handling", async () => {
  const { searchFree } = await load("extensions/pi-web-access/free-search.ts");
  const seen = [];
  clearPace();
  globalThis.fetch = async (url) => {
    seen.push(new URL(url));
    return Response.json({
      hits: [
        { objectID: "42", title: "Show HN: <b>Notes</b> CLI", url: "https://example.org/notes", points: 321, num_comments: 87, created_at: "2026-09-30T10:00:00Z" },
        { objectID: "43", story_title: "Ask HN: sync?", url: null, points: 5, num_comments: 2, created_at: "2026-10-01T10:00:00Z", story_text: "Which sync model do you use?" },
      ],
    });
  };
  const before = Math.floor(Date.now() / 1000);
  const hn = await searchFree("hackernews", "terminal notes", { recencyFilter: "week" });
  assert.equal(seen[0].hostname, "hn.algolia.com");
  assert.equal(seen[0].searchParams.get("tags"), "story");
  const floor = Number(/created_at_i>(\d+)/.exec(seen[0].searchParams.get("numericFilters"))[1]);
  assert.ok(floor >= before - 604_800 - 5 && floor <= before - 604_800 + 5, "a week filter becomes a creation-time bound");
  assert.match(hn.answer, /not primary documentation/);
  assert.equal(hn.results[0].title, "Show HN: Notes CLI");
  assert.match(hn.results[0].snippet, /321 points, 87 comments, 2026-09-30\. Discussion: https:\/\/news\.ycombinator\.com\/item\?id=42/);
  assert.equal(hn.results[1].url, "https://news.ycombinator.com/item?id=43", "a story without an outbound link points at its discussion");

  clearPace();
  globalThis.fetch = async (url) => {
    seen.push(new URL(url));
    return Response.json({ items: [{ title: "How to sync &amp; merge notes?", link: "https://stackoverflow.com/questions/1", score: 12, answer_count: 3, is_answered: true, tags: ["sync", "crdt"] }] });
  };
  const so = await searchFree("stackexchange", "sync merge", { recencyFilter: "month" });
  const request = seen.at(-1);
  assert.equal(request.hostname, "api.stackexchange.com");
  assert.equal(request.searchParams.get("site"), "stackoverflow");
  assert.ok(Number(request.searchParams.get("fromdate")) > before - 2_592_000 - 5);
  assert.equal(so.results[0].title, "How to sync & merge notes?", "entities decode and never reach the model as markup");
  assert.equal(so.results[0].snippet, "12 votes, 3 answers (answered), tags: sync, crdt");
  assert.match(so.answer, /check dates and versions/);

  clearPace();
  globalThis.fetch = async (url) => {
    seen.push(new URL(url));
    return Response.json({ objects: [{ package: { name: "notes-cli", version: "2.1.0", description: "Terminal notes", date: "2026-08-01T00:00:00Z", keywords: ["notes", "cli"], links: { npm: "https://www.npmjs.com/package/notes-cli" } } }, { package: { name: "@scope/plain", version: "1.0.0" } }] });
  };
  const npm = await searchFree("npm", "notes", {});
  assert.equal(seen.at(-1).hostname, "registry.npmjs.org");
  assert.equal(npm.results[0].title, "notes-cli@2.1.0");
  assert.equal(npm.results[0].snippet, "Terminal notes (published 2026-08-01; keywords: notes, cli)");
  assert.equal(npm.results[1].url, "https://www.npmjs.com/package/%40scope%2Fplain", "a package without a link falls back to its registry page");
  assert.match(npm.answer, /does not imply popularity/);
  await assert.rejects(searchFree("npm", "notes", { recencyFilter: "day" }), /does not support this publication-recency filter/);
  globalThis.fetch = async () => Response.json({ unexpected: true });
  clearPace();
  await assert.rejects(searchFree("hackernews", "x", {}), /hackernews returned invalid response/);
  globalThis.fetch = originalFetch;
});

test("the new providers are selectable by name, never part of the all fan-out, and need no credentials", async () => {
  const gemini = await load("extensions/pi-web-access/gemini-search.ts");
  for (const name of ["hackernews", "stackexchange", "npm"]) {
    assert.ok(gemini.RESOLVED_SEARCH_PROVIDERS.includes(name), `${name} is a resolved provider`);
    assert.ok(gemini.SEARCH_PROVIDERS.includes(name), `${name} can be requested explicitly`);
    assert.ok(!gemini.ALL_SEARCH_PROVIDERS.includes(name), `${name} is a reference index, not general web coverage`);
  }
});
