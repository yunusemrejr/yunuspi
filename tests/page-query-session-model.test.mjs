import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// page-query.ts needs only the compat completion entry at runtime; the fixture
// supplies it so the test never loads the provider stack.
register('data:text/javascript,' + encodeURIComponent(`export function resolve(name, ctx, next) {
  const sources = {
    '@yunuspi/ai/compat': 'export async function complete() { throw new Error("direct completion must not run when the registry completes"); }',
  };
  return name in sources ? { url: 'data:text/javascript,' + encodeURIComponent(sources[name]), shortCircuit: true } : next(name, ctx);
}`), import.meta.url);

const { answerFromPage } = await import(pathToFileURL(path.resolve(import.meta.dirname, '../agent/extensions/pi-web-access/page-query.ts')).href);

const sessionModel = { provider: 'fixture', id: 'session', input: ['text'], contextWindow: 100_000 };
const input = { question: 'What port does it use?', pageText: 'The service listens on port 8080.', sourceUrl: 'https://example.test/docs' };

function sessionContext(model, calls) {
  const refuseRegistryLookup = () => { throw new Error('the registry must not be searched for an answer model'); };
  return {
    model,
    modelRegistry: {
      find: refuseRegistryLookup,
      getAvailable: refuseRegistryLookup,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test-key', headers: {} }),
      complete: async (requested, _context, options) => {
        calls.push({ model: requested, options });
        return { stopReason: 'stop', content: [{ type: 'text', text: 'Port 8080.' }] };
      },
    },
  };
}

// Point the web-search config directory at a fixture for one test. The config
// content is supplied per test, and the previous environment is restored after.
function useConfigDir(t, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-query-session-'));
  if (contents !== undefined) fs.writeFileSync(path.join(dir, 'web-search.json'), contents);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('page answers use the session model even when the config names a different answer model', async (t) => {
  useConfigDir(t, JSON.stringify({ fetch: { answerProvider: 'other', answerModel: 'big' } }));
  const calls = [];
  const answer = await answerFromPage(input, sessionContext(sessionModel, calls));
  assert.equal(answer.model, 'fixture/session');
  assert.equal(answer.text, 'Port 8080.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, sessionModel);
});

test('a malformed answer config is never read, so answering still works', async (t) => {
  useConfigDir(t, '{"fetch":{"answerModel":"big"');
  const calls = [];
  const answer = await answerFromPage(input, sessionContext(sessionModel, calls));
  assert.equal(answer.model, 'fixture/session');
  assert.equal(calls[0].model, sessionModel);
});

test('a per-call model argument is ignored; there is no answer-model override', async (t) => {
  useConfigDir(t, undefined);
  const calls = [];
  const answer = await answerFromPage({ ...input, model: 'other/big' }, sessionContext(sessionModel, calls));
  assert.equal(answer.model, 'fixture/session');
  assert.equal(calls[0].model, sessionModel);
});

test('a missing session model is a clear error and no other model is consulted', async (t) => {
  useConfigDir(t, undefined);
  await assert.rejects(
    answerFromPage(input, { model: undefined, modelRegistry: sessionContext(sessionModel, []).modelRegistry }),
    /No current model available for page answering/,
  );
});

test('a session model without text input is rejected', async (t) => {
  useConfigDir(t, undefined);
  await assert.rejects(
    answerFromPage(input, sessionContext({ ...sessionModel, input: ['image'] }, [])),
    /does not support text input: fixture\/session/,
  );
});
