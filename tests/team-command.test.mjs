import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJiti } from 'jiti';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-team-command-'));
const agentDir = path.join(root, 'agent');
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => fs.rmSync(root, { recursive: true, force: true }));

const jiti = createJiti(import.meta.dirname);
const team = await jiti.import('../agent/extensions/team-command.ts');
const tiers = await jiti.import('../agent/extensions/lib/model-tiers.ts');
const { ROW_LABELS } = team;

const models = [
  { provider: 'test', id: 'model-a' },
  { provider: 'test', id: 'model-b' },
  { provider: 'test', id: 'model-c' },
];

/** The agent settings file reset to `settings` (or absent), and a fresh project directory. */
function reset(settings) {
  fs.rmSync(agentDir, { recursive: true, force: true });
  fs.mkdirSync(agentDir, { recursive: true });
  if (settings !== undefined) fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify(settings, null, 2));
  return fs.mkdtempSync(path.join(root, 'project-'));
}

const readAgentSettings = () => JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));

/** A command registration with a scripted UI: each select/input call takes the next queued answer. */
function fixture(cwd, { hasUI = true, selects = [], inputs = [] } = {}) {
  const commands = new Map();
  const notices = [];
  const asked = [];
  const ui = {
    select: async (title, options) => {
      asked.push({ kind: 'select', title, options });
      const answer = selects.shift();
      return (typeof answer === 'function' ? answer(title, options) : answer) ?? undefined;
    },
    input: async (title, placeholder) => {
      asked.push({ kind: 'input', title, placeholder });
      const answer = inputs.shift();
      return (typeof answer === 'function' ? answer(title, placeholder) : answer) ?? undefined;
    },
    confirm: async () => false,
    notify: (message, type) => notices.push({ message, type }),
    setStatus() {},
    setWidget() {},
  };
  const hooks = new Map();
  const pi = { registerCommand: (name, command) => commands.set(name, command), on: (event, handler) => hooks.set(event, handler) };
  team.default(pi);
  const ctx = { cwd, hasUI, mode: hasUI ? 'tui' : 'print', modelRegistry: { getAvailable: () => models }, ui };
  return { command: commands.get('team'), ctx, notices, asked, hooks };
}

const rowOption = (options, label) => options.find((option) => option.startsWith(label));

test('/team show prints the defaults when no team block exists', async () => {
  const cwd = reset(undefined);
  const f = fixture(cwd);
  await f.command.handler('show', f.ctx);
  assert.equal(f.notices.length, 1);
  const text = f.notices[0].message;
  assert.match(text, /^Helper model\s+same as the session$/m);
  assert.match(text, /^Legwork model\s+same as the session$/m);
  assert.match(text, /^Advisor model\s+off$/m);
  assert.match(text, /^Helper thinking ceiling\s+xhigh$/m);
  assert.match(text, /^Legwork thinking ceiling\s+high$/m);
  assert.match(text, /^Side calls\s+legwork$/m);
  assert.match(text, /^Run budget minutes\s+60$/m);
  assert.match(text, /^Run budget dollars\s+1$/m);
  for (const [agent, role] of [['scout', 'legwork'], ['researcher', 'legwork'], ['delegate', 'legwork'], ['worker', 'helper'], ['reviewer', 'helper'], ['oracle', 'main']]) {
    assert.match(text, new RegExp(`^\\s+${agent}\\s+${role}$`, 'm'), `${agent} shows its built-in role`);
  }
});

test('/team show reads the global block with the project file overriding each key it sets', async () => {
  const cwd = reset({
    team: { helper: 'test/model-a', advisor: 'test/model-c', maxThinking: { helper: 'max' }, roles: { reviewer: 'main' }, sideCalls: 'session' },
    run: { softMinutes: 30 },
  });
  fs.mkdirSync(path.join(cwd, '.pi'));
  fs.writeFileSync(path.join(cwd, '.pi', 'settings.json'), JSON.stringify({ team: { legwork: 'test/model-d' }, run: { softUsd: 1.5 } }));
  const f = fixture(cwd);
  await f.command.handler('show', f.ctx);
  const text = f.notices[0].message;
  assert.match(text, /^Helper model\s+test\/model-a$/m);
  assert.match(text, /^Legwork model\s+test\/model-d$/m, 'the project file wins for this key');
  assert.match(text, /^Advisor model\s+test\/model-c$/m);
  assert.match(text, /^Helper thinking ceiling\s+max$/m);
  assert.match(text, /^Side calls\s+session$/m);
  assert.match(text, /^Run budget minutes\s+30$/m);
  assert.match(text, /^Run budget dollars\s+1\.5$/m);
  assert.match(text, /^\s+reviewer\s+main$/m, 'a role set in settings replaces the built-in one');
});

test('a picker change is written through SettingsManager and keeps unrelated settings keys', async () => {
  const cwd = reset({ theme: 'x', defaultProvider: 'p' });
  const f = fixture(cwd, {
    selects: [
      (title, options) => rowOption(options, ROW_LABELS.helper),
      () => 'test/model-b',
      () => 'Done',
    ],
  });
  await f.command.handler('', f.ctx);
  const written = readAgentSettings();
  assert.equal(written.theme, 'x', 'an unrelated key survives the write');
  assert.equal(written.defaultProvider, 'p');
  assert.equal(written.team.helper, 'test/model-b');
  assert.match(f.notices.at(-1).message, /applies to children launched from now on/);
});

test('helper model set to a model and then back to "Same as the session" stores "inherit"', async () => {
  const cwd = reset(undefined);
  const first = fixture(cwd, {
    selects: [
      (title, options) => rowOption(options, ROW_LABELS.helper),
      () => 'test/model-a',
      () => 'Done',
    ],
  });
  await first.command.handler('', first.ctx);
  assert.equal(readAgentSettings().team.helper, 'test/model-a');

  const second = fixture(cwd, {
    selects: [
      (title, options) => rowOption(options, `${ROW_LABELS.helper} — test/model-a`),
      (title, options) => { assert.equal(options[0], 'Same as the session'); return 'Same as the session'; },
      () => 'Done',
    ],
  });
  await second.command.handler('', second.ctx);
  assert.equal(readAgentSettings().team.helper, 'inherit');
});

test('run budget minutes: "0" switches the limit off and is stored as 0', async () => {
  const cwd = reset({});
  const f = fixture(cwd, {
    selects: [(title, options) => rowOption(options, ROW_LABELS.minutes), () => 'Done'],
    inputs: [() => '0'],
  });
  await f.command.handler('', f.ctx);
  assert.equal(readAgentSettings().run.softMinutes, 0);
});

test('run budget input "abc" and "-1" are refused with one line and nothing is written', async () => {
  for (const answer of ['abc', '-1']) {
    const cwd = reset({ theme: 'x' });
    const f = fixture(cwd, {
      selects: [(title, options) => rowOption(options, ROW_LABELS.minutes), () => 'Done'],
      inputs: [() => answer],
    });
    await f.command.handler('', f.ctx);
    const error = f.notices.find((notice) => notice.type === 'error');
    assert.ok(error, `${answer} is refused`);
    assert.match(error.message, /^Run budget: minutes must be a number of 0 or more; nothing was changed\.$/);
    assert.deepEqual(readAgentSettings(), { theme: 'x' }, `${answer} writes nothing`);
  }
});

test('the advisor note appears only when the advisor value changed', async () => {
  const cwd = reset({});
  const helper = fixture(cwd, {
    selects: [
      (title, options) => rowOption(options, ROW_LABELS.helper),
      () => 'test/model-a',
      () => 'Done',
    ],
  });
  await helper.command.handler('', helper.ctx);
  assert.doesNotMatch(helper.notices.at(-1).message, /advisor/);

  const advisor = fixture(cwd, {
    selects: [
      (title, options) => rowOption(options, ROW_LABELS.advisor),
      (title, options) => { assert.equal(options[0], 'Off'); return 'test/model-c'; },
      () => 'Done',
    ],
  });
  await advisor.command.handler('', advisor.ctx);
  assert.match(advisor.notices.at(-1).message, /The advisor tool is added at your next message if it is missing; turning the advisor off makes its calls refuse\./);
  assert.equal(readAgentSettings().team.advisor, 'test/model-c');
});

test('the picker shows every row with its exact label and current value', async () => {
  const cwd = reset({ team: { helper: 'test/model-a' } });
  const f = fixture(cwd, { selects: [() => undefined] });
  await f.command.handler('', f.ctx);
  const options = f.asked[0].options;
  assert.deepEqual(options.slice(0, -1), [
    `${ROW_LABELS.helper} — test/model-a`,
    `${ROW_LABELS.legwork} — same as the session`,
    `${ROW_LABELS.sublegwork} — same as legwork`,
    `${ROW_LABELS.advisor} — off`,
    `${ROW_LABELS.consultant} — off`,
    `${ROW_LABELS.helperThinking} — xhigh`,
    `${ROW_LABELS.legworkThinking} — high`,
    `${ROW_LABELS.sideCalls} — legwork`,
    `${ROW_LABELS.free} — on · quota not read yet · no model measured yet`,
    `${ROW_LABELS.subscriptionPoints} — 3`,
    `${ROW_LABELS.paidVendors} — block`,
    `${ROW_LABELS.minutes} — 60`,
    `${ROW_LABELS.usd} — 1`,
    `${ROW_LABELS.roles} — built-in`,
  ]);
  assert.equal(options.at(-1), 'Done');

  const modelRow = fixture(cwd, {
    selects: [
      (title, options) => rowOption(options, ROW_LABELS.legwork),
      (title, options) => { assert.deepEqual(options, ['Same as the session', 'test/model-a', 'test/model-b', 'test/model-c']); return undefined; },
      () => undefined,
    ],
  });
  await modelRow.command.handler('', modelRow.ctx);
});

test('a session without a UI prints the show text instead of opening the picker', async () => {
  const cwd = reset({ team: { legwork: 'test/model-b' } });
  const f = fixture(cwd, { hasUI: false });
  await f.command.handler('', f.ctx);
  assert.equal(f.asked.length, 0, 'no picker was opened');
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0].message, /^Legwork model\s+test\/model-b$/m);
  assert.match(f.notices[0].message, /^Agent roles$/m);
});

test('an invalid settings file is reported in one line naming the file and the accepted values', async () => {
  const cwd = reset({ team: { helper: 42 } });
  const f = fixture(cwd);
  await f.command.handler('show', f.ctx);
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].type, 'error');
  const message = f.notices[0].message;
  assert.ok(message.includes(path.join(agentDir, 'settings.json')), 'the message names the file');
  assert.match(message, /expected "inherit" or a model as "provider\/model-id"/);
  assert.doesNotMatch(message, /\n/, 'one line');
});

test('an unknown argument gets the one-line usage', async () => {
  const cwd = reset(undefined);
  const f = fixture(cwd);
  await f.command.handler('sideways', f.ctx);
  assert.deepEqual(f.notices.map((notice) => notice.message), ['Usage: /team [show]']);
});

test('the /team model search keeps every option holding each word, and falls back to fuzzy for a typo', () => {
  const options = ['Same as the session', 'openai-codex/gpt-5.5', 'openrouter/qwen/qwen3-coder', 'openrouter/meta/llama-4', 'deepseek/deepseek-v4-flash'];
  const names = new Map([['openrouter/qwen/qwen3-coder', 'Qwen3 Coder']]);
  assert.deepEqual(team.filterModelOptions(options, ''), options);
  assert.deepEqual(team.filterModelOptions(options, 'codex'), ['openai-codex/gpt-5.5']);
  assert.deepEqual(team.filterModelOptions(options, 'OpenRouter'), ['openrouter/qwen/qwen3-coder', 'openrouter/meta/llama-4']);
  assert.deepEqual(team.filterModelOptions(options, 'openrouter coder', names), ['openrouter/qwen/qwen3-coder']);
  assert.ok(team.filterModelOptions(options, 'deepsek').includes('deepseek/deepseek-v4-flash'));
});

test('G: a query that begins a route lists that provider first, every other match stays below', () => {
  const options = ['Same as the session', 'deepinfra/deepseek-ai/DeepSeek-V4-Flash', 'deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro', 'openrouter/deepseek/deepseek-v4-flash'];
  assert.deepEqual(team.filterModelOptions(options, 'deepseek'), ['deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro', 'deepinfra/deepseek-ai/DeepSeek-V4-Flash', 'openrouter/deepseek/deepseek-v4-flash']);
  assert.deepEqual(team.filterModelOptions(options, 'deeps').slice(0, 2), ['deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro']);
});

const codexModels = ['gpt-5.6-terra', 'gpt-6-terra', 'gpt-6.1-terra', 'gpt-6.1-terra-pro', 'gpt-5.9-sol', 'gpt-5.10-sol', 'gpt-6-astra'].map((id) => ({ provider: 'openai-codex', id }));

test('each model picker offers a latest-<tier> selector per openai-codex tier, labelled with what it resolves to, before the exact ids', async () => {
  const cwd = reset(undefined);
  const f = fixture(cwd, { selects: [(title, options) => rowOption(options, ROW_LABELS.consultant), () => undefined, () => 'Done'] });
  f.ctx.modelRegistry = { getAvailable: () => [...models, ...codexModels] };
  await f.command.handler('', f.ctx);
  const options = f.asked[1].options;
  assert.deepEqual(options.slice(0, 4), ['Off', 'openai-codex/latest-astra', 'openai-codex/latest-sol', 'openai-codex/latest-terra']);
  assert.ok(options.indexOf('openai-codex/latest-terra') < options.indexOf('test/model-a'), 'selectors come before the exact ids');
  assert.equal(options.length, 4 + models.length + codexModels.length);
  assert.deepEqual(tiers.tierOptions(codexModels), [
    { setting: 'openai-codex/latest-astra', label: 'latest astra → gpt-6-astra' },
    { setting: 'openai-codex/latest-sol', label: 'latest sol → gpt-5.10-sol' },
    { setting: 'openai-codex/latest-terra', label: 'latest terra → gpt-6.1-terra' },
  ]);
  assert.deepEqual(tiers.tierOptions(models), [], 'no codex model, no selector');
});

test('the sublegwork row starts with "Same as legwork" and stores inherit; the consultant row starts with Off; a selector is stored as it is', async () => {
  const cwd = reset({ team: { legwork: 'test/model-a' } });
  const sub = fixture(cwd, { selects: [(title, options) => rowOption(options, ROW_LABELS.sublegwork), (title, options) => { assert.equal(options[0], 'Same as legwork'); return 'test/model-b'; }, () => 'Done'] });
  await sub.command.handler('', sub.ctx);
  assert.equal(readAgentSettings().team.sublegwork, 'test/model-b');
  const back = fixture(cwd, { selects: [(title, options) => rowOption(options, ROW_LABELS.sublegwork), () => 'Same as legwork', () => 'Done'] });
  await back.command.handler('', back.ctx);
  assert.equal(readAgentSettings().team.sublegwork, 'inherit');
  const consultant = fixture(cwd, { selects: [(title, options) => rowOption(options, ROW_LABELS.consultant), () => 'openai-codex/latest-astra', () => 'Done'] });
  consultant.ctx.modelRegistry = { getAvailable: () => codexModels };
  await consultant.command.handler('', consultant.ctx);
  assert.equal(readAgentSettings().team.consultant, 'openai-codex/latest-astra');
  assert.equal(readAgentSettings().team.legwork, 'test/model-a', 'the other keys stay');
  const off = fixture(cwd, { selects: [(title, options) => rowOption(options, ROW_LABELS.consultant), () => 'Off', () => 'Done'] });
  await off.command.handler('', off.ctx);
  assert.equal(readAgentSettings().team.consultant, 'off');
});

test('a model picker hides the routes the vendor policy refuses, until paid vendors are allowed', async () => {
  const forbidden = [{ provider: 'openrouter', id: 'anthropic/claude-x' }, { provider: 'openai', id: 'gpt-6' }, { provider: 'anthropic', id: 'claude-y' }];
  const open = [{ provider: 'openrouter', id: 'qwen/qwen3.8-flash' }, { provider: 'openrouter', id: 'openai/gpt-oss-120b' }, { provider: 'openai-codex', id: 'gpt-6-terra' }];
  const listed = async (settings, registry) => {
    const f = fixture(reset(settings), { selects: [(title, options) => rowOption(options, ROW_LABELS.helper), () => undefined, () => 'Done'] });
    f.ctx.modelRegistry = { getAvailable: () => [...forbidden, ...open], ...registry };
    await f.command.handler('', f.ctx);
    return f.asked[1].options;
  };
  const blocked = await listed(undefined);
  assert.deepEqual(blocked.filter((option) => option.includes('/')).sort(), ['openai-codex/gpt-6-terra', 'openai-codex/latest-terra', 'openrouter/openai/gpt-oss-120b', 'openrouter/qwen/qwen3.8-flash']);
  const allowed = await listed({ team: { paidVendors: 'allow' } });
  assert.ok(allowed.includes('openrouter/anthropic/claude-x') && allowed.includes('openai/gpt-6'));
  const oauth = await listed(undefined, { isUsingOAuth: (model) => model.provider === 'anthropic' });
  assert.ok(oauth.includes('anthropic/claude-y'), 'an OAuth login is a subscription');
  assert.ok(!oauth.includes('openai/gpt-6') && !oauth.includes('openrouter/anthropic/claude-x'));
});

test('the quota-points row takes a number of 0 or more, and paid vendors is block or allow', async () => {
  const cwd = reset(undefined);
  const points = fixture(cwd, { selects: [(title, options) => rowOption(options, ROW_LABELS.subscriptionPoints), () => 'Done'], inputs: ['5'] });
  await points.command.handler('', points.ctx);
  assert.equal(readAgentSettings().team.subscriptionPoints, 5);
  assert.match(points.asked.find((item) => item.kind === 'input').placeholder, /0 never falls back/);
  const zero = fixture(cwd, { selects: [(title, options) => rowOption(options, ROW_LABELS.subscriptionPoints), (title, options) => { assert.ok(rowOption(options, ROW_LABELS.subscriptionPoints).endsWith('— off'), '0 reads as off'); return 'Done'; }], inputs: ['0'] });
  await zero.command.handler('', zero.ctx);
  assert.equal(readAgentSettings().team.subscriptionPoints, 0);
  const bad = fixture(cwd, { selects: [(title, options) => rowOption(options, ROW_LABELS.subscriptionPoints), () => 'Done'], inputs: ['-2'] });
  await bad.command.handler('', bad.ctx);
  assert.equal(readAgentSettings().team.subscriptionPoints, 0, 'a refused answer changes nothing');
  assert.equal(bad.notices.at(-1).type, 'error');
  const vendors = fixture(cwd, { selects: [(title, options) => rowOption(options, ROW_LABELS.paidVendors), (title, options) => { assert.deepEqual(options, ['block', 'allow']); return 'allow'; }, () => 'Done'] });
  await vendors.command.handler('', vendors.ctx);
  assert.equal(readAgentSettings().team.paidVendors, 'allow');
});

test('/team show prints the new keys', async () => {
  const cwd = reset({ team: { sublegwork: 'openrouter/qwen/qwen3.8-flash', consultant: 'openai-codex/latest-astra', subscriptionPoints: 0, paidVendors: 'allow' } });
  const f = fixture(cwd);
  await f.command.handler('show', f.ctx);
  const text = f.notices[0].message;
  assert.match(text, /^Sub-legwork model\s+openrouter\/qwen\/qwen3\.8-flash$/m);
  assert.match(text, /^Consultant model\s+openai-codex\/latest-astra$/m);
  assert.match(text, /^ChatGPT quota points per session\s+off$/m);
  assert.match(text, /^Paid Claude, GPT, Gemini\s+allow$/m);
  const defaults = fixture(reset(undefined));
  await defaults.command.handler('show', defaults.ctx);
  assert.match(defaults.notices[0].message, /^Sub-legwork model\s+same as legwork$/m);
  assert.match(defaults.notices[0].message, /^Consultant model\s+off$/m);
  assert.match(defaults.notices[0].message, /^ChatGPT quota points per session\s+3$/m);
  assert.match(defaults.notices[0].message, /^Paid Claude, GPT, Gemini\s+block$/m);
});

test('while paid vendors are blocked a request to Claude, GPT or Gemini outside a subscription is stopped before it is sent', async () => {
  const claude = { provider: 'openrouter', id: 'anthropic/claude-x' };
  const runHooks = (f, model, ctxExtra = {}) => {
    const ctx = { ...f.ctx, ...ctxExtra };
    return [f.hooks.get('before_provider_request')({ type: 'before_provider_request', payload: {}, model }, ctx), f.hooks.get('before_auxiliary_provider_request')({ type: 'before_auxiliary_provider_request', payload: {}, model }, ctx)];
  };
  const f = fixture(reset(undefined));
  assert.deepEqual([...f.hooks.keys()].sort(), ['before_auxiliary_provider_request', 'before_provider_request']);
  const refuse = (model, ctxExtra) => assert.throws(() => runHooks(f, model, ctxExtra), (error) => error.code === 'PI_AUTONOMOUS_REQUEST_DENIED' && !error.message.includes('\n')
    && error.message.startsWith(`Blocked: ${model.provider}/${model.id} reaches `) && /Set team\.paidVendors to allow in \/team to permit it\.$/.test(error.message));
  refuse(claude);
  refuse({ provider: 'openai', id: 'gpt-6' });
  refuse({ provider: 'amazon-bedrock', id: 'anthropic.claude-3' });
  assert.throws(() => f.hooks.get('before_auxiliary_provider_request')({ model: claude }, f.ctx), /Blocked: openrouter\/anthropic\/claude-x reaches Claude/, 'side calls and compaction are covered');
  assert.throws(() => f.hooks.get('before_provider_request')({ payload: {} }, { ...f.ctx, model: claude }), /Blocked/, 'a request with no route metadata uses the session model');
  for (const model of [{ provider: 'openrouter', id: 'qwen/qwen3.8-flash' }, { provider: 'openai-codex', id: 'gpt-6.1-sol' }, { provider: 'openrouter', id: 'openai/gpt-oss-120b' }, { provider: 'openai', id: 'gpt-6', baseUrl: 'http://127.0.0.1:8123/v1' }]) {
    assert.deepEqual(runHooks(f, model), [undefined, undefined], `${model.provider}/${model.id} goes through`);
  }
  assert.deepEqual(runHooks(f, { provider: 'anthropic', id: 'claude-y' }, { modelRegistry: { isUsingOAuth: () => true } }), [undefined, undefined], 'an OAuth login is a subscription');
  refuse({ provider: 'anthropic', id: 'claude-y' }, { modelRegistry: { isUsingOAuth: () => false } });
  assert.deepEqual(f.hooks.get('before_provider_request')({ payload: {} }, { ...f.ctx, model: undefined }), undefined, 'nothing to judge, nothing stopped');
  const allow = fixture(reset({ team: { paidVendors: 'allow' } }));
  assert.deepEqual(runHooks(allow, claude), [undefined, undefined], 'allow lets it through');
  const broken = fixture(reset({ team: { paidVendors: 7 } }));
  assert.throws(() => runHooks(broken, claude), /Blocked/, 'an unreadable setting blocks');
});

test('a project file cannot allow paid vendors: only the global file can', async () => {
  const cwd = reset({ team: { paidVendors: 'allow' } });
  fs.mkdirSync(path.join(cwd, '.pi'));
  fs.writeFileSync(path.join(cwd, '.pi', 'settings.json'), JSON.stringify({ team: { paidVendors: 'allow' } }));
  const f = fixture(cwd);
  await f.command.handler('show', f.ctx);
  assert.equal(f.notices[0].type, 'error');
  assert.match(f.notices[0].message, new RegExp(`invalid 'team\\.paidVendors'; expected "block"; "allow" is accepted only in the global settings file`));
  assert.ok(f.notices[0].message.includes(path.join(cwd, '.pi', 'settings.json')));
  assert.throws(() => f.hooks.get('before_provider_request')({ payload: {}, model: { provider: 'openrouter', id: 'anthropic/claude-x' } }, f.ctx), /Blocked/, 'the guard fails closed');
  fs.writeFileSync(path.join(cwd, '.pi', 'settings.json'), JSON.stringify({ team: { paidVendors: 'block' } }));
  const tight = fixture(cwd);
  assert.throws(() => tight.hooks.get('before_provider_request')({ payload: {}, model: { provider: 'openrouter', id: 'anthropic/claude-x' } }, tight.ctx), /Blocked/, 'a project may tighten the global allow');
});
