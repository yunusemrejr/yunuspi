import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = path.resolve(import.meta.dirname, '..');
const root = [projectRoot, path.resolve(projectRoot, '..')].find((candidate) =>
  fs.existsSync(path.join(candidate, 'agent/extensions/lib/activity-indicators.ts')) &&
  fs.existsSync(path.join(candidate, 'core/coding-agent/src/core/messages.js')),
);
assert.ok(root, 'activity-context regression test requires the YunusPi source tree');
const { createActivityIndicators } = await import(pathToFileURL(path.join(root, 'agent/extensions/lib/activity-indicators.ts')));
const { convertToLlm } = await import(pathToFileURL(path.join(root, 'core/coding-agent/src/core/messages.js')));
const { estimateTokens } = await import(pathToFileURL(path.join(root, 'core/coding-agent/src/core/compaction/compaction.js')));
const { convertToLlm: convertHarnessToLlm } = await import(pathToFileURL(path.join(root, 'core/agent/src/harness/messages.js')));
const { estimateTokens: estimateHarnessTokens } = await import(pathToFileURL(path.join(root, 'core/agent/src/harness/compaction/compaction.js')));
const { sessionEntryToContextMessages } = await import(pathToFileURL(path.join(root, 'core/coding-agent/src/core/session-manager.js')));
const { prepareBranchEntries } = await import(pathToFileURL(path.join(root, 'core/coding-agent/src/core/compaction/branch-summarization.js')));

test('harness activity remains visible but is excluded from model context after reload', () => {
  const sent = [];
  const activity = createActivityIndicators((message, options) => sent.push({ message, options }));
  try {
    activity.note('local.refresh', { route: 'ollama-local', outcome: 'unavailable', isError: true });
    assert.equal(sent.length, 1);
    const { message, options } = sent[0];
    assert.equal(message.customType, 'harness-activity');
    assert.equal(message.display, true);
    assert.equal(message.excludeFromContext, true);
    assert.match(message.content, /ollama-local/);
    assert.equal(options.triggerTurn, false);

    const runtimeMessage = {
      role: 'custom',
      ...message,
      timestamp: Date.now(),
    };
    assert.deepEqual(convertToLlm([runtimeMessage]), []);
    assert.deepEqual(convertHarnessToLlm([runtimeMessage]), []);

    const persistedEntry = {
      type: 'custom_message',
      customType: message.customType,
      content: message.content,
      display: message.display,
      details: message.details,
      excludeFromContext: true,
      timestamp: new Date().toISOString(),
    };
    assert.deepEqual(sessionEntryToContextMessages(persistedEntry), []);
    assert.equal(prepareBranchEntries([persistedEntry]).messages.length, 0);
    assert.equal(estimateTokens(runtimeMessage), 0);
    assert.equal(estimateHarnessTokens(runtimeMessage), 0);
  } finally {
    activity.dispose();
  }
});

test('ordinary custom messages retain their existing model-context behavior', () => {
  const message = {
    role: 'custom',
    customType: 'user-directed-context',
    content: 'Use this user-provided context.',
    display: false,
    timestamp: Date.now(),
  };
  assert.deepEqual(convertToLlm([message]), [{
    role: 'user',
    content: [{ type: 'text', text: message.content }],
    timestamp: message.timestamp,
  }]);
});
