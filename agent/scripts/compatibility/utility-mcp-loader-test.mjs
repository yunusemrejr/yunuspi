// Offline: load through the real SDK/Jiti boundary, initialize the session
// hook, validate schemas with Pi's validator, and execute the actual MCP bridge.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const agent = fileURLToPath(new URL('../../', import.meta.url));
const core = path.join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 5000 }).trim(), '@earendil-works/pi-coding-agent');
const sdk = await import(pathToFileURL(path.join(core, 'dist/index.js')));
const { validateToolArguments } = await import(pathToFileURL(path.join(core, 'node_modules/@earendil-works/pi-ai/dist/utils/validation.js')));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'utility-sdk-'));
let extension;
try {
  fs.writeFileSync(path.join(workspace, 'package.json'), '{"name":"fixture"}');
  const loader = new sdk.DefaultResourceLoader({ cwd: workspace, agentDir: workspace, settingsManager: sdk.SettingsManager.inMemory({ extensions: [] }), additionalExtensionPaths: [path.join(agent, 'extensions/utility-tools.ts')], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const result = loader.getExtensions(); assert.deepEqual(result.errors, []);
  [extension] = result.extensions; assert.equal(extension.tools.size, 8);
  const ctx = { cwd: workspace, ui: { notify: message => { throw Error(message); } } };
  for (const hook of extension.handlers.get('session_start') ?? []) await hook({}, ctx);
  const samples = {
    sqlite_probe: { path: 'db.sqlite', action: 'query', sql: 'SELECT ?', params: [null, 'x', 1, true] },
    package_probe: { package: 'missing' }, openapi_probe: { path: 'api.yaml', action: 'list_endpoints' },
    coverage_probe: { artifacts: ['coverage.info'], files: ['app.js'] }, contract_diff: { before_value: {}, after_value: { x: 1 } },
    env_audit: { sources: ['app.js'], configs: ['.env.example'] }, net_probe: { action: 'tcp', host: 'localhost', port: 1234 },
    archive_probe: { path: 'build.zip', action: 'list' },
  };
  for (const [name, args] of Object.entries(samples)) validateToolArguments(extension.tools.get(name).definition, { name, arguments: args });
  const tool = extension.tools.get('package_probe').definition;
  const response = await tool.execute('fixture', { package: 'missing' }, undefined, undefined, ctx);
  assert.equal(response.isError, false, JSON.stringify(response));
  assert.equal(JSON.parse(response.content[0].text).installed, false);
  const diff = await extension.tools.get('contract_diff').definition.execute('fixture2', { before_value: { n: 1 }, after_value: { n: 2 } }, undefined, undefined, ctx);
  assert.equal(JSON.parse(diff.content[0].text).identical_shape, true);
  console.log('PASS SDK utility MCP startup, eight validated schemas, live bridge calls and shutdown; no inference');
} finally {
  for (const hook of extension?.handlers.get('session_shutdown') ?? []) await hook({}, { cwd: workspace });
  fs.rmSync(workspace, { recursive: true, force: true });
}
