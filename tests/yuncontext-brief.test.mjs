import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const {
  default: registerYuncontext, YUNCONTEXT_BRIEF_HEAD, YUNCONTEXT_BRIEF_MAX_CHARS,
  fetchYuncontextBrief, yuncontextBriefOn, yuncontextBriefText,
} = await import(pathToFileURL(path.join(root, 'agent/extensions/yuncontext.ts')).href);

const reply = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });
const fakePi = () => {
  const handlers = {};
  const pi = {
    on: (name, fn) => { (handlers[name] ??= []).push(fn); },
    registerTool: () => {},
  };
  return { pi, handlers, brief: () => handlers.before_agent_start[0] };
};

test('the brief comes from the same tool call, for the working directory', async () => {
  const calls = [];
  const text = await fetchYuncontextBrief('/work/p', async (name, args) => {
    calls.push([name, args]);
    return reply('recent: y1 fix worked');
  });
  assert.deepEqual(calls, [['yuncontext', { cwd: '/work/p' }]]);
  assert.equal(text, `${YUNCONTEXT_BRIEF_HEAD}\nrecent: y1 fix worked`);
});

test('the result is capped at 1,200 characters; failures and empty results add nothing', async () => {
  const long = 'x'.repeat(YUNCONTEXT_BRIEF_MAX_CHARS + 500);
  const text = yuncontextBriefText(reply(long));
  assert.equal(text, `${YUNCONTEXT_BRIEF_HEAD}\n${'x'.repeat(YUNCONTEXT_BRIEF_MAX_CHARS)}`);
  assert.equal(yuncontextBriefText(reply('ignored', true)), undefined);
  assert.equal(yuncontextBriefText(reply('   ')), undefined);
  assert.equal(yuncontextBriefText(reply('yuncontext is not running right now; carry on without it.')), undefined);
  await assert.rejects(() => fetchYuncontextBrief('/p', async () => { throw new Error('offline'); }));
});

test('the first prompt of a session gets the brief once; a failure stays quiet', async () => {
  const { pi, handlers, brief } = fakePi();
  registerYuncontext(pi, { fetchBrief: async () => 'BRIEF' });
  const first = await brief()({}, { cwd: '/work/p' });
  assert.equal(first.message.customType, 'yuncontext-brief');
  assert.equal(first.message.display, false);
  assert.equal(first.message.content, 'BRIEF');
  assert.equal(await brief()({}, { cwd: '/work/p' }), undefined, 'only the first prompt');
  handlers.session_switch[0]();
  assert.ok(await brief()({}, { cwd: '/work/p' }), 'a new session gets its own first brief');

  const failing = fakePi();
  registerYuncontext(failing.pi, { fetchBrief: async () => undefined });
  assert.equal(await failing.brief()({}, { cwd: '/work/p' }), undefined);
});

test('a resumed session that already carries a brief gets no second copy', async () => {
  const { pi, handlers, brief } = fakePi();
  let fetched = 0;
  registerYuncontext(pi, { fetchBrief: async () => { fetched++; return 'BRIEF'; } });
  handlers.session_switch[0]();
  const resumed = { cwd: '/work/p', sessionManager: { getBranch: () => [{ type: 'custom_message', customType: 'yuncontext-brief', content: 'OLD' }] } };
  assert.equal(await brief()({}, resumed), undefined);
  assert.equal(fetched, 0, 'no fetch for a brief the history already holds');
});

test('a subagent child gets no automatic brief', async () => {
  const { pi, brief } = fakePi();
  registerYuncontext(pi, { fetchBrief: async () => 'BRIEF' });
  const before = process.env.PI_SUBAGENT_CHILD;
  process.env.PI_SUBAGENT_CHILD = '1';
  try {
    assert.equal(await brief()({}, { cwd: '/work/p' }), undefined);
  } finally {
    if (before === undefined) delete process.env.PI_SUBAGENT_CHILD; else process.env.PI_SUBAGENT_CHILD = before;
  }
});

test('the switch turns the brief off', async () => {
  assert.equal(yuncontextBriefOn('0'), false);
  assert.equal(yuncontextBriefOn(undefined), true);
  const { pi, brief } = fakePi();
  registerYuncontext(pi, { fetchBrief: async () => 'BRIEF' });
  const before = process.env.YUNUSPI_YUNCONTEXT_BRIEF;
  process.env.YUNUSPI_YUNCONTEXT_BRIEF = '0';
  try {
    assert.equal(await brief()({}, { cwd: '/work/p' }), undefined);
  } finally {
    if (before === undefined) delete process.env.YUNUSPI_YUNCONTEXT_BRIEF; else process.env.YUNUSPI_YUNCONTEXT_BRIEF = before;
  }
});
