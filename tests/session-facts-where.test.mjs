import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const { whereLine, sessionFactsText } = await import(pathToFileURL(path.join(root, 'agent/extensions/session-facts.ts')).href);

const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
  });
const repo = (dir, remotes = []) => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  for (const [name, url] of remotes) git(dir, 'remote', 'add', name, url);
  return dir;
};
const temp = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('a git repository at its top level names its remote, branch and uncommitted files', (t) => {
  const dir = repo(path.join(temp(t, 'where-repo-'), 'widget'), [['origin', 'https://github.com/acme/widget.git']]);
  const line = whereLine(dir);
  assert.match(line, /^Where: .*widget is the git repository widget \(remote acme\/widget, branch main, 0 uncommitted files\)\.$/);
  assert.ok(line.length <= 320);
});

test('a subfolder of a repository says so and still names remote and branch', (t) => {
  const base = repo(path.join(temp(t, 'where-sub-'), 'widget'), [['origin', 'git@github.com:acme/widget.git']]);
  const sub = path.join(base, 'src');
  fs.mkdirSync(sub);
  const line = whereLine(sub);
  assert.match(line, /is a subfolder of the git repository widget \(remote acme\/widget, branch main\)\.$/);
});

test('a folder holding several repositories lists them', (t) => {
  const base = temp(t, 'where-many-');
  repo(path.join(base, 'r2'));
  repo(path.join(base, 'r1'));
  const line = whereLine(base);
  assert.match(line, /is a folder holding 2 repositories \(r1, r2\)\.$/);
});

test('the home folder and a plain folder have their own sentence', (t) => {
  const home = temp(t, 'where-home-');
  assert.match(whereLine(home, home), /is the home folder, no project: a general or system task unless the message names a project\.$/);
  const plain = temp(t, 'where-plain-');
  assert.match(whereLine(plain, home), /is a plain folder with no repository\.$/);
});

test('a production remote and a deploy script add the live-system sentence', (t) => {
  const dir = repo(path.join(temp(t, 'where-live-'), 'shop'), [['origin', 'https://github.com/acme/shop.git'], ['production', 'git@example.com:acme/shop.git']]);
  fs.writeFileSync(path.join(dir, 'deploy.sh'), '#!/bin/sh\n');
  const line = whereLine(dir);
  assert.match(line, / Live system in reach: production, deploy\.sh; a push or deploy from here changes it\.$/);
});

test('the Where line rides with the other session facts', () => {
  const text = sessionFactsText({ now: new Date('2026-11-25T10:00:00Z'), zone: 'UTC', where: 'Where: /p is a plain folder with no repository.' });
  assert.match(text, /\nWhere: \/p is a plain folder with no repository\.$/);
});
