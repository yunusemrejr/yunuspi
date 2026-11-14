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
  const pi = { registerCommand: (name, command) => commands.set(name, command) };
  team.default(pi);
  const ctx = { cwd, hasUI, mode: hasUI ? 'tui' : 'print', modelRegistry: { getAvailable: () => models }, ui };
  return { command: commands.get('team'), ctx, notices, asked };
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
  assert.match(advisor.notices.at(-1).message, /The advisor tool appears or disappears at the next session start\./);
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
    `${ROW_LABELS.advisor} — off`,
    `${ROW_LABELS.helperThinking} — xhigh`,
    `${ROW_LABELS.legworkThinking} — high`,
    `${ROW_LABELS.sideCalls} — legwork`,
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
