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
  'java-cross-platform',
  'c-cpp-multiplatform',
  'linux-network-engineering',
  'linux-desktop-ui-ux',
  'proxy-analysis',
  'packet-trace-analysis',
  'multi-developer-pipelines',
  'modern-frontend-frameworks',
  'gif-animation-editing',
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
    ['java-cross-platform','Package this Java app for Windows and macOS with jpackage'],
    ['java-cross-platform','Port this Java app from Linux to Windows and macOS'],
    ['c-cpp-multiplatform','Build this C++ project to cross-compile for ARM Linux with CMake'],
    ['c-cpp-multiplatform','Port this C firmware to ARM and embedded Linux targets'],
    ['linux-network-engineering','Diagnose the DNS resolution failure on this Linux server'],
    ['linux-network-engineering','Run mtr to investigate packet loss on the uplink'],
    ['linux-desktop-ui-ux','Design a GTK settings dialog for GNOME following the system theme'],
    ['proxy-analysis','Set up a proxy chain and check for DNS leaks'],
    ['packet-trace-analysis','Analyze this TCP handshake and retransmission pattern in the trace'],
    ['multi-developer-pipelines','Set up trunk-based development with release trains for our team'],
    ['modern-frontend-frameworks','Fix the hydration mismatch in our Next.js app with server components'],
    ['gif-animation-editing','Remove the background of this animated gif and compress it'],
    ['gif-animation-editing','Combine these two gifs side by side with ffmpeg'],
  ];
  for (const [name, prompt] of positives) {
    assert.ok(routeSkills(prompt).some(route => route.name === name), prompt);
  }
  assert.ok(routeSkills('', 'build/CMakeLists.txt').some(route => route.name === 'c-cpp-multiplatform'));
  assert.ok(routeSkills('', 'ui/dialog.ui').some(route => route.name === 'linux-desktop-ui-ux'));
  assert.ok(routeSkills('', 'src/App.vue').some(route => route.name === 'modern-frontend-frameworks'));
  assert.ok(routeSkills('', 'src/Widget.svelte').some(route => route.name === 'modern-frontend-frameworks'));
  assert.ok(routeSkills('', 'etc/resolv.conf').some(route => route.name === 'linux-network-engineering'));
});

test('expanded routing ignores unrelated, negated and explain-only prompts', () => {
  const negatives = [
    ['multi-developer-pipelines','Refactor the build pipeline of the transpiler'],
    ['multi-developer-pipelines','Explain the changelog format'],
    ['multi-developer-pipelines','Fix the license header check in CI'],
    ['linux-network-engineering','Implement security policy enforcement in the gateway'],
    ['proxy-analysis','Find Tailscale exit nodes for the office'],
    ['gif-animation-editing','Explain how GIF encoding works'],
    ['modern-frontend-frameworks','Explain how React hooks work'],
    ['java-cross-platform','Explain how Java garbage collection works'],
    ['packet-trace-analysis','Explain what a TCP handshake is'],
    ['c-cpp-multiplatform','Do not port this C tool to Windows'],
  ];
  for (const [name, prompt] of negatives) {
    assert.ok(!routeSkills(prompt).some(route => route.name === name), prompt);
  }
});
