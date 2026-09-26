import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')].find(p => fs.existsSync(path.join(p, 'extensions/session-hooks.ts')));
const load = p => import(pathToFileURL(path.join(agent, 'extensions', p)));
const { isDeployCommand, isLiveByteVerification } = await load('lib/session-hooks.ts');
const { collectVerificationLines } = await load('lib/continuation-notice.ts');
const { default: registerHooks } = await load('session-hooks.ts');

test('live verification means remote bytes compared, not a status probe or a local fetch', () => {
  assert.ok(isDeployCommand('bash', { command: 'git push namecheap main 2>&1 | tail -5' }));
  assert.ok(isLiveByteVerification('bash', { command: 'curl -s https://example.com/assets/me.jpg | sha256sum; sha256sum assets/me.jpg' }));
  assert.ok(isLiveByteVerification('bash', { command: 'curl -sI https://example.com/app.css | grep -i etag' }));
  assert.ok(isLiveByteVerification('http_request', { url: 'https://example.com/app.css' }));
  assert.ok(!isLiveByteVerification('bash', { command: 'curl -s https://example.com/ | grep -c hero' }), 'HTML grep is not a byte comparison');
  assert.ok(!isLiveByteVerification('bash', { command: 'curl -s http://127.0.0.1:8099/app.css | sha256sum' }), 'local server is not production');
  assert.ok(!isLiveByteVerification('http_request', { url: 'http://localhost:3000/' }));
});

test('a successful deploy keeps a verification receipt until live bytes are compared', () => {
  const handlers = new Map();
  registerHooks({ on: (name, handler) => handlers.set(name, handler) });
  const sessionManager = {};
  const ctx = { sessionManager };
  let id = 0;
  const run = (toolName, input, isError = false) => {
    const event = { toolCallId: `c${++id}`, toolName, input, isError, content: [{ type: 'text', text: 'ok' }] };
    handlers.get('tool_call')(event);
    return handlers.get('tool_result')(event, ctx);
  };
  handlers.get('session_start')();
  run('bash', { command: 'git push namecheap main' }, true);
  assert.deepEqual(collectVerificationLines(undefined, sessionManager), [], 'a failed push deployed nothing');
  run('bash', { command: 'git push namecheap main' });
  assert.match(collectVerificationLines(undefined, sessionManager)[0], /deploy: .*not verified live/);
  run('bash', { command: 'curl -s https://example.com/ | grep -c hero' });
  assert.equal(collectVerificationLines(undefined, sessionManager).length, 1, 'status/HTML probes do not clear it');
  run('bash', { command: 'curl -s https://example.com/img/me.jpg | sha256sum' });
  assert.deepEqual(collectVerificationLines(undefined, sessionManager), []);
  run('bash', { command: 'git push namecheap main && curl -s https://example.com/app.js | sha256sum' });
  assert.deepEqual(collectVerificationLines(undefined, sessionManager), [], 'deploy and verify in one call');
  handlers.get('session_shutdown')();
});

test('an older verification cannot acknowledge a deployment completed while it was running', () => {
  const handlers = new Map();
  registerHooks({ on: (name, handler) => handlers.set(name, handler) });
  const sessionManager = {}, ctx = { sessionManager };
  const deploy = (id) => {
    const event = { toolCallId: id, toolName: 'bash', input: { command: 'git push prod main' }, content: [], isError: false };
    handlers.get('tool_call')(event);
    handlers.get('tool_result')(event, ctx);
  };
  handlers.get('session_start')();
  deploy('first');
  const verify = { toolCallId: 'verify-first', toolName: 'bash', input: { command: 'curl -s https://example.com/app.js | sha256sum' }, content: [], isError: false };
  handlers.get('tool_call')(verify);
  deploy('second');
  handlers.get('tool_result')(verify, ctx);
  assert.equal(collectVerificationLines(undefined, sessionManager).length, 1, 'the second deployment still needs its own live verification');
  handlers.get('session_shutdown')();
});
