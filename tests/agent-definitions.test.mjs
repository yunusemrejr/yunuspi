import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const agentsDir = fileURLToPath(new URL('../agent/extensions/pi-subagents/agents/', import.meta.url));

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
