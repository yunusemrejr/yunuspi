import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const agentRoot = [path.resolve(import.meta.dirname, "../agent"), path.resolve(import.meta.dirname, "../.."), path.resolve(import.meta.dirname, "../../agent")]
  .find((dir) => fs.existsSync(path.join(dir, "extensions/pi-lens/dist/index.js")));

// The helpers are dependency-free; extract them from the shipped bundle.
function load(t) {
  if (!agentRoot) { t.skip("bundled pi-lens dist is unavailable on this host"); return null; }
  const text = fs.readFileSync(path.join(agentRoot, "extensions/pi-lens/dist/index.js"), "utf8");
  const grab = (name) => {
    const start = text.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} must exist in the shipped bundle`);
    const open = text.indexOf(") {", start) + 2;
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
  };
  const names = ["findReflowInsensitiveCandidate", "isLayoutOnlyChange", "distinctiveLineOfOldText", "tokenizeForSimilarity", "tokenSimilarity", "findSimilarLines", "findSimilarLinesAbove"];
  const api = {};
  new Function("api", `${names.map(grab).join("\n")}\n${names.map((name) => `api.${name}=${name};`).join("")}`)(api);
  return api;
}

const file = [
  "intro",
  "    Each search streams mails through the offline index instead",
  "    of one per mail; DeepSeek reads a handful in full. The line under the answer states",
  "    it exactly: done.",
  "    /**",
  "     * Body-only keyword disjunct for the second phase of LIKE search.",
  "     * Null when no keywords. */",
  "    String x;",
  "",
].join("\n");

test("re-wrapped prose and comments bind to the verbatim current span", (t) => {
  const api = load(t); if (!api) return;
  const comment = "    /**\n     * Body-only keyword disjunct for the second phase of LIKE search. Null when no keywords. */";
  const found = api.findReflowInsensitiveCandidate(file, comment);
  assert.equal(found, "    /**\n     * Body-only keyword disjunct for the second phase of LIKE search.\n     * Null when no keywords. */");
  assert.equal(api.isLayoutOnlyChange(comment, found), true);
  const prose = "    instead of one per mail; DeepSeek reads a handful in full. The line under the answer states\n    it exactly: done.";
  assert.ok(api.findReflowInsensitiveCandidate(file, prose).startsWith("instead\n"), "mid-line starts keep no borrowed indentation");
  assert.equal(api.findReflowInsensitiveCandidate(file, "String x; and more text beyond this point"), undefined, "different text never matches");
  assert.equal(api.isLayoutOnlyChange("short", "short "), false, "short fragments are too ambiguous to rebind");
});

test("not-found hints anchor on the most distinctive oldText line", (t) => {
  const api = load(t); if (!api) return;
  const line = api.distinctiveLineOfOldText("    /**\n     * Body-only keyword disjunct for the second phase. */");
  assert.match(line, /Body-only keyword disjunct/);
  assert.equal(api.findSimilarLines(file, line, {})[0]?.line, 6);
});

test("a near miss returns the file's current lines so oldText is copied, not recalled", (t) => {
  if (!agentRoot) { t.skip("bundled pi-lens dist is unavailable on this host"); return; }
  const text = fs.readFileSync(path.join(agentRoot, "extensions/pi-lens/dist/index.js"), "utf8");
  const start = text.indexOf("function formatCurrentRegion(");
  assert.ok(start >= 0, "formatCurrentRegion ships in the bundle");
  const end = text.indexOf("\nfunction countFileLines(", start);
  const formatCurrentRegion = new Function(`${text.slice(start, end)}\nreturn formatCurrentRegion;`)();
  const css = ".company-link:focus-visible {\n  outline: 2px solid var(--brand-ink);\n  outline-offset: 2px;\n}\n.next {}\n";
  const region = formatCurrentRegion(css, 1, ".company-link:focus-visible{outline:2px solid var(--brand-ink);outline-offset:2px}");
  assert.match(region, /The file currently reads \(lines 1-\d+;/);
  assert.match(region, /\n\s+4 │ }/, "the whole formatted rule is shown");
  assert.match(region, /\n\s+2 │ {3}outline: 2px solid var\(--brand-ink\);/);
  assert.doesNotMatch(text.slice(text.indexOf("was not found in the current file content"), text.indexOf("was not found in the current file content") + 4000), /likely changed since your last read/, "the miss no longer blames an outside change it cannot know about");
});
