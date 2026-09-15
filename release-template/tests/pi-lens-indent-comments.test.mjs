import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Resolve either the live source tree or the standalone release being tested.
const candidates = [
  path.resolve(import.meta.dirname, "../agent"),
  path.resolve(import.meta.dirname, "../.."),
  path.resolve(import.meta.dirname, "../../agent"),
];
const agentRoot = candidates.find((dir) =>
  fs.existsSync(path.join(dir, "extensions/pi-lens/dist/index.js")),
);

// detectIndentation is dependency-free, so the shipped bundle behavior can be
// exercised directly by extracting the function body with balanced braces.
function loadDetector(t) {
  if (!agentRoot) {
    t.skip("bundled pi-lens dist is unavailable on this host");
    return null;
  }
  const text = fs.readFileSync(
    path.join(agentRoot, "extensions/pi-lens/dist/index.js"),
    "utf8",
  );
  const start = text.indexOf("function detectIndentation(content)");
  assert.ok(start >= 0, "detector must exist in the shipped bundle");
  const open = text.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        const body = text.slice(open + 1, i);
        return (content) =>
          new Function("content", "DEFAULT_INDENTATION", body)(content, {
            style: "space",
            width: 2,
          });
      }
    }
  }
  throw new Error("unbalanced detector body in shipped bundle");
}

test("indentation detection ignores comment-only lines", (t) => {
  const detect = loadDetector(t);
  if (!detect) return;
  const jsdoc = [
    "/**",
    " * Big header line one.",
    " * Big header line two.",
    " * Big header line three.",
    " */",
    "export function f() {",
    "  const x = 1;",
    "  if (x) {",
    "    return x;",
    "  }",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(
    detect(jsdoc),
    { style: "space", width: 2 },
    "JSDoc continuation lines must not collapse the vote to width 1",
  );
  const slashes = ["// banner", "// banner", "function f() {", "    return 1;", "}", ""].join("\n");
  assert.deepEqual(detect(slashes), { style: "space", width: 4 });
  const hashes = ["# banner", "def f():", "    return 1", ""].join("\n");
  assert.deepEqual(detect(hashes), { style: "space", width: 4 });
});

test("indentation detection keeps tabs and comment-only fallback", (t) => {
  const detect = loadDetector(t);
  if (!detect) return;
  assert.deepEqual(
    detect("function f() {\n\tconst x = 1;\n\treturn x;\n}\n"),
    { style: "tab", width: 1 },
  );
  assert.deepEqual(detect("// nothing\n// but comments\n"), {
    style: "space",
    width: 2,
  });
});
