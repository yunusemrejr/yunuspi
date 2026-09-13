import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
let agent = path.resolve(import.meta.dirname, '../agent');
try { await fs.access(agent); } catch { agent = path.resolve(import.meta.dirname, '../..'); }
const { registerHarnessActivity, HARNESS_ACTIVITY } = await import(pathToFileURL(path.join(agent, 'extensions/lib/harness-activity.ts')));
function fixture() {
  const hooks = new Map(), writes = [];
  const pi = { on: (event, handler) => hooks.set(event, handler) };
  const service = registerHarnessActivity(pi);
  const ctx = (id = 'session-a', extra = {}) => ({ cwd: '/project', sessionManager: { getSessionId: () => id }, ui: { setStatus: (key, text) => writes.push({ key, text }) }, ...extra });
  const current = ctx();
  const emit = (event, value = {}, context = current) => hooks.get(event)?.(value, context);
  emit('session_start');
  return { pi, service, writes, ctx, emit, close: () => emit('session_shutdown') };
}

test('native tools and automatic helpers share compact safe UI-only status with overlapping IDs', () => {
  const f = fixture();
  try {
    assert.equal(registerHarnessActivity(f.pi), f.service);
    assert.equal(globalThis[HARNESS_ACTIVITY], f.service);
    const finish = f.service({ action: 'start', id: 'auto', label: 'skills' });
    f.emit('tool_execution_start', { toolCallId: 'auto', toolName: 'render_see', args: { secret: 'PRIVATE-ARGUMENT' } });
    assert.match(f.writes.at(-1).text, /Skill discovery · Browser/);
    finish();
    assert.match(f.writes.at(-1).text, /^◌ Browser$/);
    f.emit('tool_execution_end', { toolCallId: 'auto', toolName: 'render_see', result: { text: 'PRIVATE-RESULT' } });
    assert.match(f.writes.at(-1).text, /Browser finished/);
    assert.doesNotMatch(JSON.stringify(f.writes), /PRIVATE|auto|\/project/);
    assert.ok(f.writes.every(write => write.key === '00-harness-activity'));
    f.emit('tool_execution_start', { toolCallId: 'probe', toolName: 'custom_probe' });
    assert.equal(f.writes.at(-1).text, '◌ Custom probe');
    assert.doesNotThrow(() => f.service({ action: 'start', id: 'closed', label: 'tool' }, { sessionManager: { getSessionId() { throw Error('closed'); } }, ui: { setStatus() {} } }));
  } finally { f.close(); }
});

test('switch, abort and run end clear status and stale closures cannot finish reused IDs', () => {
  const f = fixture();
  try {
    const old = f.service({ action: 'start', id: 'same', label: 'skills' });
    const replacement = f.service({ action: 'start', id: 'same', label: 'browser' });
    old();
    assert.match(f.writes.at(-1).text, /^◌ Browser$/);
    f.emit('session_before_switch');
    assert.equal(f.writes.at(-1).text, undefined);
    const next = f.ctx('session-b');
    f.emit('session_switch', {}, next);
    f.service({ action: 'start', id: 'same', label: 'review' }, next);
    replacement();
    assert.match(f.writes.at(-1).text, /^◌ Review$/);
    f.service({ action: 'end', id: 'same' }, f.ctx('session-a'));
    assert.match(f.writes.at(-1).text, /^◌ Review$/);
    f.emit('agent_end', {}, next);
    assert.equal(f.writes.at(-1).text, undefined);
    assert.equal(f.service({ action: 'start', id: 'late', label: 'model' }, next), undefined);
    const controller = new AbortController(), active = f.ctx('session-b', { signal: controller.signal });
    f.emit('before_agent_start', {}, active);
    f.service({ action: 'start', id: 'new', label: 'model' }, active);
    controller.abort();
    assert.equal(f.writes.at(-1).text, undefined);
  } finally { f.close(); }
});

test('activity and text remain bounded, unknown labels and headless work expose no values', () => {
  const f = fixture();
  try {
    assert.equal(f.service({ action: 'start', id: 'private', label: 'PRIVATE-LABEL' }), undefined);
    assert.equal(f.service({ action: 'start', id: 'headless', label: 'tool' }, f.ctx('session-a', { hasUI: false })), undefined);
    for (let i = 0; i < 100; i++) f.emit('tool_execution_start', { toolCallId: String(i), toolName: 'PRIVATE-TOOL-NAME' });
    assert.equal(f.writes.at(-1).text, '◌ Tool ×64');
    assert.ok(f.writes.length <= 64);
    assert.doesNotMatch(JSON.stringify(f.writes), /PRIVATE/);
    assert.ok(f.writes.every(write => (write.text ?? '').length < 80));
  } finally { f.close(); }
});

test('fast completion clears after a short UI timer without model events or persisted messages', async () => {
  const f = fixture();
  try {
    f.service({ action: 'start', id: 'fast', label: 'skills' })();
    assert.equal(f.writes.at(-1).text, '· Skill discovery finished');
    await new Promise(resolve => setTimeout(resolve, 1600));
    assert.equal(f.writes.at(-1).text, undefined);
  } finally { f.close(); }
  assert.equal(globalThis[HARNESS_ACTIVITY], undefined);
});
