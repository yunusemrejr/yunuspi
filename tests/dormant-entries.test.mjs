import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const entry = (name) => pathToFileURL(path.join(root, 'agent/extensions', name));

function recordingPi() {
  const calls = [];
  const pi = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'events') return { on() {}, emit() {} };
      return (...args) => { calls.push([String(prop), args]); };
    },
  });
  return { pi, calls };
}

test('retired-by-default entries register nothing and skip their impl while the lean gate is off', async () => {
  const prior = process.env.PI_LEAN_GATES;
  delete process.env.PI_LEAN_GATES;
  try {
    for (const name of ['session-observer.ts', 'adaptive-workflows.ts', 'project-intelligence.ts']) {
      const { default: factory } = await import(entry(name));
      const { pi, calls } = recordingPi();
      await factory(pi);
      assert.deepEqual(calls, [], `${name} must stay dormant without PI_LEAN_GATES=on`);
    }
  } finally {
    if (prior === undefined) delete process.env.PI_LEAN_GATES; else process.env.PI_LEAN_GATES = prior;
  }
});

test('with PI_LEAN_GATES=on the shim delegates to the real implementation', async () => {
  const prior = process.env.PI_LEAN_GATES;
  process.env.PI_LEAN_GATES = 'on';
  try {
    const { default: factory } = await import(entry('adaptive-workflows.ts'));
    const tools = new Map(), hooks = new Map();
    const pi = {
      on(name, fn) { hooks.set(name, fn); },
      registerTool(tool) { tools.set(tool.name, tool); },
      registerCommand() {},
      events: { on() {}, emit() {} },
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools() {},
      appendEntry() {},
      sendMessage() {},
    };
    await factory(pi);
    assert.ok(tools.has('task_pipeline') || hooks.size > 0, 'impl registration reached the api');
  } finally {
    if (prior === undefined) delete process.env.PI_LEAN_GATES; else process.env.PI_LEAN_GATES = prior;
  }
});
