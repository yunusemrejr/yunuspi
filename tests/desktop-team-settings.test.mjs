import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEAM_ROLES, applyTeamValue, matchesQuery, modelRow, rankModels, readTeam, teamOptions, validTeamValue } from '../desktop/renderer/team-settings.mjs';
import { SettingsManager } from '../core/coding-agent/dist/core/settings-manager.js';

const role = key => TEAM_ROLES.find(candidate => candidate.key === key);
const models = [{ provider: 'desktop-example', id: 'desktop-fixture' }, { provider: 'openrouter', id: 'vendor/model-a' }];

test('a missing team block reads as the session model for helper and legwork and no advisor', () => {
  assert.deepEqual(readTeam(undefined), { helper: 'inherit', legwork: 'inherit', advisor: 'off' });
  assert.deepEqual(readTeam({}), { helper: 'inherit', legwork: 'inherit', advisor: 'off' });
  assert.deepEqual(readTeam({ helper: 'openrouter/vendor/model-a', advisor: 'off' }), { helper: 'openrouter/vendor/model-a', legwork: 'inherit', advisor: 'off' });
});

test('helper and legwork offer the session model first; advisor offers Off first', () => {
  for (const key of ['helper', 'legwork']) assert.deepEqual(teamOptions(role(key), [], 'inherit')[0], { value: 'inherit', label: 'Same as the session', selected: true });
  assert.deepEqual(teamOptions(role('advisor'), [], 'off')[0], { value: 'off', label: 'Off', selected: true });
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
  assert.throws(() => applyTeamValue(manager, 'nobody', 'inherit'), /Unknown Team role/);
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
