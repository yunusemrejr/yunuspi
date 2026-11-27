import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEAM_ROLES, applyTeamValue, matchesQuery, modelRow, rankModels, readTeam, teamOptions, validTeamValue } from '../desktop/renderer/team-settings.mjs';
import { teamCatalog } from '../desktop/team-catalog.mjs';
import { SettingsManager } from '../core/coding-agent/dist/core/settings-manager.js';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-team-catalog-'));
const role = key => TEAM_ROLES.find(candidate => candidate.key === key);
const models = [{ provider: 'desktop-example', id: 'desktop-fixture' }, { provider: 'openrouter', id: 'vendor/model-a' }];

const defaults = { helper: 'inherit', legwork: 'inherit', sublegwork: 'inherit', advisor: 'off', consultant: 'off', paidVendors: 'block', subscriptionPoints: 3 };

test('a missing team block reads as the session model for the working roles, no advisor or consultant, paid vendors blocked and 3 quota points', () => {
  assert.deepEqual(readTeam(undefined), defaults);
  assert.deepEqual(readTeam({}), defaults);
  assert.deepEqual(readTeam({ helper: 'openrouter/vendor/model-a', advisor: 'off' }), { ...defaults, helper: 'openrouter/vendor/model-a' });
  assert.deepEqual(readTeam({ sublegwork: 'a/b', consultant: 'openai-codex/latest-astra', paidVendors: 'allow', subscriptionPoints: 0 }), { ...defaults, sublegwork: 'a/b', consultant: 'openai-codex/latest-astra', paidVendors: 'allow', subscriptionPoints: 0 });
  assert.deepEqual(readTeam({ paidVendors: 'maybe', subscriptionPoints: -1 }), defaults, 'a value the harness would refuse reads as the default');
});

test('helper and legwork offer the session model first, sub-legwork offers legwork, advisor and consultant offer Off', () => {
  for (const key of ['helper', 'legwork']) assert.deepEqual(teamOptions(role(key), [], 'inherit')[0], { value: 'inherit', label: 'Same as the session', selected: true });
  assert.deepEqual(teamOptions(role('sublegwork'), [], 'inherit')[0], { value: 'inherit', label: 'Same as legwork', selected: true });
  for (const key of ['advisor', 'consultant']) assert.deepEqual(teamOptions(role(key), [], 'off')[0], { value: 'off', label: 'Off', selected: true });
  assert.deepEqual(TEAM_ROLES.map(item => item.key), ['helper', 'legwork', 'sublegwork', 'advisor', 'consultant']);
});

test('latest-tier selectors follow the first option and come before the exact models, each named for what it resolves to', () => {
  const selectors = [{ setting: 'openai-codex/latest-sol', label: 'latest sol → gpt-5.10-sol' }, { setting: 'openai-codex/latest-terra', label: 'latest terra → gpt-6.1-terra' }];
  const options = teamOptions(role('consultant'), models, 'openai-codex/latest-terra', selectors);
  assert.deepEqual(options.slice(0, 4).map(option => option.value), ['off', 'openai-codex/latest-sol', 'openai-codex/latest-terra', 'desktop-example/desktop-fixture']);
  assert.deepEqual(options[2], { value: 'openai-codex/latest-terra', label: 'openai-codex · latest-terra', name: 'latest terra → gpt-6.1-terra', selected: true });
  assert.equal(options.filter(option => option.selected).length, 1);
  assert.equal(validTeamValue('consultant', 'openai-codex/latest-terra'), true);
  const row = modelRow(options[2].value, { name: options[2].name, label: options[2].label });
  assert.deepEqual(rankModels([row], 'terra').map(item => item.value), ['openai-codex/latest-terra']);
});

test('every available model follows as provider/id with a provider · id label', () => {
  const options = teamOptions(role('legwork'), models, 'inherit');
  assert.deepEqual(options.slice(1).map(({ value, label }) => [value, label]), [
    ['desktop-example/desktop-fixture', 'desktop-example · desktop-fixture'],
    ['openrouter/vendor/model-a', 'openrouter · vendor/model-a'],
  ]);
  assert.deepEqual(options.filter(option => option.selected).map(option => option.value), ['inherit']);
});

test('a saved model is selected in place, without being listed twice', () => {
  const options = teamOptions(role('helper'), models, 'openrouter/vendor/model-a');
  assert.equal(options.filter(option => option.value === 'openrouter/vendor/model-a').length, 1);
  assert.deepEqual(options.filter(option => option.selected).map(option => option.value), ['openrouter/vendor/model-a']);
});

test('a saved value the list does not contain stays selected and is shown as its raw provider/id', () => {
  const options = teamOptions(role('helper'), models, 'elsewhere/gone-model');
  assert.deepEqual(options.at(-1), { value: 'elsewhere/gone-model', label: 'elsewhere/gone-model', selected: true });
  assert.deepEqual(teamOptions(role('advisor'), models, 'off').filter(option => option.selected).map(option => option.value), ['off']);
  assert.deepEqual(teamOptions(role('advisor'), [], 'some-other/vendor-model').at(-1).value, 'some-other/vendor-model');
});

test('a role accepts its own words and provider/model-id, nothing else', () => {
  assert.equal(validTeamValue('helper', 'inherit'), true);
  assert.equal(validTeamValue('legwork', 'openrouter/anthropic/claude'), true);
  assert.equal(validTeamValue('advisor', 'off'), true);
  assert.equal(validTeamValue('advisor', 'inherit'), false);
  assert.equal(validTeamValue('helper', 'off'), false);
  assert.equal(validTeamValue('consultant', 'off'), true);
  assert.equal(validTeamValue('consultant', 'inherit'), false);
  assert.equal(validTeamValue('sublegwork', 'inherit'), true);
  assert.equal(validTeamValue('sublegwork', 'off'), false);
  assert.equal(validTeamValue('paidVendors', 'allow'), true);
  assert.equal(validTeamValue('paidVendors', 'block'), true);
  assert.equal(validTeamValue('paidVendors', 'inherit'), false);
  for (const value of ['0', '3', '2.5']) assert.equal(validTeamValue('subscriptionPoints', value), true, value);
  for (const value of ['-1', 'abc', '', '1e3', '3 ']) assert.equal(validTeamValue('subscriptionPoints', value), false, value);
  assert.equal(validTeamValue('legwork', 'no-slash'), false);
  assert.equal(validTeamValue('legwork', 'has space/model'), false);
  assert.equal(validTeamValue('reviewer', 'a/b'), false);
});

test('writing one role keeps every other key of team and of the file, and the value survives a reload', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-team-settings-'));
  try {
    const agentDir = path.join(scratch, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'desktop-example', team: { helper: 'inherit', legwork: 'inherit', advisor: 'off', review: 'vendor/reviewer' } }, null, 2));
    const manager = SettingsManager.create(scratch, agentDir);
    applyTeamValue(manager, 'legwork', 'openrouter/vendor/model-a');
    await manager.flush();
    const written = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
    assert.equal(written.team.legwork, 'openrouter/vendor/model-a');
    assert.equal(written.team.review, 'vendor/reviewer');
    assert.equal(written.team.helper, 'inherit');
    assert.equal(written.team.advisor, 'off');
    assert.equal(written.defaultProvider, 'desktop-example');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('an invalid value is refused before anything is written', () => {
  const manager = SettingsManager.inMemory({ team: { helper: 'inherit' } });
  assert.throws(() => applyTeamValue(manager, 'helper', 'off'), /Choose a model/);
  assert.throws(() => applyTeamValue(manager, 'nobody', 'inherit'), /Unknown Team setting/);
  assert.throws(() => applyTeamValue(manager, 'subscriptionPoints', '-2'), /Enter a valid value/);
  assert.throws(() => applyTeamValue(manager, 'paidVendors', 'yes'), /Enter a valid value/);
});

test('the switches and the new roles are written as the harness reads them: a number for quota points, the word for paid vendors', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-team-settings-'));
  try {
    const agentDir = path.join(scratch, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ team: { helper: 'inherit', sideCalls: 'session' }, run: { softMinutes: 30 } }, null, 2));
    const manager = SettingsManager.create(scratch, agentDir);
    assert.equal(applyTeamValue(manager, 'subscriptionPoints', '5'), 5);
    assert.equal(applyTeamValue(manager, 'paidVendors', 'allow'), 'allow');
    assert.equal(applyTeamValue(manager, 'consultant', 'openai-codex/latest-astra'), 'openai-codex/latest-astra');
    assert.equal(applyTeamValue(manager, 'sublegwork', 'inherit'), 'inherit');
    await manager.flush();
    const written = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'));
    assert.deepEqual(written.team, { helper: 'inherit', sideCalls: 'session', subscriptionPoints: 5, paidVendors: 'allow', consultant: 'openai-codex/latest-astra', sublegwork: 'inherit' });
    assert.deepEqual(written.run, { softMinutes: 30 });
    assert.equal(readTeam(written.team).subscriptionPoints, 5);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('the catalog drops routes the vendor policy refuses and lists one selector per tier, from the harness files as they are', async () => {
  const dir = scratch(), agentDir = path.join(dir, 'agent');
  fs.mkdirSync(path.join(agentDir, 'extensions'), { recursive: true });
  fs.symlinkSync(path.resolve('agent/extensions/lib'), path.join(agentDir, 'extensions/lib'));
  const available = [
    { provider: 'openrouter', id: 'anthropic/claude-x', name: 'Claude X' },
    { provider: 'openrouter', id: 'qwen/qwen3.8-flash' },
    { provider: 'anthropic', id: 'claude-y' },
    { provider: 'openai', id: 'gpt-6', baseUrl: 'http://127.0.0.1:9/v1' },
    { provider: 'openai-codex', id: 'gpt-6-terra' },
    { provider: 'openai-codex', id: 'gpt-6.1-terra' },
    { provider: 'openai-codex', id: 'gpt-6.1-terra-pro' },
  ];
  try {
    const routes = list => list.models.map(model => `${model.provider}/${model.id}`);
    const blocked = await teamCatalog({ libDirs: [path.join(agentDir, 'extensions/lib')], models: available, paidVendors: 'block', oauthProviders: new Set() });
    assert.deepEqual(routes(blocked), ['openrouter/qwen/qwen3.8-flash', 'openai/gpt-6', 'openai-codex/gpt-6-terra', 'openai-codex/gpt-6.1-terra', 'openai-codex/gpt-6.1-terra-pro']);
    assert.deepEqual(blocked.selectors, [{ setting: 'openai-codex/latest-terra', label: 'latest terra → gpt-6.1-terra' }]);
    assert.ok(blocked.models.every(model => !('baseUrl' in model)));
    const oauth = await teamCatalog({ libDirs: [path.join(agentDir, 'extensions/lib')], models: available, paidVendors: 'block', oauthProviders: new Set(['anthropic']) });
    assert.ok(routes(oauth).includes('anthropic/claude-y') && !routes(oauth).includes('openrouter/anthropic/claude-x'));
    const allowed = await teamCatalog({ libDirs: [path.join(agentDir, 'extensions/lib')], models: available, paidVendors: 'allow', oauthProviders: new Set() });
    assert.deepEqual(routes(allowed), available.map(model => `${model.provider}/${model.id}`));
    assert.equal(allowed.models[0].name, 'Claude X');
    await assert.rejects(teamCatalog({ libDirs: [path.join(agentDir, 'missing')], models: available, paidVendors: 'block', oauthProviders: new Set() }), /policy files were not found/);
    const fallback = await teamCatalog({ libDirs: [path.join(agentDir, 'missing'), path.join(agentDir, 'extensions/lib')], models: available, paidVendors: 'block', oauthProviders: new Set() });
    assert.equal(fallback.models.length, blocked.models.length, 'the next folder is tried');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the model search needs every word somewhere in provider, id or name', () => {
  assert.equal(matchesQuery('openai-codex · gpt-5.5', 'codex'), true);
  assert.equal(matchesQuery('openrouter · qwen/qwen3-coder Qwen3 Coder', 'OpenRouter qwen'), true);
  assert.equal(matchesQuery('openrouter · qwen/qwen3-coder', 'openrouter llama'), false);
  assert.equal(matchesQuery('anything', '   '), true);
});

const row = (provider, id, name) => modelRow(`${provider}/${id}`, { name, provider, id });
const many = [
  row('openrouter', 'deepseek/deepseek-r1', 'DeepSeek R1'),
  row('nvidia', 'deepseek-ai/deepseek-v4-flash-0731', 'DeepSeek V4 Flash 0731'),
  row('deepseek', 'deepseek-flash', 'DeepSeek V4.1 Flash'),
  row('anthropic', 'claude-sonnet-5', 'Claude Sonnet 5'),
];

test('a typed provider comes first, then ids and names that start with a word, and nothing is dropped', () => {
  const ranked = rankModels(many, 'deepseek');
  assert.deepEqual(ranked.map(entry => entry.value).slice(0, 1), ['deepseek/deepseek-flash'], 'the provider the query names is listed first');
  // every matching model stays, including the ones a plain filter used to cut
  assert.equal(ranked.length, 3);
  assert.deepEqual(ranked.map(entry => entry.value).sort(), ['deepseek/deepseek-flash', 'nvidia/deepseek-ai/deepseek-v4-flash-0731', 'openrouter/deepseek/deepseek-r1'].sort());
});

test('a model whose id or name begins with a typed word ranks above a later match', () => {
  const ranked = rankModels([row('vendor', 'x-claude-clone', 'A clone'), row('anthropic', 'claude-sonnet-5', 'Claude Sonnet 5')], 'claude');
  assert.deepEqual(ranked.map(entry => entry.value), ['anthropic/claude-sonnet-5', 'vendor/x-claude-clone']);
});

test('an empty query puts the chosen model first and then groups by provider in arrival order', () => {
  const ranked = rankModels(many, '', 'nvidia/deepseek-ai/deepseek-v4-flash-0731');
  assert.equal(ranked.length, many.length, 'every model is listed');
  assert.equal(ranked[0].value, 'nvidia/deepseek-ai/deepseek-v4-flash-0731');
  assert.deepEqual(ranked.slice(1).map(entry => entry.provider), ['openrouter', 'deepseek', 'anthropic']);
  assert.deepEqual(rankModels(many, '  ', ''), many, 'a blank query keeps every model');
});

test('a query that matches nothing lists nothing rather than old models', () => {
  assert.deepEqual(rankModels(many, 'ling'), []);
});
