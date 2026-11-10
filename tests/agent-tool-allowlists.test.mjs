import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const agentsDir = path.join(root, 'agent/extensions/pi-subagents/agents');
// Provided by core or by the child runtime bridge rather than by an extension in the installed graph.
const CORE = new Set(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'contact_supervisor', 'intercom']);

// A child that lists a tool nobody registers is reported as failed with "requested unavailable child tools", so a
// refactor that retires an extension must not silently drop tools that built-in agents are allowed to call.
// The graph is loaded the way a child loads it in a default install: as a subagent process, with no opt-in gate set.
// Loading it with PI_LEAN_GATES=on once hid `project_intel`, a tool only that gate registers, in all six agents.
test('every tool a built-in agent allows is registered in a default child session', { timeout: 90000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-agent-tools-'));
  const agentDir = path.join(dir, 'agent');
  fs.mkdirSync(agentDir);
  try {
    for (const name of ['extensions', 'scripts']) fs.symlinkSync(path.join(root, 'agent', name), path.join(agentDir, name), 'dir');
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(agentDir, 'node_modules'), 'dir');
    const loaderUrl = pathToFileURL(path.join(root, 'core/coding-agent/src/core/resource-loader.js')).href;
    const settingsUrl = pathToFileURL(path.join(root, 'core/coding-agent/src/core/settings-manager.js')).href;
    const script = `
      import {DefaultResourceLoader} from ${JSON.stringify(loaderUrl)};
      import {SettingsManager} from ${JSON.stringify(settingsUrl)};
      const loader = new DefaultResourceLoader({cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
        settingsManager: SettingsManager.inMemory({packages: []}), noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true});
      await loader.reload();
      const result = loader.getExtensions();
      console.log(JSON.stringify({errors: result.errors, tools: result.extensions.flatMap(extension => [...extension.tools.keys()])}));
      process.exit(0);
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_SUBAGENT_CHILD: '1', PI_LEAN_GATES: '' },
      encoding: 'utf8', timeout: 80000, maxBuffer: 1024 * 1024,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    const graph = JSON.parse(child.stdout.trim().split('\n').at(-1));
    assert.deepEqual(graph.errors, []);
    assert.ok(graph.tools.includes('workspace_search'), 'the extension graph loaded');
    const registered = new Set([...graph.tools, ...CORE]);
    const missing = [];
    for (const file of fs.readdirSync(agentsDir).filter(name => name.endsWith('.md'))) {
      const frontmatter = fs.readFileSync(path.join(agentsDir, file), 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
      const tools = frontmatter.match(/^tools:\s*(.*)$/m)?.[1] ?? '';
      for (const name of tools.split(',').map(part => part.trim()).filter(part => /^[a-z][a-z0-9_]*$/.test(part))) {
        if (!registered.has(name)) missing.push(`${file}: ${name}`);
      }
    }
    assert.deepEqual(missing, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
