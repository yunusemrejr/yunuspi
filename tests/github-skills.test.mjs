import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')]
  .find(p => fs.existsSync(path.join(p, 'extensions/lib/skill-routing.ts')));
const {routeSkills} = await import(pathToFileURL(path.join(agent, 'extensions/lib/skill-routing.ts')));

// The README, release-notes, CI and repo-presentation skills were consolidated into git-github.
const names = ['git-github'];

test('github workflow skills ship with descriptions and resolvable references', () => {
  for (const name of names) {
    const dir = path.join(agent, 'skills', name);
    const body = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    const frontmatter = /^---\r?\n([^]*?)\r?\n---/.exec(body)?.[1];
    assert.ok(frontmatter, `${name} has frontmatter`);
    assert.match(frontmatter, new RegExp(`name:\\s*${name}\\b`));
    const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() ?? '';
    assert.ok(description.length > 40, `${name} description is discriminating`);
    assert.ok(description.length <= 1024, `${name} description fits the loader limit`);
    for (const match of body.matchAll(/\]\(((?:references|assets)\/[^)#]+)\)/g)) {
      assert.ok(fs.statSync(path.join(dir, match[1])).isFile(), `${name}: ${match[1]}`);
    }
  }
});

test('deterministic routing selects the intended github skill', () => {
  const positives = [
    ['git-github','Write a README for the new library'],
    ['git-github','Improve the project README badges'],
    ['git-github','Rewrite the README quickstart section'],
    ['git-github','Add a CONTRIBUTING guide and issue templates'],
    ['git-github','Prepare the repository for outside contributors with a security policy and code of conduct'],
    ['git-github','Write release notes for v1.2.0'],
    ['git-github','Draft the 2.0 pre-release notes'],
    ['git-github','Update the changelog before the release'],
    ['git-github','Add a GitHub Actions workflow that runs the tests'],
    ['git-github','Harden our CI pipeline against fork pull requests'],
    ['git-github','Fix the failing GitHub Actions job'],
  ];
  for (const [name, prompt] of positives) {
    assert.ok(routeSkills(prompt).some(route => route.name === name), prompt);
  }
  assert.ok(routeSkills('', 'docs/README.md').some(route => route.name === 'git-github'));
  assert.ok(routeSkills('', '.github/workflows/ci.yml').some(route => route.name === 'git-github'));
});

test('routing ignores unrelated, negated and source-code readme mentions', () => {
  const negatives = [
    ['git-github','Improve the readme parser performance'],
    ['git-github','Explain how to write a README'],
    ['git-github','Fix the readme renderer'],
    ['git-github','Implement security policy enforcement in the gateway'],
    ['git-github','Improve autonomous browser workflows'],
    ['git-github','Refactor the build pipeline of the transpiler'],
    ['git-github','Explain the changelog format'],
    ['git-github','Fix a bug in the version parser'],
    ['git-github','Do not write release notes; fix the API'],
  ];
  for (const [name, prompt] of negatives) {
    assert.ok(!routeSkills(prompt).some(route => route.name === name), prompt);
  }
});
