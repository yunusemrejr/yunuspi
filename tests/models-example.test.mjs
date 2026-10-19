import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const release = path.resolve(import.meta.dirname, '..');
const core = fs.existsSync(path.join(release, 'core')) ? path.join(release, 'core') : path.resolve(release, '../core');
const { resolveConfigValue } = await import(pathToFileURL(path.join(core, 'coding-agent/src/core/resolve-config-value.js')).href);

test('the shipped provider example names each key through interpolation, so a fresh install sends the key and not the variable name', () => {
  const example = JSON.parse(fs.readFileSync(path.join(release, 'config/models.example.json'), 'utf8'));
  const providers = Object.entries(example.providers);
  assert.ok(providers.length >= 4);
  for (const [name, provider] of providers) {
    assert.match(provider.apiKey, /^\$\{[A-Z][A-Z0-9_]*\}$/, `${name} must reference an environment variable as \${NAME}`);
    const variable = provider.apiKey.slice(2, -1);
    assert.equal(resolveConfigValue(provider.apiKey, { [variable]: 'sk-example' }), 'sk-example', `${name} resolves to the variable's value`);
    assert.notEqual(resolveConfigValue(provider.apiKey, {}), variable, `${name} never falls back to sending the variable name`);
  }
});
