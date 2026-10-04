import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((dir) => fs.existsSync(path.join(dir, "extensions/lib/prior-art.ts")));
const load = (relative) => import(pathToFileURL(path.join(agent, relative)));
const { priorArtIntent, priorArtDirective, PRIOR_ART_TOOLS } = await load("extensions/lib/prior-art.ts");
const { buildExpertBrief } = await load("extensions/lib/expert-brief.ts");
const { intentBundleTools } = await load("extensions/lib/tool-discovery.ts");

const modeOf = (prompt) => priorArtIntent(prompt)?.mode;

test("an explicit request to look at others' products or projects is a comparison, wherever it appears in a short prompt", () => {
  for (const prompt of [
    "Compare our harness with other agent harnesses and tell me what we are missing",
    "who are the competitors of a terminal notes app and how do they differ from ours",
    "Look for similar open-source projects on GitHub before we design the sync layer",
    "check what other tools do for retry handling and see if we should adopt it",
    "How do other coding agents handle context compaction? Compare with what we do.",
    "search github for existing implementations of a CRDT text editor",
    "Do a competitive analysis of our pricing page against the market leaders",
  ]) assert.equal(modeOf(prompt), "compare", prompt);
});

test("open-ended improvement of a product-level subject qualifies, a named defect or small tweak does not", () => {
  for (const prompt of [
    "Improve this local application deeply, find what is missing and make it competitive",
    "make our CLI much better overall, suggest the next features that matter most",
    "level up the dashboard: what else should we add? ideas welcome",
  ]) assert.equal(modeOf(prompt), "improve", prompt);
  for (const prompt of [
    "Improve the performance of this function in src/parse.ts",
    "improve the error message wording in the login form",
    "fix the crash when the config file is missing and improve the app",
    "make sure the reminder system is robust and improve it",
    "refactor and improve the app so shared utilities are consolidated, the whole thing",
  ]) assert.equal(priorArtIntent(prompt), undefined, prompt);
});

test("new software with an open design space qualifies; fixed designs, media, tweaks and questions do not", () => {
  for (const prompt of [
    "Build me a small terminal note taking app with sync",
    "create a CLI that watches my downloads folder and files things sensibly",
    "develop a new plugin system for our editor that people will love",
  ]) assert.equal(modeOf(prompt), "build", prompt);
  for (const prompt of [
    "Build a small pricing page (index.html + styles.css) for a note-taking app called Lumen with three plans",
    "make sure the sync service retries correctly",
    "Create a 30 second video about how a CPU works",
    "Build a service exactly as specified: POST /items returns 201 with the created item",
    "what would a good terminal note taking app look like?",
    "write a new function that parses ISO dates in utils.ts",
    "Build a tool " + "with these precise requirements ".repeat(60),
  ]) assert.equal(priorArtIntent(prompt), undefined, prompt);
});

test("bug fixes, reviews, operations, trivial edits and an explicit no-web request never qualify", () => {
  for (const prompt of [
    "fix the failing build and then compare the error output with the previous run",
    "review this pull request for correctness problems",
    "deploy the app to production and check that it is healthy",
    "fix a typo in the README",
    "Build a note taking app, but work offline: no internet, no research",
    "Improve the whole product and do not search the web or GitHub for competitors",
  ]) assert.equal(priorArtIntent(prompt), undefined, prompt);
  assert.equal(priorArtIntent(""), undefined);
  assert.equal(priorArtIntent("ok"), undefined);
});

test("a competing-implementations phrase deep inside a long specification does not start a comparison", () => {
  const spec = `Implement the entropy detector. ${"Detailed requirement text that fixes the design. ".repeat(60)} It must find competing implementations of the same function and compare them.`;
  assert.equal(priorArtIntent(spec), undefined);
  assert.equal(priorArtIntent("Compare it with other similar tools. " + "More detail. ".repeat(300))?.mode, "compare", "an early explicit request still counts in a long prompt");
});

test("the directive names the workflow tools, stays bounded and treats outside text as untrusted", () => {
  for (const mode of ["compare", "improve", "build"]) {
    const text = priorArtDirective({ mode, reason: "x" });
    assert.ok(text.length < 760, `${mode} directive stays small (${text.length})`);
    assert.match(text, /github_search/);
    assert.match(text, /untrusted/);
    assert.match(text, /license/);
  }
  assert.match(priorArtDirective({ mode: "improve", reason: "x" }), /project_intel/);
  assert.match(priorArtDirective({ mode: "compare", reason: "x" }), /research_toolkit profile/);
});

test("the Expert Director adds the directive even when no excellence domain qualifies, and not otherwise", () => {
  const brief = buildExpertBrief({ prompt: "Compare our harness with other agent harnesses and tell me what we are missing" });
  assert.match(brief.text, /Prior art \(advisory/);
  assert.match(brief.summary, /prior art/i);
  const none = buildExpertBrief({ prompt: "fix a typo in the README" });
  assert.equal(none.text, "");
  const domain = buildExpertBrief({ prompt: "Build me a small terminal note taking app with sync, with a REST backend and a sqlite database" });
  assert.match(domain.text, /Prior art \(advisory/);
  assert.match(domain.text, /Critics for this task/, "the domain guidance and critics survive next to the directive");
});

test("a qualifying prompt stages the scouting tools with the first turn; an ordinary one does not", () => {
  for (const name of PRIOR_ART_TOOLS) assert.ok(intentBundleTools("Compare our harness with other agent harnesses and tell me what we are missing").includes(name), name);
  assert.ok(!intentBundleTools("fix the failing build").includes("github_search"));
  assert.ok(!intentBundleTools("Build a note taking app, but work offline: no internet, no research").includes("github_search"));
});

test("PI_PRIOR_ART=off disables the mode decision for every consumer", () => {
  assert.equal(priorArtIntent("Compare our harness with other agent harnesses", { PI_PRIOR_ART: "off" }), undefined);
  assert.equal(priorArtIntent("Compare our harness with other agent harnesses", { PI_PRIOR_ART: "0" }), undefined);
  assert.equal(priorArtIntent("Compare our harness with other agent harnesses", {})?.mode, "compare");
});
