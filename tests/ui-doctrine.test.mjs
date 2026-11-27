// Embedded design-slop doctrine: Jev-settled UI-work detection, optional guidance
// and honest read status. No network: the judge is mocked or Jev is switched off.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.PI_JEV = 'off';
const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find((p) => fs.existsSync(path.join(p, 'extensions/lib/ui-doctrine.ts')));
const load = (p) => import(pathToFileURL(path.join(agent, 'extensions', p)));
const { uiPromptCue, uiFileCue, resolveUiWork, UI_DOCTRINE_SKILL } = await load('lib/ui-doctrine.ts');
const { TYPED_DECISIONS } = await load('lib/micro-intelligence/jev-decisions.ts');


test('the embedded skill ships with frontmatter and the swap test', () => {
  const file = path.join(agent, 'skills', UI_DOCTRINE_SKILL, 'SKILL.md');
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /^---\nname: ui-design\ndescription: .{40,}\n---/);
  for (const anchor of ['Indigo SaaS', 'Cream editorial', 'Name the subject', 'Real content only', 'swap test', '360, 768 and 1440'])
    assert.ok(body.includes(anchor), anchor);
  assert.ok(body.length < 6_000, 'the guide is read whole before design work, so it stays short');
  assert.ok(!/Voidstack|earlier in this conversation/.test(body), 'no unresolvable conversation references');
});

test('prompt cues separate interface work from prose, negation and non-visual vocabulary', () => {
  assert.equal(uiPromptCue('Build a landing page for my bakery').strength, 'strong');
  assert.equal(uiPromptCue('Redesign the dashboard').strength, 'strong');
  assert.equal(uiPromptCue('Make the checkout less confusing and clean up the page layout').strength, 'weak');
  assert.equal(uiPromptCue('Fix the page fault handler in the kernel').strength, 'weak', 'ambiguous vocabulary goes to the judge');
  for (const prompt of ['Explain how the landing page works', 'What is a dashboard?', 'Build the API, no UI', 'Refactor the parser', '']) assert.equal(uiPromptCue(prompt).strength, 'none', prompt);
});

test('file cues cover UI files and GUI toolkit code but not fixtures, docs or plain scripts', () => {
  for (const file of ['src/App.tsx', 'site/index.html', 'styles/app.scss', 'ui/Main.qml']) assert.ok(uiFileCue(file), file);
  for (const file of ['node_modules/x/index.html', 'tests/fixtures/page.html', 'agent/skills/x/SKILL.md', 'README.md', 'src/parser.ts', 'dist/app.css']) assert.ok(!uiFileCue(file), file);
  assert.ok(uiFileCue('app.py', 'import tkinter as tk\nroot = tk.Tk()'));
  assert.ok(uiFileCue('build.js', 'el = document.createElement("div")'));
  assert.ok(!uiFileCue('app.py', 'print("hello")'));
});

test('Jev refines weak cues in both directions; strong cues survive an unavailable judge', () => {
  const weak = { strength: 'weak', terms: ['page'] }, strong = { strength: 'strong', terms: ['dashboard'] };
  const yes = { ok: true, verdict: { supported: true } }, no = { ok: true, verdict: { supported: false } };
  assert.equal(resolveUiWork(weak, yes), true);
  assert.equal(resolveUiWork(weak, no), false);
  assert.equal(resolveUiWork(weak, undefined), false, 'weak vocabulary alone never demands');
  assert.equal(resolveUiWork(weak, { ok: false, reason: 'low-confidence' }), false);
  assert.equal(resolveUiWork(strong, undefined), true);
  assert.equal(resolveUiWork(strong, { ok: false, reason: 'skipped:breaker' }), true);
  assert.equal(resolveUiWork(strong, no), false, 'a decisive judge can veto a false-friend keyword');
  assert.equal(resolveUiWork({ strength: 'none', terms: [] }, yes), false);
});

test('ui-work decision is registered with a owner and bars', () => {
  const spec = TYPED_DECISIONS['ui-work'];
  assert.ok(spec.owner && spec.maxStateChars > 0);
  assert.equal(spec.interpret({ supported: { noul: 0.95 } }).verdict.supported, true);
  assert.equal(spec.interpret({ supported: { noul: 0.05 } }).verdict.supported, false);
  assert.equal(spec.interpret({ supported: { noul: 0.5 } }).ok, false);
});

test('a goal kickoff is read by the user\'s goal text, not by the standards menu around it', async () => {
  // The menu line "browser: operating a live website" made every goal strong UI work (art-direction brief,
  // a design-examples decision before the prompt, scrolltide examples) for a goal about a CLI flag.
  const { createGoal, goalKickoff } = await load('lib/goal-state.ts');
  const { standardsOffer } = await load('lib/presets.ts');
  const kickoff = (text) => { const goal = createGoal(text); return `${goalKickoff(goal)}\n\n${standardsOffer(goal)}`; };
  assert.match(kickoff('add a --version flag to cli.js'), /operating a live website/, 'the real kickoff carries the menu');
  assert.deepEqual(uiPromptCue(kickoff('add a --version flag to cli.js')), { strength: 'none', terms: [] });
  const ui = uiPromptCue(kickoff('redesign the landing page'));
  assert.equal(ui.strength, 'strong');
  assert.ok(ui.terms.includes('landing page') && !ui.terms.includes('website'));
  // A goal written over several lines is read whole.
  assert.equal(uiPromptCue(kickoff('Please do this:\n\nmake the new dashboard look better')).strength, 'strong');
});
