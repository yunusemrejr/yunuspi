import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((dir) => fs.existsSync(path.join(dir, "extensions/research-toolkit.ts")));
const load = (relative) => import(pathToFileURL(path.join(agent, relative)));
const { profileProject } = await load("extensions/lib/project-profile.ts");
const toolkit = await load("extensions/research-toolkit.ts");

function project(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-profile-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}
function tool() {
  let registered;
  toolkit.default({ registerTool(definition) { registered = definition; } });
  return async (input) => {
    const result = await registered.execute("id", input);
    return { ...JSON.parse(result.content[0].text), isError: result.isError === true };
  };
}

test("a project profile reports languages, declared surface, license, layout signals and README claims without reading secrets", (t) => {
  const dir = project(t, {
    "package.json": JSON.stringify({ name: "notes-cli", description: "Fast terminal notes", license: "MIT", bin: { notes: "bin/notes.js" }, scripts: { test: "node --test", build: "tsc" }, dependencies: { chalk: "^5" }, devDependencies: { typescript: "^5", tsx: "^4" } }),
    "README.md": "[![CI](x)](y)\n# Notes CLI\n\nCapture and search notes from the terminal.\nSecond line of the intro.\n\nMore prose that must not join the tagline.\n\n## Sync\n\n## Encryption at rest\n\n```sh\n## not a heading\n```\n",
    "src/a.ts": "export {}", "src/b.ts": "export {}", "src/c.js": "", "tests/a.test.js": "", "docs/x.md": "", ".github/workflows/ci.yml": "",
    "node_modules/dep/index.js": "ignored", "dist/out.js": "ignored", ".env": "SECRET=1", ".env.local": "SECRET=2",
    "CHANGELOG.md": "# Changes", "LICENSE": "MIT License\n\nPermission is hereby granted",
    ".git/refs/tags/v1.2.0": "x", ".git/refs/tags/v1.10.0": "x", ".git/packed-refs": "abc refs/tags/v1.9.0\n",
  });
  const profile = profileProject(dir);
  assert.equal(profile.name, "notes-cli");
  assert.equal(profile.description, "Fast terminal notes");
  assert.deepEqual(profile.languages.map((entry) => [entry.name, entry.files]), [["TypeScript", 2], ["JavaScript", 2]], "dependency and build directories are not the project");
  assert.deepEqual(profile.declared.scripts, ["test", "build"]);
  assert.deepEqual(profile.declared.bins, ["notes"]);
  assert.deepEqual(profile.declared.dependencies, ["chalk"]);
  assert.equal(profile.declared.devDependencies, 2);
  assert.equal(profile.license, "MIT");
  assert.deepEqual(profile.signals, { tests: true, ci: true, docs: true, changelog: true, contributing: false, container: false, examples: false, license: true });
  assert.equal(profile.tagline, "Notes CLI — Capture and search notes from the terminal. Second line of the intro.");
  assert.deepEqual(profile.capabilityHeadings, ["Sync", "Encryption at rest"], "fenced code never becomes a capability heading");
  assert.equal(profile.latestTag, "v1.10.0", "tags compare numerically, loose and packed alike");
  assert.ok(!profile.root.some((name) => name.startsWith(".env")), "secret files are never listed");
  assert.ok(!JSON.stringify(profile).includes("SECRET"));
});

test("a license is recognised from its text when no manifest declares one, and a plain directory still profiles", (t) => {
  const apache = project(t, { "LICENSE": "                                 Apache License\n                           Version 2.0, January 2004\n   Apache License, Version 2.0 text", "main.py": "print(1)" });
  assert.equal(profileProject(apache).license, "Apache-2.0");
  const bare = project(t, { "notes.txt": "x" });
  const profile = profileProject(bare);
  assert.equal(profile.name, path.basename(bare));
  assert.deepEqual(profile.languages, []);
  assert.equal(profile.license, undefined);
  assert.throws(() => profileProject(path.join(bare, "notes.txt")), /directory/);
});

test("research_toolkit plans prior-art angles, keeps the lead plan unchanged and profiles on demand", async (t) => {
  const run = tool();
  const plan = await run({ action: "plan", goal: "Build a terminal note taking app with sync", mode: "prior-art" });
  assert.ok(plan.angles.some((angle) => /alternatives$/.test(angle)));
  assert.ok(plan.angles.some((angle) => /limitations complaints$/.test(angle)), "what users complain about is a standing angle");
  assert.deepEqual(plan.githubQueries, ["terminal note taking sync", "terminal note"]);
  assert.deepEqual(plan.fallbackProviders, ["hackernews", "stackexchange", "npm"], "keyless indexes keep the web angles useful while general search cools down");
  assert.ok(plan.sequence.length >= 4 && /profile/.test(plan.sequence[0]));
  assert.match(plan.template, /adopt\|adapt\|reject\|watch/);
  assert.ok(!plan.angles.some((angle) => /contact leadership|pricing customers/.test(angle)), "prior-art planning is not lead generation");
  const leads = await run({ action: "plan", goal: "acme robotics buyers" });
  assert.ok(leads.angles.some((angle) => /contact leadership/.test(angle)), "the default plan is still the market plan");
  assert.equal(leads.githubQueries, undefined);
  const dir = project(t, { "package.json": JSON.stringify({ name: "demo" }), "a.py": "" });
  const profile = await run({ action: "profile", path: dir });
  assert.equal(profile.profile.name, "demo");
  assert.match(profile.next, /github_search/);
  const missing = await run({ action: "profile", path: path.join(dir, "nope") });
  assert.equal(missing.isError, true);
  assert.match(missing.error, /Cannot profile/);
});

test('profile metadata reads a bounded prefix even when the README is a huge sparse file', t => {
  const dir = project(t, { 'README.md': '# Bounded profile\n\nUseful project facts.\n', 'app.ts': '' });
  fs.truncateSync(path.join(dir, 'README.md'), 2 ** 31 + 1);
  assert.equal(profileProject(dir).tagline, 'Bounded profile — Useful project facts.');
});

test('metadata symlinks never reveal external content and a depth cap marks the profile partial', t => {
  const external = project(t, { 'package.json': JSON.stringify({ name: 'external-private-value' }), 'README.md': '# External value' });
  const dir = project(t, { 'src/one/two/three/four/five/six/hidden.py': '' });
  fs.symlinkSync(path.join(external, 'package.json'), path.join(dir, 'package.json'));
  fs.symlinkSync(path.join(external, 'README.md'), path.join(dir, 'README.md'));
  const profile = profileProject(dir);
  assert.equal(profile.name, path.basename(dir));
  assert.equal(profile.tagline, undefined);
  assert.equal(profile.truncated, true);
  assert.ok(!JSON.stringify(profile).includes('external-private-value'));
});
