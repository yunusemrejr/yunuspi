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
  const hostModule = /var LENS_HOST_MODULE = [^\n]+/.exec(text)?.[0];
  assert.ok(hostModule, "LENS_HOST_MODULE must exist in the shipped bundle");
  const names = ["autofixChangedLines", "lensMissingModule", "lensEnvironmentRepeat"];
  const api = { text };
  new Function("api", `${hostModule}\n${names.map(grab).join("\n")}\n${names.map((name) => `api.${name}=${name};`).join("")}`)(api);
  return api;
}

test("an autofix attaches the current text of the changed lines, not the whole file", (t) => {
  const api = load(t); if (!api) return;
  const body = Array.from({ length: 40 }, (_, i) => `x${i} = ${i}`);
  const before = ["import os", "import bpy", "import math", ...body, "print( x1 )", ""].join("\n");
  const after = ["import math", "import os", "", "import bpy", ...body, "print(x1)", ""].join("\n");
  const excerpt = api.autofixChangedLines(before, after);
  // os and bpy keep their order, so math moves up, a blank line is added and math's old line goes.
  assert.equal(excerpt, "L1:\n 1│import math\nL3:\n 3│\nafter L4: 1 line(s) removed\nL45:\n45│print(x1)");
  assert.ok(!excerpt.includes("x20 = 20"), "unchanged lines are not repeated");
  assert.ok(excerpt.length < 200, `excerpt stays small (${excerpt.length} chars)`);
  assert.equal(api.autofixChangedLines("a\nb\nc", "a\nc"), "after L1: 1 line(s) removed");
  assert.equal(api.autofixChangedLines("same\n", "same\n"), "(no line changed)");
  assert.equal(api.autofixChangedLines(undefined, "x"), undefined, "without the written text the caller falls back");
});

test("missing-package diagnostics are environment facts: host modules never show, others once per session", (t) => {
  const api = load(t); if (!api) return;
  const facts = new Map();
  const ctx = { cwd: "/p", facts: { getSessionFact: (k) => facts.get(k), setSessionFact: (k, v) => facts.set(k, v) } };
  const pyright = (rule, module) => ({ rule, message: `Import "${module}" could not be resolved` });
  assert.equal(api.lensEnvironmentRepeat(pyright("Pyright:reportMissingImports", "bpy"), ctx), true);
  assert.equal(api.lensEnvironmentRepeat(pyright("reportMissingImports", "mathutils.bvhtree"), ctx), true);
  assert.equal(api.lensEnvironmentRepeat(pyright("Pyright:reportMissingImports", "numpy"), ctx), false, "first report shows");
  assert.equal(api.lensEnvironmentRepeat(pyright("reportMissingImports", "numpy"), ctx), true, "the same module from a second source does not");
  const types = { rule: "typescript:7016", message: "Could not find a declaration file for module 'three'. '/x/node_modules/three/build/three.module.js' implicitly has an 'any' type." };
  assert.equal(api.lensEnvironmentRepeat(types, ctx), false);
  assert.equal(api.lensEnvironmentRepeat(types, ctx), true);
  const typo = { rule: "typescript:2307", message: "Cannot find module './Mian' or its corresponding type declarations." };
  assert.equal(api.lensMissingModule(typo), undefined, "a relative import is a code error, never an environment fact");
  assert.equal(api.lensEnvironmentRepeat(typo, ctx), false);
  assert.equal(api.lensEnvironmentRepeat({ rule: "ruff:F401", message: "unused" }, ctx), false);
});

test("pi-lens no longer prints the unchanged-baseline footer and caps autofix attachments", (t) => {
  const api = load(t); if (!api) return;
  assert.ok(!api.text.includes("unchanged baseline, ${"), "the footer template is gone");
  assert.match(api.text, /var AUTOFIX_ATTACHMENT_MAX_BYTES = 6e3;/);
  assert.match(api.text, /const withinPerFileCap = contentBytes <= AUTOFIX_ATTACHMENT_MAX_BYTES;/);
  const rules = path.join(agentRoot, "extensions/pi-lens/rules/ast-grep-rules/rules");
  for (const name of ["unchecked-throwing-call.yml", "unchecked-throwing-call-js.yml", "unchecked-throwing-call-python.yml"]) {
    assert.match(fs.readFileSync(path.join(rules, name), "utf8"), /^severity: warning$/m, `${name} is advisory: wrapping every call conflicts with the swallowed-error check`);
  }
});
