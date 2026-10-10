import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import { actionTool, choices } from '../agent/extensions/lib/tool-schema.ts';

const parts = [
  { name: 'mail_send', parameters: Type.Object({ subject: Type.String({ minLength: 3 }), text: Type.Optional(Type.String()) }), execute: async (_id, params) => ({ sent: params.subject }) },
  { name: 'mail_search', parameters: Type.Object({ query: Type.String({ minLength: 2 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }), execute: async (_id, params) => ({ found: params.query }) },
];
const tool = actionTool({ name: 'mail', label: 'Mail', description: 'Mail', prefix: 'mail_', promptGuidelines: ['one'] }, parts);

test('an action tool exposes one schema with the union of its parts and dispatches by action', async () => {
  assert.equal(tool.name, 'mail');
  assert.deepEqual(tool.parameters.properties.action.enum, ['send', 'search']);
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['action', 'limit', 'query', 'subject', 'text']);
  assert.deepEqual(tool.promptGuidelines, ['one']);
  assert.deepEqual(await tool.execute('1', { action: 'send', subject: 'hello' }), { sent: 'hello' });
  assert.deepEqual(await tool.execute('2', { action: 'search', query: 'abc', limit: 3 }), { found: 'abc' });
});

test('an action tool refuses exactly what the part refused', async () => {
  await assert.rejects(tool.execute('3', { action: 'send', subject: 'x' }), /mail send:.*at \/subject/);
  await assert.rejects(tool.execute('4', { action: 'search' }), /mail search:/);
  await assert.rejects(tool.execute('5', { action: 'search', query: 'abc', limit: 99 }), /limit/);
  await assert.rejects(tool.execute('6', { action: 'delete' }), /Unknown action "delete"; use send, search/);
});
