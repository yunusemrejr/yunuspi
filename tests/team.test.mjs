// The one reader of the `team` and `run` settings blocks: validation, the
// global-then-project merge, role precedence, role routes and side-call models.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJiti } from 'jiti';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-team-'));
const agentDir = path.join(root, 'agent');
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => fs.rmSync(root, { recursive: true, force: true }));

const jiti = createJiti(import.meta.dirname);
const team = await jiti.import('../agent/extensions/lib/team.ts');

const session = { provider: 'test', id: 'main-model' };
const legwork = { provider: 'test', id: 'small-model' };
const helper = { provider: 'test', id: 'mid-model' };

function reset(globalSettings, projectSettings) {
  fs.rmSync(agentDir, { recursive: true, force: true });
  fs.mkdirSync(agentDir, { recursive: true });
  if (globalSettings !== undefined) fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify(globalSettings));
  const cwd = fs.mkdtempSync(path.join(root, 'project-'));
  if (projectSettings !== undefined) {
    fs.mkdirSync(path.join(cwd, '.pi'));
    fs.writeFileSync(path.join(cwd, '.pi', 'settings.json'), JSON.stringify(projectSettings));
  }
  return cwd;
}

test('no block resolves to today: every role inherits the session model', () => {
  const cwd = reset();
  const config = team.loadTeamConfig(cwd);
  assert.deepEqual(config.team, {
    helper: 'inherit', legwork: 'inherit', advisor: 'off', roles: {},
    maxThinking: { helper: 'xhigh', legwork: 'high' }, sideCalls: 'legwork',
  });
  assert.deepEqual(config.run, { softMinutes: 60, softUsd: 1 });
  for (const role of team.TEAM_ROLES) assert.equal(team.resolveRoleRoute(role, config.team, session), 'test/main-model');
  assert.equal(team.sideCallModel({ model: session, modelRegistry: { getAvailable: () => [session, legwork] } }, config), session);
});

test('the project file overrides the global file key by key and never wipes the keys it leaves out', () => {
  const cwd = reset(
    { team: { helper: 'test/mid-model', legwork: 'test/small-model', roles: { scout: 'main', worker: 'legwork' }, maxThinking: { legwork: 'medium' } }, run: { softMinutes: 30, softUsd: 2 } },
    { team: { legwork: 'inherit', roles: { worker: 'helper' } }, run: { softUsd: 0 } },
  );
  const config = team.loadTeamConfig(cwd);
  assert.equal(config.team.helper, 'test/mid-model', 'a global key the project does not set stays');
  assert.equal(config.team.legwork, 'inherit', 'a project key wins');
  assert.deepEqual(config.team.roles, { scout: 'main', worker: 'helper' });
  assert.deepEqual(config.team.maxThinking, { helper: 'xhigh', legwork: 'medium' });
  assert.deepEqual(config.run, { softMinutes: 30, softUsd: 0 }, '0 is a value, not a missing key');
});

test('invalid values fail loudly with the file and what is accepted', () => {
  const bad = [
    [{ team: { helper: 'mid-model' } }, /invalid 'team\.helper'; expected "inherit" or a model as "provider\/model-id"/],
    [{ team: { advisor: 'inherit' } }, /invalid 'team\.advisor'; expected "off" or a model/],
    [{ team: { sideCalls: 'always' } }, /invalid 'team\.sideCalls'; expected "legwork" or "session"/],
    [{ team: { roles: { scout: 'boss' } } }, /invalid 'team\.roles\.scout'; expected "main", "helper", "legwork"/],
    [{ team: { maxThinking: { helper: 'extreme' } } }, /invalid 'team\.maxThinking\.helper'; expected one of/],
    [{ team: { maxThinking: { main: 'high' } } }, /invalid 'team\.maxThinking\.main'; expected helper or legwork/],
    [{ team: { colour: 'red' } }, /invalid 'team\.colour'; expected one of helper, legwork, advisor, roles, maxThinking, sideCalls/],
    [{ team: [] }, /invalid 'team'; expected an object/],
    [{ run: { softMinutes: -1 } }, /invalid 'run\.softMinutes'; expected a number of 0 or more/],
    [{ run: { softUsd: '1' } }, /invalid 'run\.softUsd'/],
    [{ run: { hardUsd: 1 } }, /invalid 'run\.hardUsd'; expected softMinutes or softUsd/],
  ];
  for (const [settings, pattern] of bad) {
    const cwd = reset(settings);
    assert.throws(() => team.loadTeamConfig(cwd), (error) => pattern.test(error.message) && error.message.includes(path.join(agentDir, 'settings.json')), JSON.stringify(settings));
  }
  const cwd = reset({}, { team: { legwork: 'nope' } });
  assert.throws(() => team.loadTeamConfig(cwd), (error) => error.message.includes(path.join(cwd, '.pi', 'settings.json')), 'a bad project file names the project file');
});

test('role precedence: call, then settings, then the agent frontmatter, then the built-in table, then main', () => {
  const settings = { roles: { scout: 'main' } };
  const agent = (name, role) => ({ name, extraFields: role ? { role } : {} });
  assert.equal(team.resolveAgentRole(agent('scout'), settings, 'helper'), 'helper', 'the call wins');
  assert.equal(team.resolveAgentRole(agent('scout', 'legwork'), settings), 'main', 'settings beat the frontmatter');
  assert.equal(team.resolveAgentRole(agent('planner', 'helper'), { roles: {} }), 'helper', 'frontmatter beats the built-in table');
  assert.equal(team.resolveAgentRole(agent('scout', 'main'), { roles: {} }), 'main');
  for (const [name, role] of [['scout', 'legwork'], ['researcher', 'legwork'], ['delegate', 'legwork'], ['worker', 'helper'], ['reviewer', 'helper'], ['oracle', 'main'], ['anything-else', 'main']]) {
    assert.equal(team.resolveAgentRole(agent(name), { roles: {} }), role, name);
  }
  assert.throws(() => team.resolveAgentRole(agent('planner', 'boss'), { roles: {} }), /Agent 'planner' has invalid role frontmatter 'boss'; expected main, helper, legwork/);
});

test('a role route is the session model unless the role names another that is available', () => {
  const settings = { helper: 'test/mid-model', legwork: 'inherit' };
  const available = [session, legwork, helper];
  assert.equal(team.resolveRoleRoute('helper', settings, session, available), 'test/mid-model');
  assert.equal(team.resolveRoleRoute('legwork', settings, session, available), 'test/main-model');
  assert.equal(team.resolveRoleRoute('main', settings, session, available), 'test/main-model', 'main never leaves the session model');
  assert.throws(
    () => team.resolveRoleRoute('helper', { helper: 'test/gone', legwork: 'inherit' }, session, available),
    { message: "team.helper is set to 'test/gone', which is not among the available models. Pick another with /team." },
  );
  assert.throws(() => team.resolveRoleRoute('legwork', settings, undefined), /no model selected/);
});

test('the thinking ceiling of a role is its configured cap; main has none', () => {
  const settings = { maxThinking: { helper: 'xhigh', legwork: 'low' } };
  assert.equal(team.roleThinkingCeiling('legwork', settings), 'low');
  assert.equal(team.roleThinkingCeiling('helper', settings), 'xhigh');
  assert.equal(team.roleThinkingCeiling('main', settings), undefined);
});

test('side calls use the legwork model when allowed, set and available, else the session model', () => {
  const registry = { getAvailable: () => [session, legwork] };
  const ctx = { model: session, modelRegistry: registry };
  const configured = (patch) => team.mergeTeamPatches({ team: patch, run: {} });
  assert.equal(team.sideCallModel(ctx, configured({ legwork: 'test/small-model' })), legwork);
  assert.equal(team.sideCallModel(ctx, configured({ legwork: 'test/small-model', sideCalls: 'session' })), session);
  assert.equal(team.sideCallModel(ctx, configured({ legwork: 'test/gone' })), session, 'an unavailable model falls back to the session model');
  assert.equal(team.sideCallModel(ctx, configured({})), session);
  const cwd = reset({ team: { legwork: 'test/small-model' } });
  assert.equal(team.sideCallModel({ ...ctx, cwd }), legwork, 'with no config passed it reads the settings files');
  const broken = reset({ team: { legwork: 'nope' } });
  assert.throws(() => team.sideCallModel({ ...ctx, cwd: broken }), /invalid 'team\.legwork'/, 'an invalid file is not hidden');
});

// The launch contract a model can ask for before launching: it must say what the launch will do.
test('the launch contract follows the role: fresh on the role model with its ceiling, fork only when asked', async () => {
  const { resolveSubagentLaunchContract } = await jiti.import('../agent/extensions/pi-subagents/src/api/preflight.ts');
  const cwd = reset(undefined, { team: { legwork: 'test/small-model', maxThinking: { legwork: 'low' } } });
  fs.mkdirSync(path.join(cwd, '.pi', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.pi', 'agents', 'forker.md'), '---\nname: forker\ndescription: Forks by default\ndefaultContext: fork\nrole: legwork\n---\nLook.\n');
  const sessionFile = path.join(cwd, 'parent.jsonl');
  fs.writeFileSync(sessionFile, '');
  const input = { agent: 'forker', agentScope: 'project', cwd, task: 'Look around', parentModel: session, parentSessionFile: sessionFile, parentLeafId: 'leaf', sessionRoot: path.join(cwd, 'sessions'), artifacts: false };
  const implicit = await resolveSubagentLaunchContract(input);
  assert.equal(implicit.ok, true, JSON.stringify(implicit));
  assert.equal(implicit.contract.context, 'fresh', 'a fork by the agent\'s default gives way to the role\'s model, as at launch');
  assert.equal(implicit.contract.model, 'test/small-model');
  assert.equal(implicit.contract.thinkingCeiling, 'low', 'the role\'s ceiling is part of the contract');
  const forked = await resolveSubagentLaunchContract({ ...input, context: 'fork' });
  assert.equal(forked.contract.context, 'fork');
  assert.equal(forked.contract.model, 'test/main-model', 'an explicit fork keeps the session model');
  assert.equal(forked.contract.thinkingCeiling, undefined, 'and has no role ceiling');
  const plain = reset(undefined, undefined);
  fs.mkdirSync(path.join(plain, '.pi', 'agents'), { recursive: true });
  fs.copyFileSync(path.join(cwd, '.pi', 'agents', 'forker.md'), path.join(plain, '.pi', 'agents', 'forker.md'));
  fs.writeFileSync(path.join(plain, 'parent.jsonl'), '');
  const unset = await resolveSubagentLaunchContract({ ...input, cwd: plain, parentSessionFile: path.join(plain, 'parent.jsonl'), sessionRoot: path.join(plain, 'sessions') });
  assert.equal(unset.contract.context, 'fork', 'with no team model the agent forks by its default as before');
});

test('a team setting the launch cannot use is reported under its own code, not as a missing session model', async () => {
  const { resolveSubagentLaunchContract } = await jiti.import('../agent/extensions/pi-subagents/src/api/preflight.ts');
  const cwd = reset(undefined, { team: { legwork: 'nope' } });
  const input = { agent: 'scout', agentScope: 'project', cwd, task: 'Look around', parentModel: session, sessionRoot: path.join(cwd, 'sessions'), artifacts: false };
  const bad = await resolveSubagentLaunchContract(input);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'invalid_team_settings');
  assert.match(bad.message, /invalid 'team\.legwork'/);
  const noModel = await resolveSubagentLaunchContract({ ...input, parentModel: undefined });
  assert.equal(noModel.code, 'missing_session_model');
  // An agent that forks by default must not hide the setting behind a fork the launch would not make.
  fs.mkdirSync(path.join(cwd, '.pi', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.pi', 'agents', 'forker.md'), '---\nname: forker\ndescription: Forks by default\ndefaultContext: fork\nrole: legwork\n---\nLook.\n');
  const sessionFile = path.join(cwd, 'parent.jsonl');
  fs.writeFileSync(sessionFile, '');
  const forkInput = { ...input, agent: 'forker', parentSessionFile: sessionFile, parentLeafId: 'leaf' };
  const implicit = await resolveSubagentLaunchContract(forkInput);
  assert.equal(implicit.code, 'invalid_team_settings', 'the launch of this agent fails on that setting, and so does the contract');
  const forked = await resolveSubagentLaunchContract({ ...forkInput, context: 'fork' });
  assert.equal(forked.ok, true, 'an explicit fork never looks at the role\'s model');
  assert.equal(forked.contract.context, 'fork');
});
