import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const agentsDir = path.join(repo, 'agent/extensions/pi-subagents/agents');

// A child that lists an extension path which no longer exists fails to start ("Extension path does not exist"),
// which silently disables every subagent and the native reviewer. Retiring an extension must update these lists.
test('every extension path named by a built-in agent definition exists', () => {
  const missing = [];
  const definitions = fs.readdirSync(agentsDir).filter(name => name.endsWith('.md'));
  assert.ok(definitions.length >= 6, 'built-in agent definitions are present');
  for (const name of definitions) {
    const frontmatter = fs.readFileSync(path.join(agentsDir, name), 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    for (const line of frontmatter.split('\n')) {
      const key = line.match(/^(\w*[Ee]xtensions?\w*):\s*(.*)$/);
      if (!key) continue;
      for (const item of key[2].split(',').map(part => part.trim()).filter(part => /\.(?:ts|js|mjs)$/.test(part))) {
        if (!fs.existsSync(path.resolve(agentsDir, item))) missing.push(`${name} ${key[1]}: ${item}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

// Subagents run on the session model and the effort controller picks thinking, so no built-in definition sets either.
test('built-in agent definitions declare no per-agent model or thinking', () => {
  for (const name of fs.readdirSync(agentsDir).filter(file => file.endsWith('.md'))) {
    const frontmatter = fs.readFileSync(path.join(agentsDir, name), 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    assert.doesNotMatch(frontmatter, /^(?:model|modelProvider|fallbackModels|defaultProvider|thinking):/m, name);
  }
});

// Agent files and settings written before per-agent model and thinking were retired must keep loading.
test('retired model and thinking keys are ignored: old agent files and settings still load', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-retired-agent-fields-'));
  const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.HOME = work;
  process.env.PI_CODING_AGENT_DIR = path.join(work, 'agent');
  try {
    fs.mkdirSync(path.join(work, 'agent', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(work, 'agent', 'agents', 'legacy.md'),
      '---\nname: legacy\ndescription: Written before model and thinking were retired\nmodel: openrouter/old-model\nfallbackModels: a/b, c/d\nthinking: high\n---\nLegacy\n');
    fs.writeFileSync(path.join(work, 'agent', 'settings.json'), JSON.stringify({ subagents: {
      defaultModel: 'old/model', defaultProvider: 'old', defaultThinking: 'high', disableThinking: true, maxThinking: 'medium',
      agentOverrides: { scout: { model: 'old/model', defaultProvider: 'old', fallbackModels: ['x/y'], thinking: 'low', systemPromptMode: 'append' } },
    } }));
    const discovery = await import(pathToFileURL(path.join(repo, 'agent/extensions/pi-subagents/src/agents/agents.ts')).href);
    discovery.clearAgentDiscoveryCache();
    const found = discovery.discoverAgents(work, 'user');
    assert.deepEqual(found.agentDiagnostics ?? [], []);
    const legacy = found.agents.find((agent) => agent.name === 'legacy');
    assert.ok(legacy, 'legacy agent file still loads');
    for (const field of ['model', 'modelProvider', 'fallbackModels', 'thinking']) assert.equal(legacy[field], undefined, field);
    const scout = found.agents.find((agent) => agent.name === 'scout');
    assert.equal(scout.systemPromptMode, 'append', 'non-retired override fields still apply');
    for (const field of ['model', 'modelProvider', 'fallbackModels', 'thinking']) assert.equal(scout[field], undefined, field);
    assert.equal(scout.maxThinking, 'medium', 'thinking ceilings stay');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(work, { recursive: true, force: true });
  }
});
