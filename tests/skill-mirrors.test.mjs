import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const script = path.join(root, 'agent/scripts/skill-mirrors.mjs');
const { skillRoots, skillDirs, compareSkill, findShadowed, refreshShadowed } = await import(pathToFileURL(script));

const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const skill = (name, body = '') => `---\nname: ${name}\ndescription: Fixture skill.\n---\n\n# ${name}\n${body}\n`;
function stage({ settings } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-mirrors-')), agentDir = path.join(tmp, 'agent'), mine = path.join(tmp, 'mine');
  put(path.join(agentDir, 'settings.json'), JSON.stringify(settings ?? { skills: [mine] }));
  put(path.join(agentDir, 'skills', 'stale', 'SKILL.md'), skill('stale', 'Use media_edit for audio.'));
  put(path.join(agentDir, 'skills', 'stale', 'references', 'notes.md'), 'shipped reference v2');
  put(path.join(agentDir, 'skills', 'same', 'SKILL.md'), skill('same'));
  put(path.join(agentDir, 'skills', 'shipped-only', 'SKILL.md'), skill('shipped-only'));
  put(path.join(mine, 'stale', 'SKILL.md'), skill('stale', 'Use raw ffmpeg for audio.'));
  put(path.join(mine, 'stale', 'references', 'notes.md'), 'old reference v1');
  put(path.join(mine, 'stale', 'my-notes.md'), 'my own addition');
  put(path.join(mine, 'same', 'SKILL.md'), skill('same'));
  put(path.join(mine, 'personal', 'SKILL.md'), skill('personal', 'Only I have this.'));
  return { tmp, agentDir, mine };
}

test('roots come from settings.json: plain folders only, never the shipped catalogue, patterns or missing paths', () => {
  const { tmp, agentDir, mine } = stage();
  assert.deepEqual(skillRoots(agentDir, tmp), [mine]);
  put(path.join(agentDir, 'settings.json'), JSON.stringify({ skills: [mine, mine, '!x', '+y', path.join(tmp, 'glob*'), path.join(tmp, 'missing'), path.join(agentDir, 'skills'), 7, '~/nope'] }));
  assert.deepEqual(skillRoots(agentDir, tmp), [mine], 'duplicates, exclusions, globs, missing folders and the shipped folder are not roots');
  fs.writeFileSync(path.join(agentDir, 'settings.json'), 'not json');
  assert.deepEqual(skillRoots(agentDir, tmp), []);
  put(path.join(agentDir, 'settings.json'), JSON.stringify({ skills: ['~/mine'] }));
  fs.symlinkSync(mine, path.join(tmp, 'mine-link'));
  assert.deepEqual(skillRoots(agentDir, tmp), [path.join(tmp, 'mine')], '~ expands to the home folder');
});

test('a skill is a folder holding SKILL.md, named by its frontmatter; nested folders are searched, node_modules is not', () => {
  const { mine } = stage();
  put(path.join(mine, 'group', 'inner', 'SKILL.md'), skill('inner-name'));
  put(path.join(mine, 'node_modules', 'pkg', 'SKILL.md'), skill('hidden'));
  put(path.join(mine, '.cache', 'SKILL.md'), skill('dot'));
  assert.deepEqual(skillDirs(mine).map(entry => entry.name).sort(), ['inner-name', 'personal', 'same', 'stale']);
});

test('findShadowed reports only copies that differ from a shipped skill, with what differs', () => {
  const { agentDir } = stage();
  const found = findShadowed({ agentDir });
  assert.deepEqual(found.map(entry => entry.name), ['stale'], 'identical copies, personal skills and shipped-only skills are not reported');
  assert.deepEqual(found[0].changed, ['SKILL.md', path.join('references', 'notes.md')]);
  assert.deepEqual(found[0].externalOnly, ['my-notes.md']);
  assert.deepEqual(compareSkill(path.join(agentDir, 'skills', 'same'), path.join(agentDir, 'skills', 'same')), { changed: [], externalOnly: [] });
});

test('refresh keeps a backup of the originals, overwrites shipped files and leaves your own files alone', () => {
  const { agentDir, mine } = stage();
  const now = new Date('2026-10-05T12:00:00Z');
  const result = refreshShadowed(findShadowed({ agentDir }), { agentDir, now });
  assert.deepEqual(result.refreshed, ['stale']);
  assert.ok(result.backup.startsWith(path.join(agentDir, 'backups', 'skill-mirrors-2026-10-05T12-00-00-000Z')));
  assert.equal(fs.readFileSync(path.join(result.backup, 'mine', 'stale', 'SKILL.md'), 'utf8'), skill('stale', 'Use raw ffmpeg for audio.'), 'the original is kept');
  assert.equal(fs.readFileSync(path.join(result.backup, 'mine', 'stale', 'my-notes.md'), 'utf8'), 'my own addition');
  assert.equal(fs.readFileSync(path.join(mine, 'stale', 'SKILL.md'), 'utf8'), skill('stale', 'Use media_edit for audio.'));
  assert.equal(fs.readFileSync(path.join(mine, 'stale', 'references', 'notes.md'), 'utf8'), 'shipped reference v2');
  assert.equal(fs.readFileSync(path.join(mine, 'stale', 'my-notes.md'), 'utf8'), 'my own addition', 'a file only the copy has stays');
  assert.equal(fs.readFileSync(path.join(mine, 'personal', 'SKILL.md'), 'utf8'), skill('personal', 'Only I have this.'), 'personal skills are untouched');
  assert.deepEqual(findShadowed({ agentDir }), [], 'after a refresh nothing differs');
  assert.deepEqual(refreshShadowed([], { agentDir }), { backup: undefined, refreshed: [] });
});

test('a copy that is a symlink to the shipped skill is not a shadow, and a symlinked root cannot reach into the catalogue', () => {
  const { tmp, agentDir, mine } = stage();
  fs.rmSync(path.join(mine, 'stale'), { recursive: true });
  fs.symlinkSync(path.join(agentDir, 'skills', 'stale'), path.join(mine, 'stale'));
  assert.deepEqual(findShadowed({ agentDir }), []);
  const link = path.join(tmp, 'catalogue-link'); fs.symlinkSync(path.join(agentDir, 'skills'), link);
  put(path.join(agentDir, 'settings.json'), JSON.stringify({ skills: [link] }));
  assert.deepEqual(skillRoots(agentDir, tmp), [], 'a root that resolves into the shipped catalogue is skipped');
});

test('the command line reports by default, changes nothing without --apply, and --json is machine readable', () => {
  const { agentDir, mine } = stage();
  const run = (...args) => spawnSync(process.execPath, [script, '--agent-dir', agentDir, ...args], { encoding: 'utf8' });
  const report = run();
  assert.equal(report.status, 0); assert.match(report.stdout, /1 skill\(s\) under your own skill paths win over a different shipped copy/); assert.match(report.stdout, /stale: 2 files differ/); assert.match(report.stdout, /1 extra file\(s\) only in your copy stay/);
  assert.equal(fs.readFileSync(path.join(mine, 'stale', 'SKILL.md'), 'utf8'), skill('stale', 'Use raw ffmpeg for audio.'), 'report mode never writes');
  assert.deepEqual(JSON.parse(run('--json').stdout).map(entry => entry.name), ['stale']);
  const applied = run('--apply');
  assert.match(applied.stdout, /Refreshed 1 skill\(s\)/); assert.match(applied.stdout, /originals are in .*skill-mirrors-/);
  assert.match(run().stdout, /No skill under your own paths differs/);
  assert.match(run('--apply').stdout, /Nothing to refresh/);
});

test('refresh never writes through a symbolic link: the file it points at is not in the backup', () => {
  const { tmp, agentDir, mine } = stage();
  const elsewhere = path.join(tmp, 'elsewhere');
  put(path.join(elsewhere, 'notes.md'), 'kept outside the skill');
  put(path.join(elsewhere, 'tips.md'), 'my linked tips');
  put(path.join(agentDir, 'skills', 'stale', 'tips.md'), 'shipped tips');
  fs.rmSync(path.join(mine, 'stale', 'references'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(mine, 'stale', 'references'));
  fs.symlinkSync(path.join(elsewhere, 'tips.md'), path.join(mine, 'stale', 'tips.md'));
  const result = refreshShadowed(findShadowed({ agentDir }), { agentDir });
  assert.deepEqual(result.refreshed, ['stale']);
  assert.deepEqual(result.linked.sort(), [path.join('stale', 'references', 'notes.md'), path.join('stale', 'tips.md')]);
  assert.equal(fs.readFileSync(path.join(elsewhere, 'notes.md'), 'utf8'), 'kept outside the skill', 'a linked folder is not written into');
  assert.equal(fs.readFileSync(path.join(elsewhere, 'tips.md'), 'utf8'), 'my linked tips', 'a linked file is not overwritten');
  assert.equal(fs.readFileSync(path.join(mine, 'stale', 'SKILL.md'), 'utf8'), skill('stale', 'Use media_edit for audio.'), 'ordinary files are still refreshed');
});
