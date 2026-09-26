import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'model-selection-snapshot-'));
process.env.PI_CODING_AGENT_DIR = scratch;
process.env.PI_PROVIDER_STATE_FILE = path.join(scratch, 'health.json');
process.env.PI_MODEL_EXCLUSIONS_PATH = path.join(scratch, 'exclusions.json');
process.env.PI_SUBAGENTS_ECONOMY_CONFIG = path.join(scratch, 'economy.json');
fs.writeFileSync(process.env.PI_SUBAGENTS_ECONOMY_CONFIG, '{}');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const { selectAffordableModel, describeSelectionRejections } = await import('../agent/extensions/pi-subagents/src/runs/shared/model-selection.ts');
const { loadModelEconomyConfig } = await import('../agent/extensions/pi-subagents/src/runs/shared/model-economy.ts');
const { publishFreeEvidence, FREE_CATALOG_URL } = await import('../agent/extensions/pi-subagents/src/runs/shared/free-route-evidence.ts');
const config = loadModelEconomyConfig();
const model = i => ({ provider: 'openrouter', id: `fixture/model-${i}`, fullId: `openrouter/fixture/model-${i}`, api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', contextWindow: 65536, maxTokens: 8192, input: ['text'], reasoning: true, cost: { input: .1, output: .1, cacheRead: .1, cacheWrite: .1 } });

function countSnapshotReads(work) {
  const original = fs.statSync;
  const calls = new Map();
  fs.statSync = (file, ...args) => {
    const name = path.basename(String(file));
    calls.set(name, (calls.get(name) ?? 0) + 1);
    return original(file, ...args);
  };
  syncBuiltinESMExports();
  try { return { value: work(), calls }; }
  finally { fs.statSync = original; syncBuiltinESMExports(); }
}

test('selection snapshots evidence and exclusions once per invocation, including a missing evidence file', () => {
  const models = Array.from({ length: 500 }, (_, i) => model(i));
  for (const evidencePresent of [false, true]) {
    if (evidencePresent) publishFreeEvidence([], FREE_CATALOG_URL);
    for (const select of [selectAffordableModel, describeSelectionRejections]) {
      const { value, calls } = countSnapshotReads(() => select(models, config, { quality: { domain: 'coding', level: 'advisory' } }));
      assert.ok(value);
      assert.equal(calls.get('free-route-evidence.json'), 1, `${select.name}: ${evidencePresent ? 'present' : 'missing'} evidence reads must not scale with candidate count`);
      assert.equal(calls.get('exclusions.json'), 1, 'one consistent exclusion snapshot per decision');
    }
  }
});

test('new exclusion and catalog snapshots affect the very next selection', () => {
  const models = [model('a'), model('b')];
  assert.equal(selectAffordableModel(models, config).model, models[0].fullId);
  fs.writeFileSync(process.env.PI_MODEL_EXCLUSIONS_PATH, JSON.stringify({ version: 1, exclusions: [{ modelId: models[0].id, provider: 'openrouter', recordedAt: Date.now(), expiresAt: Date.now() + 60000 }] }));
  assert.equal(selectAffordableModel(models, config).model, models[1].fullId);
  fs.writeFileSync(process.env.PI_MODEL_EXCLUSIONS_PATH, JSON.stringify({ version: 1, exclusions: [] }));
  publishFreeEvidence([{ id: models[1].id, pricing: { prompt: '0', completion: '0' }, capabilities: { contextWindow: 65536, toolCalling: true } }], FREE_CATALOG_URL);
  assert.equal(selectAffordableModel(models, config, { freeOnly: true }).model, models[1].fullId);
  publishFreeEvidence([], FREE_CATALOG_URL);
  assert.equal(selectAffordableModel(models, config, { freeOnly: true }), undefined);
});
