import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const exporter = [path.join(root, 'agent/scripts/harness-public-export.mjs'), path.resolve(root, '../scripts/harness-public-export.mjs')].find(p => fs.existsSync(p));
assert.ok(exporter, 'exporter must be shipped');
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-safety-'));
  const source = path.join(dir, 'source'), templates = path.join(dir, 'templates'), output = path.join(dir, 'output');
  for (const name of ['extensions', 'skills', 'scripts', 'npm']) fs.mkdirSync(path.join(source, name), { recursive: true });
  fs.mkdirSync(path.join(templates, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts/check-public.mjs'), path.join(templates, 'scripts/check-public.mjs'));
  fs.writeFileSync(path.join(source, 'extensions/live-models.ts'), 'export const live = true;\n');
  fs.writeFileSync(path.join(source, 'extensions/manifest.json'), JSON.stringify({ supportFiles: [] }));
  for (const name of ['package.json', 'package-lock.json']) fs.writeFileSync(path.join(source, 'npm', name), '{}');
  return { dir, source, templates, output, run: () => spawnSync(process.execPath, [exporter, '--source', source, '--templates', templates, '--output', output], { encoding: 'utf8' }) };
}
test('exporter rejects exact OAuth and account canaries without exposing their values', () => {
  for (const field of ['access', 'refresh', 'accountId']) {
    const f = fixture();
    try {
      const value = ['private', field, 'export', 'canary', '90871'].join('-');
      fs.writeFileSync(path.join(f.source, 'auth.json'), JSON.stringify({ provider: { [field]: value } }));
      fs.writeFileSync(path.join(f.source, 'extensions/leak.ts'), '// ' + value);
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.ok(!`${result.stdout}${result.stderr}`.includes(value));
      assert.ok(!fs.existsSync(f.output));
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.source, 'auth.json'))).provider[field], value);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
});
test('exporter refuses nonempty destinations and preserves existing files', () => {
  const f = fixture();
  try {
    fs.mkdirSync(f.output);
    fs.writeFileSync(path.join(f.output, 'existing.txt'), 'keep');
    assert.notEqual(f.run().status, 0);
    assert.equal(fs.readFileSync(path.join(f.output, 'existing.txt'), 'utf8'), 'keep');
    assert.deepEqual(fs.readdirSync(f.output), ['existing.txt']);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
test('clean fixture exports without copying private configuration', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.source, 'auth.json'), JSON.stringify({ provider: { access: ['private', 'credential', 'not', 'in', 'source'].join('-') } }));
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(f.output, 'agent/extensions/live-models.ts')));
    assert.ok(!fs.existsSync(path.join(f.output, 'agent/auth.json')));
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
test('exporter refuses a hardcoded home path in executable source but sanitizes docs', () => {
  const f = fixture();
  try {
    const literal = path.join(os.homedir(), '.pi/agent/extensions/pi-lens/dist/index.js');
    fs.mkdirSync(path.join(f.source, 'scripts/patches'), { recursive: true });
    fs.mkdirSync(path.join(f.source, 'skills/example'), { recursive: true });
    fs.writeFileSync(
      path.join(f.source, 'scripts/patches/example-patch.mjs'),
      `const DIST = ${JSON.stringify(literal)};\n`,
    );
    fs.writeFileSync(
      path.join(f.source, 'skills/example/SKILL.md'),
      `Install under ${os.homedir()}/.pi/agent and read the notes.\n`,
    );
    const rejected = f.run();
    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stdout}${rejected.stderr}`, /Hardcoded home path/);
    assert.ok(!fs.existsSync(f.output));

    // Documentation keeps the privacy substitution instead of failing.
    fs.rmSync(path.join(f.source, 'scripts/patches/example-patch.mjs'));
    const accepted = f.run();
    assert.equal(accepted.status, 0, accepted.stderr);
    const shipped = fs.readFileSync(path.join(f.output, 'agent/skills/example/SKILL.md'), 'utf8');
    assert.ok(shipped.includes('/home/example/.pi/agent'));
    assert.ok(!shipped.includes(os.homedir()));
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('template dependency installs are omitted from both exported roots',()=>{
 const f=fixture();
 try {
  fs.mkdirSync(path.join(f.templates,'node_modules/.bin'),{recursive:true});
  fs.symlinkSync('/unreadable/dependency',path.join(f.templates,'node_modules/.bin/tool'));
  fs.writeFileSync(path.join(f.templates,'node_modules/generated.js'),'generated dependency');
  const result=f.run();
  assert.equal(result.status,0,result.stderr);
  assert.equal(fs.existsSync(path.join(f.output,'node_modules')),false);
  assert.equal(fs.existsSync(path.join(f.output,'release-template/node_modules')),false);
 } finally {fs.rmSync(f.dir,{recursive:true,force:true});}
});
