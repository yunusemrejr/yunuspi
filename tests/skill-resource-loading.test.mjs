import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const { DefaultResourceLoader } = await import(pathToFileURL(path.join(root, 'core/coding-agent/src/core/resource-loader.js')));
const { SettingsManager } = await import(pathToFileURL(path.join(root, 'core/coding-agent/src/core/settings-manager.js')));
const { parseFrontmatter } = await import(pathToFileURL(path.join(root, 'core/coding-agent/src/utils/frontmatter.js')));

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'yunuspi-skill-resource-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const agent = path.join(cwd, 'agent');
  const skillRoot = path.join(cwd, 'catalogue');
  fs.mkdirSync(agent);
  fs.mkdirSync(skillRoot);
  const put = (relative, data) => {
    const target = path.join(skillRoot, relative);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, data);
    return target;
  };
  return { cwd, agent, skillRoot, put };
}

function loader(cwd, agentDir, skillRoot) {
  return new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.inMemory({}),
    additionalSkillPaths: [skillRoot], noExtensions: true, noSkills: true, noThemes: true,
    noContextFiles: true, noPromptTemplates: true });
}

test('resource reload reads a prefix for the skill catalogue and preserves the existing frontmatter grammar', async t => {
  const { cwd, agent, skillRoot, put } = fixture(t);
  const short = '\ufeff---\r\nname: workflow\r\ndescription: Synthetic catalogue workflow.\r\n---\r\n';
  const file = put('workflow/SKILL.md', short + '# Body\r\n');
  fs.truncateSync(file, 2 * 1024 * 1024);
  const base = '---\rname: boundary\rdescription: Folder metadata across a read boundary.\r#';
  const long = base + 'x'.repeat(70 * 1024 + 2046 - base.length) + '\r---ignored by the original parser\r# Body';
  put('boundary/SKILL.md', long);
  const expected = parseFrontmatter(long).frontmatter;
  const backing = path.join(cwd, 'backing.md');
  fs.writeFileSync(backing, '---\nname: linked\ndescription: Symlinked guide.\n---\n');
  fs.mkdirSync(path.join(skillRoot, 'linked'));
  fs.symlinkSync(backing, path.join(skillRoot, 'linked/SKILL.md'));

  const originals = { openSync: fs.openSync, readSync: fs.readSync, readFileSync: fs.readFileSync, closeSync: fs.closeSync };
  let fd, bytes = 0, wholeReads = 0;
  fs.openSync = (name, ...options) => {
    const handle = originals.openSync(name, ...options);
    if (name === file) fd = handle;
    return handle;
  };
  fs.readSync = (handle, ...args) => {
    const count = originals.readSync(handle, ...args);
    if (handle === fd) bytes += count;
    return count;
  };
  fs.readFileSync = (name, ...options) => {
    const result = originals.readFileSync(name, ...options);
    if (name === file || name === fd) {
      wholeReads++;
      bytes += typeof result === 'string' ? Buffer.byteLength(result) : result.length;
    }
    return result;
  };
  fs.closeSync = handle => {
    if (handle === fd) fd = undefined;
    return originals.closeSync(handle);
  };
  syncBuiltinESMExports();
  try {
    const resource = loader(cwd, agent, skillRoot);
    await resource.reload();
    const skills = new Map(resource.getSkills().skills.map(skill => [skill.name, skill]));
    assert.equal(skills.get('workflow').description, 'Synthetic catalogue workflow.');
    assert.equal(skills.get('boundary').description, expected.description);
    assert.equal(skills.get('linked').description, 'Symlinked guide.');
    assert.equal(skills.get('linked').filePath, path.join(skillRoot, 'linked/SKILL.md'));
    assert.equal(wholeReads, 0);
    assert.equal(bytes, 4096);
    assert.equal(fd, undefined);
  } finally {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  }
});

const fifoWorker = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { DefaultResourceLoader } from './core/coding-agent/src/core/resource-loader.js';
import { SettingsManager } from './core/coding-agent/src/core/settings-manager.js';
const [cwd, agentDir, skillRoot, mode] = process.argv.slice(1);
const isolatedAgentsSkills = path.join(process.env.HOME ?? '', '.agents/skills');
const exists = fs.existsSync;
fs.existsSync = candidate => candidate === isolatedAgentsSkills ? false : exists(candidate);
const broken = path.join(skillRoot, 'broken');
if (mode === 'race') {
  const readdir = fs.readdirSync;
  fs.readdirSync = (name, ...args) => {
    const entries = readdir(name, ...args);
    if (name === broken) fs.renameSync(path.join(cwd, 'fifo'), path.join(broken, 'SKILL.md'));
    return entries;
  };
}
syncBuiltinESMExports();
const configured = mode === 'settings';
const settingsManager = SettingsManager.inMemory(configured ? {skills: [skillRoot]} : {});
const resource = new DefaultResourceLoader({cwd, agentDir, settingsManager,
  additionalSkillPaths: configured ? [] : [skillRoot], noExtensions: true, noSkills: !configured, noThemes: true,
  noContextFiles: true, noPromptTemplates: true});
await resource.reload();
const catalogue = resource.getSkills();
assert.deepEqual(catalogue.skills.map(skill => skill.name), ['keep']);
if (mode === 'race') assert.ok(catalogue.diagnostics.some(row => /regular file/i.test(row.message)));
`;

for (const mode of ['ignore', 'settings', 'race']) {
  const titles = {
    ignore: 'an ignore FIFO cannot stall explicit skill resource reload',
    settings: 'an ignore FIFO cannot stall package-managed skill settings discovery',
    race: 'a skill swapped to a FIFO after enumeration does not stall sibling discovery',
  };
  test(titles[mode], {
    skip: process.platform !== 'linux', timeout: 15000,
  }, t => {
    const {cwd, agent, skillRoot, put} = fixture(t);
    put('keep/SKILL.md', '---\nname: keep\ndescription: Healthy skill.\n---\n');
    put('exclude/SKILL.md', '---\nname: exclude\ndescription: Ignored skill.\n---\n');
    put('.gitignore', 'keep/\nexclude/\n');
    put('.fdignore', '!keep/\n');
    if (mode !== 'race') execFileSync('mkfifo', [path.join(skillRoot, '.ignore')]);
    else {
      put('broken/SKILL.md', '---\nname: broken\ndescription: Replaced before read.\n---\n');
      execFileSync('mkfifo', [path.join(cwd, 'fifo')]);
    }
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', fifoWorker, cwd, agent, skillRoot, mode], {
      cwd: root, timeout: 10000, killSignal: 'SIGKILL', encoding: 'utf8',
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
  });
}
