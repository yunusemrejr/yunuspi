// Embedded design-slop doctrine: Jev-settled UI-work detection, optional guidance
// and honest read status. No network: the judge is mocked or Jev is switched off.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.PI_JEV = 'off';
const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find((p) => fs.existsSync(path.join(p, 'extensions/lib/ui-doctrine.ts')));
const load = (p) => import(pathToFileURL(path.join(agent, 'extensions', p)));
const { uiPromptCue, uiFileCue, resolveUiWork, createUiDoctrine, UI_DOCTRINE_SKILL } = await load('lib/ui-doctrine.ts');
const { createRelevantGuidance } = await load('lib/relevant-guidance.ts');
const { TYPED_DECISIONS } = await load('lib/micro-intelligence/jev-decisions.ts');

const judge = (noul) => async () => ({ ok: true, answers: { supported: { noul } }, usage: { inputTokens: 200, cached: false, costUsd: 0 } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('the embedded skill ships with frontmatter and the swap test', () => {
  const file = path.join(agent, 'skills', UI_DOCTRINE_SKILL, 'SKILL.md');
  const body = fs.readFileSync(file, 'utf8');
  assert.match(body, /^---\nname: design-slop-prevention\ndescription: .{40,}\n---/);
  for (const anchor of ['Generation 1: indigo/purple SaaS', 'Generation 2: cream/terracotta editorial', 'Operating procedure for agents', 'swap test'])
    assert.ok(body.includes(anchor), anchor);
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

test('a weak request becomes interface work only when Jev says so, without blocking the turn', async () => {
  for (const [score, expected] of [[0.95, true], [0.05, false]]) {
    const activations = [];
    const doctrine = createUiDoctrine({ skillFile: () => '/skills/d/SKILL.md', isRead: () => false, judge: judge(score), onActive: (r) => activations.push(r) });
    doctrine.observePrompt('Make the onboarding feel less clunky and update the screen style');
    assert.equal(doctrine.isActive(), false, 'verdict is asynchronous');
    await settle();
    assert.equal(doctrine.isActive(), expected, String(score));
    assert.equal(activations.length, expected ? 1 : 0);
  }
});

test('a superseded request cannot activate the next one', async () => {
  const doctrine = createUiDoctrine({ skillFile: () => '/skills/d/SKILL.md', isRead: () => false, judge: judge(0.95) });
  doctrine.observePrompt('Make the screen style less clunky');
  doctrine.observePrompt('Refactor the parser');
  await settle();
  assert.equal(doctrine.isActive(), false);
});

test('UI detection offers optional guidance and a read clears it', () => {
  let read = false;
  const doctrine = createUiDoctrine({ skillFile: () => '/skills/d/SKILL.md', isRead: () => read });
  doctrine.observeFile('src/parser.ts');assert.equal(doctrine.contextText(),undefined);
  doctrine.observeFile('src/App.tsx');
  assert.match(doctrine.contextText(),/optional/);assert.match(doctrine.contextText(),/"\/skills\/d\/SKILL\.md"/);
  assert.doesNotMatch(doctrine.contextText(),/required reading|mandatory|read.*first/);
  read = true;assert.equal(doctrine.contextText(),undefined);
});

function fixture({ withSkill = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-doctrine-'));
  const skillFile = path.join(dir, 'skills', 'design-slop-prevention', 'SKILL.md');
  fs.mkdirSync(path.dirname(skillFile), { recursive: true });
  fs.writeFileSync(skillFile, '---\nname: design-slop-prevention\ndescription: doctrine\n---\n# Doctrine\n');
  const handlers = {}, entries = [], ctx = { cwd: dir, sessionManager: { getBranch: () => entries } };
  const g = createRelevantGuidance({ getActiveTools: () => ['read', 'write', 'edit', 'skill_review'], appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    on: (name, fn) => { (handlers[name] ??= []).push(fn); } });
  g.restore(ctx);
  const skills = withSkill ? [{ name: 'design-slop-prevention', description: 'doctrine', filePath: skillFile }] : [];
  return { g, dir, skillFile, ctx,
    start(prompt) { g.userInput(); g.start({ prompt, systemPrompt: '', systemPromptOptions: { skills } }, ctx); },
    context() { const out = handlers.context.map((fn) => fn({ messages: [{ role: 'user', content: 'hi' }] }, ctx)).find(Boolean); return out?.messages?.filter((m) => m.customType === 'ui-doctrine-context') ?? []; },
    write(file, content = '') { return g.beforeToolCall({ toolName: 'write', input: { path: path.join(dir, file), content } }); } };
}

test('UI guidance is available while every write proceeds without a skill read', async () => {
  const f = fixture();
  f.start('Build a landing page for my bakery');
  await settle();
  assert.equal(f.context().length, 1, 'the demand rides the context while the skill is unread');
  assert.match(f.context()[0].content, new RegExp(f.skillFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for(let i=0;i<4;i++)assert.equal(f.write('site/index.html'),undefined);
  assert.match(f.context()[0].content,/optional/);
  f.start('Build a landing page for my bakery');
  await settle();
  f.g.record({ toolName: 'read', input: { path: f.skillFile }, isError: false, content: [{ type: 'text', text: fs.readFileSync(f.skillFile, 'utf8') }] });
  assert.equal(f.context().length, 0, 'a read clears the demand');
  assert.equal(f.write('site/index.html'), undefined);
});

test('non-interface and read-only requests are never blocked or reminded', async () => {
  const f = fixture();
  f.start('Add a caching layer to the parser');
  await settle();
  assert.equal(f.context().length, 0);
  assert.equal(f.write('src/cache.ts'), undefined);
  f.start('Explain how the landing page works');
  await settle();
  assert.equal(f.context().length, 0);
  assert.equal(f.write('notes/tmp.txt'), undefined);
});

test('observed interface edits receive advice even when the request named no interface', () => {
  const f = fixture();
  f.start('Ship the feature');
  assert.equal(f.write('src/components/Panel.tsx'),undefined);
  assert.match(f.context()[0].content,/optional/);
});

test('subagents without a skill catalog still learn the installed skill path', () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    const f = fixture({ withSkill: false });
    process.env.PI_CODING_AGENT_DIR = f.dir;
    f.start('Ship the feature');
    assert.equal(f.write('index.html'),undefined);
    assert.ok(f.context()[0].content.includes(JSON.stringify(f.skillFile)));
    f.g.record({ toolName: 'read', input: { path: f.skillFile }, isError: false, content: [{ type: 'text', text: 'x' }] });
    assert.equal(f.write('index.html'), undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
