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
  'systems-languages',
  'networking',
  'ui-design',
  'git-github',
  'frontend',
  'svg-images',
];

test('expanded skills ship with descriptions and resolvable references', () => {
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

test('deterministic routing selects the intended expanded skill', () => {
  const positives = [
    ['systems-languages','Package this Java app for Windows and macOS with jpackage'],
    ['systems-languages','Port this Java app from Linux to Windows and macOS'],
    ['systems-languages','Build this C++ project to cross-compile for ARM Linux with CMake'],
    ['systems-languages','Port this C firmware to ARM and embedded Linux targets'],
    ['networking','Diagnose the DNS resolution failure on this Linux server'],
    ['networking','Run mtr to investigate packet loss on the uplink'],
    ['ui-design','Design a GTK settings dialog for GNOME following the system theme'],
    ['networking','Set up a proxy chain and check for DNS leaks'],
    ['networking','Analyze this TCP handshake and retransmission pattern in the trace'],
    ['git-github','Set up trunk-based development with release trains for our team'],
    ['frontend','Fix the hydration mismatch in our Next.js app with server components'],
    ['svg-images','Remove the background of this animated gif and compress it'],
    ['svg-images','Combine these two gifs side by side with ffmpeg'],
  ];
  for (const [name, prompt] of positives) {
    assert.ok(routeSkills(prompt).some(route => route.name === name), prompt);
  }
  assert.ok(routeSkills('', 'build/CMakeLists.txt').some(route => route.name === 'systems-languages'));
  assert.ok(routeSkills('', 'ui/dialog.ui').some(route => route.name === 'ui-design'));
  assert.ok(routeSkills('', 'src/App.vue').some(route => route.name === 'frontend'));
  assert.ok(routeSkills('', 'src/Widget.svelte').some(route => route.name === 'frontend'));
  assert.ok(routeSkills('', 'etc/resolv.conf').some(route => route.name === 'networking'));
});

test('expanded routing ignores unrelated, negated and explain-only prompts', () => {
  const negatives = [
    ['git-github','Refactor the build pipeline of the transpiler'],
    ['git-github','Explain the changelog format'],
    ['networking','Implement security policy enforcement in the gateway'],
    ['svg-images','Explain how GIF encoding works'],
    ['frontend','Explain how React hooks work'],
    ['systems-languages','Explain how Java garbage collection works'],
    ['networking','Explain what a TCP handshake is'],
    ['systems-languages','Do not port this C tool to Windows'],
  ];
  for (const [name, prompt] of negatives) {
    assert.ok(!routeSkills(prompt).some(route => route.name === name), prompt);
  }
});

test('office prompts route to the authoring skills that stage office_doc, including saves, legacy files and conversions', () => {
  const route = (text) => (routeSkills(text, '') ?? []).map(entry => entry.name ?? entry);
  assert.ok(route('Can you save this Word file as a PDF for me?').includes('office-documents'));
  assert.ok(route('read the contract.doc and summarize the termination clause').includes('office-documents'));
  assert.ok(route('Open invoice-2019.doc and tell me the total due, then convert prices.xls to a CSV file').includes('office-documents'));
  assert.ok(route('Make a 6-slide PowerPoint deck pitch.pptx for our new product with speaker notes.').includes('office-documents'));
  assert.ok(!route('save the changes to the repository and push').includes('office-documents'), 'a save that names no office document routes nowhere');
});
