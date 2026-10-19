import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {parse} from 'yaml';
import {routeSkills, routeSkillsPrecise} from '../agent/extensions/lib/skill-routing.ts';

const root = path.resolve(import.meta.dirname, '..');
const skillDir = path.join(root, 'agent/skills/anatomy');
const skillFile = path.join(skillDir, 'SKILL.md');
const routes = prompt => routeSkills(prompt).map(route => route.name);

test('Anatomy ships its pinned MIT kit, references and all eight examples', () => {
  const provenance = JSON.parse(fs.readFileSync(path.join(skillDir, 'UPSTREAM.json'), 'utf8'));
  assert.equal(provenance.repository, 'https://github.com/wheresryan22/anatomy');
  assert.match(provenance.commit, /^[a-f0-9]{40}$/);
  assert.equal(provenance.license, 'MIT');
  assert.deepEqual(Object.keys(provenance.modifiedFiles), ['SKILL.md']);
  for (const [file, hash] of Object.entries(provenance.files)) {
    const data = fs.readFileSync(path.join(skillDir, file));
    if (!provenance.modifiedFiles[file]) assert.equal(createHash('sha256').update(data).digest('hex'), hash, file);
  }
  assert.equal(fs.readdirSync(path.join(skillDir, 'examples')).length, 8);
  assert.match(fs.readFileSync(path.join(skillDir, 'LICENSE'), 'utf8'), /Copyright \(c\) 2026 Ryan/);
  const guide = fs.readFileSync(skillFile, 'utf8');
  const metadata = parse(guide.split('---')[1]);
  assert.equal(metadata.name, 'anatomy');
  assert.match(metadata.description, /3D mechanism animations/);
  assert.ok(metadata.description.length <= 1024);
  assert.match(guide, /any selected YunusPi model or native child agent/);
  assert.match(guide, /copy the needed kit and example sources into the user's project/i);
});

test('visual explanations and 3D animation requests route without a special command', () => {
  for (const prompt of [
    'Make a 3D animation of a mechanical watch.',
    'Draw an isometric diagram of this mechanism.',
    'Build a technical illustration for our documentation.',
    'Create an exploded view of this pump.',
    'Draw a cutaway of the engine.',
    'Create a scientific explainer of this mechanism.',
    'Build a visual explanation of how this algorithm works.',
    'Explain how an LRU cache evicts entries, interactive.',
    'Explain how this watch works as an SVG.',
    'Create a static SVG technical illustration without animation.',
    'Visualize the escapement as an interactive explainer.',
    '/skill:anatomy explain how a dial works, interactive, 3D',
    '/anatomy explain a queue, interactive',
    'Do not write a text explanation, but draw an isometric figure.',
  ]) {
    assert.ok(routes(prompt).includes('anatomy'), prompt);
    assert.ok(routeSkillsPrecise(prompt).slice(0, 3).some(route => route.name === 'anatomy'), prompt);
  }
  assert.ok(routes('Build a Blender 3D animation of this watch.').includes('3d-cad'), 'native Blender guidance remains available');
});

test('ordinary explanations, medical anatomy, quoted examples and exclusions stay unrouted', () => {
  for (const prompt of [
    'Explain how to write Python.',
    'Explain how a mechanical watch works.',
    'Review these human anatomy lecture notes.',
    'Do not create a 3D animation.',
    'Never use the anatomy skill.',
    '> Make a 3D animation of this mechanism.',
    '```\nDraw an isometric figure.\n```\nFix the parser.',
    '<mindset>Build interactive explainers.</mindset> Fix the parser.',
    'Fix the parser for src/anatomy/SKILL.md.',
    'Write a text explanation rather than create a 3D animation.',
  ]) assert.ok(!routes(prompt).includes('anatomy'), prompt);
});

const revealDir = path.join(root, 'agent/skills/anatomy-reveal');

test('Anatomy Reveal ships its pinned MIT references, scaffold and template with the kit notice', () => {
  const provenance = JSON.parse(fs.readFileSync(path.join(revealDir, 'UPSTREAM.json'), 'utf8'));
  assert.equal(provenance.repository, 'https://github.com/annnguyentt/anatomy-reveal-skill');
  assert.match(provenance.commit, /^[a-f0-9]{40}$/);
  assert.equal(provenance.license, 'MIT');
  assert.deepEqual(Object.keys(provenance.modifiedFiles), ['SKILL.md']);
  const shipped = [];
  const walk = dir => { for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full); else shipped.push(path.relative(revealDir, full));
  } };
  walk(revealDir);
  assert.deepEqual(shipped.filter(file => file !== 'UPSTREAM.json').sort(), Object.keys(provenance.files).sort(), 'every shipped file is pinned');
  for (const [file, hash] of Object.entries(provenance.files)) {
    const data = fs.readFileSync(path.join(revealDir, file));
    if (!provenance.modifiedFiles[file]) assert.equal(createHash('sha256').update(data).digest('hex'), hash, file);
  }
  assert.match(fs.readFileSync(path.join(revealDir, 'LICENSE'), 'utf8'), /Copyright \(c\) 2026 Ann Nguyen/);
  assert.match(fs.readFileSync(path.join(revealDir, 'template/kit/LICENSE'), 'utf8'), /Copyright \(c\) 2026 Ryan/);
  const guide = fs.readFileSync(path.join(revealDir, 'SKILL.md'), 'utf8');
  const metadata = parse(guide.split('---')[1]);
  assert.equal(metadata.name, 'anatomy-reveal');
  assert.ok(metadata.description.length <= 1024);
  assert.match(guide, /any selected YunusPi model or native child agent/);
  assert.match(guide, /`\/anatomy <object or mechanism>` starts a goal/);
  assert.match(fs.readFileSync(skillFile, 'utf8'), /`\/anatomy <subject>` starts a goal that uses it together with the sibling `anatomy-reveal` skill/);
});

test('object reveal and teardown requests route to Anatomy Reveal; /anatomy offers both skills', () => {
  for (const prompt of [
    'Make an anatomy reveal video of a Moka pot.',
    'Create a product reveal film of my sneaker, 1:1 for Instagram.',
    'Build an exploded-view animation of a mechanical keyboard, 8 seconds.',
    'Dissect this kettle into an interactive figure.',
    '/skill:anatomy-reveal a desk lamp',
  ]) {
    assert.ok(routes(prompt).includes('anatomy-reveal'), prompt);
    assert.ok(routeSkillsPrecise(prompt).slice(0, 3).some(route => route.name === 'anatomy-reveal'), prompt);
  }
  assert.ok(!routes('/skill:anatomy-reveal a desk lamp').includes('anatomy'), 'the reveal skill command does not also load the sibling');
  assert.ok(!routes('/skill:anatomy explain a dial, interactive').includes('anatomy-reveal'));
  for (const name of ['anatomy', 'anatomy-reveal']) assert.ok(routes('/anatomy a moka pot').includes(name), `/anatomy offers ${name}`);
  for (const prompt of ['Explain how a mechanical watch works.', 'Fix the reveal animation timing in the modal.', 'Fix the reveal video in the hero section.', 'Review these human anatomy lecture notes.', 'Never use the anatomy-reveal skill.'])
    assert.ok(!routes(prompt).includes('anatomy-reveal'), prompt);
});

test('the Anatomy Reveal template builds its figure and film pages offline from a project copy', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'anatomy-reveal-'));
  try {
    fs.cpSync(path.join(revealDir, 'template'), cwd, {recursive: true});
    for (const args of [['object/build.mjs'], ['object/build.mjs', '--light'], ['motion/build.mjs', '--duration', '3', '--ratio', '1:1']]) {
      const result = spawnSync(process.execPath, args, {cwd, encoding: 'utf8', timeout: 120000});
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
    for (const page of ['object/figure.html', 'object/figure-light.html', 'motion/motion.html']) {
      const html = fs.readFileSync(path.join(cwd, page), 'utf8');
      assert.match(html, /<script/, page);
    }
    assert.match(fs.readFileSync(path.join(cwd, 'motion/motion.html'), 'utf8'), /window\.frame = frame/);
  } finally { fs.rmSync(cwd, {recursive: true, force: true}); }
});

test('bundled SVG and true 3D examples build offline from a project copy', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'anatomy-example-'));
  try {
    for (const name of ['kit', 'scripts', 'examples/dial-indicator', 'examples/turning-dial'])
      fs.cpSync(path.join(skillDir, name), path.join(cwd, name), {recursive: true});
    for (const example of ['dial-indicator', 'turning-dial']) {
      const dir = path.join(cwd, 'examples', example);
      for (const file of fs.readdirSync(dir)) if (file.endsWith('.html')) fs.unlinkSync(path.join(dir, file));
      const variants = example === 'turning-dial' ? ['light'] : ['dark', 'light'];
      for (const theme of variants) {
        const args = theme === 'light' ? ['--light'] : [];
        const result = spawnSync(process.execPath, [path.join(dir, 'build.mjs'), ...args], {cwd, encoding: 'utf8', timeout: 60000});
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const name = `${example}${theme === 'light' ? '-light' : ''}.html`;
        const html = fs.readFileSync(path.join(dir, name), 'utf8');
        assert.match(html, /<svg/);
        assert.match(html, /<script/);
        assert.match(html, /requestAnimationFrame/);
        if (example === 'turning-dial') assert.match(html, /TURN\.mount/);
      }
    }
  } finally { fs.rmSync(cwd, {recursive: true, force: true}); }
});
