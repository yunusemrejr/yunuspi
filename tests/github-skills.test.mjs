import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root, 'agent'), path.resolve(root, '..')]
  .find(p => fs.existsSync(path.join(p, 'extensions/lib/skill-routing.ts')));
const {routeSkills} = await import(pathToFileURL(path.join(agent, 'extensions/lib/skill-routing.ts')));

const names = [
  'github-readme-authoring',
  'github-repo-presentation',
  'github-release-notes',
  'github-actions-workflows',
];

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
    ['github-readme-authoring','Write a README for the new library'],
    ['github-readme-authoring','Improve the project README badges'],
    ['github-readme-authoring','Rewrite the README quickstart section'],
    ['github-repo-presentation','Add a CONTRIBUTING guide and issue templates'],
    ['github-repo-presentation','Prepare the repository for outside contributors with a security policy and code of conduct'],
    ['github-release-notes','Write release notes for v1.2.0'],
    ['github-release-notes','Draft the 2.0 pre-release notes'],
    ['github-release-notes','Update the changelog before the release'],
    ['github-actions-workflows','Add a GitHub Actions workflow that runs the tests'],
    ['github-actions-workflows','Harden our CI pipeline against fork pull requests'],
    ['github-actions-workflows','Fix the failing GitHub Actions job'],
  ];
  for (const [name, prompt] of positives) {
    assert.ok(routeSkills(prompt).some(route => route.name === name), prompt);
  }
  assert.ok(routeSkills('', 'docs/README.md').some(route => route.name === 'github-readme-authoring'));
  assert.ok(routeSkills('', '.github/workflows/ci.yml').some(route => route.name === 'github-actions-workflows'));
});

test('routing ignores unrelated, negated and source-code readme mentions', () => {
  const negatives = [
    ['github-readme-authoring','Improve the readme parser performance'],
    ['github-readme-authoring','Explain how to write a README'],
    ['github-readme-authoring','Fix the readme renderer'],
    ['github-repo-presentation','Fix the license header check in CI'],
    ['github-repo-presentation','Implement security policy enforcement in the gateway'],
    ['github-actions-workflows','Improve autonomous browser workflows'],
    ['github-actions-workflows','Refactor the build pipeline of the transpiler'],
    ['github-release-notes','Explain the changelog format'],
    ['github-release-notes','Fix a bug in the version parser'],
    ['github-release-notes','Do not write release notes; fix the API'],
  ];
  for (const [name, prompt] of negatives) {
    assert.ok(!routeSkills(prompt).some(route => route.name === name), prompt);
  }
});
