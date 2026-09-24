// What the user sees: background harness work is summarized in one live
// footer line, real actions (Guardian verdicts, hooks, local-model gating)
// get one clear transcript line each, and untrusted text cannot corrupt the
// terminal layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sanitizeDisplayText, stripTerminalSequences, visibleWidth } from '@yunuspi/tui';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(p => fs.existsSync(path.join(p, 'extensions/lib/harness-notice.ts')));
const load = p => import(pathToFileURL(path.join(agent, p)).href);
const A = await load('extensions/lib/activity-indicators.ts');
const { renderHarnessNotice } = await load('extensions/lib/harness-notice.ts');
const { matchHook } = await load('extensions/lib/session-hooks.ts');
const reminders = await load('extensions/reminders.ts');
const { initTheme, theme } = await import(pathToFileURL(path.join(root, 'core/coding-agent/src/modes/interactive/theme/theme.js')).href);
initTheme('dark');

test('untrusted text cannot move the cursor or inject escape sequences', () => {
  assert.equal(sanitizeDisplayText('ok\r\nnext'), 'ok\nnext');
  assert.equal(sanitizeDisplayText('downloading 10%\rdownloading 100%\ndone'), 'downloading 100%\ndone');
  assert.equal(sanitizeDisplayText('\x1b[2Jcleared\x1b]0;title\x07 text\u0000‮'), 'cleared text‮'.replace('‮', ''));
  assert.equal(sanitizeDisplayText(undefined), '');
  assert.equal(sanitizeDisplayText('tab\tkept'), 'tab\tkept');
});

test('harness notices render within any width and never leak control characters', () => {
  const notice = renderHarnessNotice({ icon: '⛨', title: 'Guardian · repeated failure', tone: 'warning', summary: 'guidance sent · WASM score 0.97', body: 'The same command failed\r\x1b[31m three times.', detail: 'expanded detail' }, { expanded: false }, theme);
  for (const width of [12, 30, 80]) for (const line of notice.render(width)) {
    assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
    assert.doesNotMatch(stripTerminalSequences(line), /[\x00-\x08\x0b-\x1f\x7f]/);
  }
  const text = notice.render(120).map(stripTerminalSequences).join('\n');
  assert.match(text, /Guardian · repeated failure/);
  assert.match(text, /expand tool output/);
  assert.match(renderHarnessNotice({ icon: '◉', title: 'x', detail: 'full text here' }, { expanded: true }, theme).render(80).map(stripTerminalSequences).join('\n'), /full text here/);
});

test('routine background work updates one live pulse; verdicts, hooks and gating are lines', async () => {
  const lines = [], pulses = [];
  const activity = A.createActivityIndicators((message) => lines.push(message), { set: text => pulses.push(text), available: () => true });
  for (let i = 1; i <= 5; i++) activity.note('guardian.observing', { count: i, evaluations: 0, decision: 'ready' });
  for (let i = 0; i < 4; i++) activity.note('ml.fuzzy.used', { count: 2 });
  activity.note('ml.needle.call', { op: 'rank', count: 3 });
  activity.note('skill.route', { route: 'java-platform-engineering' });
  activity.note('guardian.decision', { check: 'repeated-identical-failure', decision: 'abstained', score: 0.62, threshold: 0.95, evaluations: 1 });
  activity.note('hook.fired', { hook: 'deploy-verify-live', tool: 'bash', decision: 'guidance' });
  activity.note('skill.gate', { skill: 'all-about-odoo', decision: 'filtered', score: 0.21 });
  activity.note('ml.local.inference', { decision: 'answered', purpose: 'skill-relevance' });
  await new Promise(resolve => setTimeout(resolve, 1300));
  const kinds = lines.map(line => line.details.kind);
  assert.ok(!kinds.includes('guardian.observing'), 'heartbeats are not transcript lines');
  assert.ok(!kinds.includes('skill.route'), 'router matches are not transcript lines');
  assert.ok(!lines.some(line => line.details.label === 'Fuzzy matching'), 'ordering helpers stay in the pulse');
  const decision = lines.find(line => line.details.kind === 'guardian.decision');
  assert.match(decision.details.detail, /WASM score 0\.62 < 0\.95 · no intervention/);
  assert.match(lines.find(line => line.details.kind === 'hook.fired').details.detail, /on bash · workflow guidance added/);
  assert.match(lines.find(line => line.details.kind === 'skill.gate').details.detail, /Local LM off-topic hint filtered · P\(relevant\) 0\.21/);
  const pulse = pulses.at(-1);
  assert.match(pulse, /^harness · Guardian 5 checks · 1 WASM/);
  assert.match(pulse, /Needle3 1/); assert.match(pulse, /fuzzy 4/); assert.match(pulse, /hooks 1/); assert.match(pulse, /skill matches 1/);
  activity.reset();
  assert.equal(pulses.at(-1), undefined, 'a new session clears the pulse');
  activity.dispose();
});

test('without a footer the old transcript lines remain, so nothing becomes invisible', () => {
  const lines = [];
  const activity = A.createActivityIndicators((message) => lines.push(message), { set() {}, available: () => false });
  activity.note('ml.retrieval.used', { decision: 'fused' });
  return new Promise(resolve => queueMicrotask(() => { assert.ok(lines.some(line => line.details.label === 'Retrieval intelligence')); activity.dispose(); resolve(); }));
});

test('deploy and first-interface hooks fire on the right calls only', () => {
  assert.equal(matchHook('bash', { command: 'git push namecheap main' })?.key, 'deploy-verify-live');
  assert.equal(matchHook('bash', { command: 'rsync -az dist/ deploy@example.com:/var/www' })?.key, 'deploy-verify-live');
  assert.equal(matchHook('bash', { command: 'git push origin feature/x' })?.key, 'git-write-verify');
  assert.equal(matchHook('write', { path: 'public/index.html' })?.key, 'ui-first-render');
  assert.equal(matchHook('write', { path: 'src/server.ts' }), null);
});

test('a multi-line reminder is delivered as one line so every reader keeps it whole', () => {
  const st = { manual: [], workspaceWarnings: [], mutationAudit: [], hasPending: false };
  const text = reminders.reminderText(st, 'session-1', Date.now(), { todo: false, drift: false }, [{ id: 'r1', text: 'Keep output clear\nand never break the TUI', createdAt: 0, nextFireAt: 0, active: true, delivered: 0 }]);
  const line = text.split('\n').find(row => row.startsWith('[custom-reminder] '));
  assert.equal(line, '[custom-reminder] Keep output clear / and never break the TUI');
});
