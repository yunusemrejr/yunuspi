// Preserve the loaded local runtime's allocation through explicit model overrides.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MARKER = '/* PI_LOCAL_ALLOCATION */';
const IDENTIFIER = '[$A-Za-z_][$\\w]*';
const original = new RegExp(`contextWindow:\\s*(${IDENTIFIER})\\.contextWindow\\s*\\?\\?\\s*(${IDENTIFIER})\\.contextWindow,\\s*maxTokens:\\s*\\1\\.maxTokens\\s*\\?\\?\\s*\\2\\.maxTokens,`, 'g');

function replacement(override, model) {
  const allocation = `(Number.isSafeInteger(${model}._piAllocatedContext)&&${model}._piAllocatedContext>0?${model}._piAllocatedContext:Infinity)`;
  const context = `Math.min(${allocation},${override}.contextWindow??${model}.contextWindow)`;
  return `${MARKER}contextWindow:${context},maxTokens:Math.min(${override}.maxTokens??${model}.maxTokens,${context}),`;
}

export function isAppliedSource(source) {
  if (source.split(MARKER).length !== 2 || [...source.matchAll(original)].length) return false;
  const tail = source.slice(source.indexOf(MARKER));
  const model = new RegExp(`^/\\* PI_LOCAL_ALLOCATION \\*/contextWindow:Math\\.min\\(\\(Number\\.isSafeInteger\\((${IDENTIFIER})\\._piAllocatedContext\\)`).exec(tail)?.[1];
  const override = new RegExp(`,(${IDENTIFIER})\\.contextWindow\\?\\?`).exec(tail.slice(0, 500))?.[1];
  return Boolean(model && override && tail.startsWith(replacement(override, model)));
}

export function patchSource(source) {
  if (isAppliedSource(source)) return source;
  if (source.includes('PI_LOCAL_ALLOCATION')) throw Error('local allocation patch partial/drifted');
  if ([...source.matchAll(original)].length !== 1) throw Error('local allocation composer anchor drift');
  const next = source.replace(original, (_match, override, model) => replacement(override, model));
  if (!isAppliedSource(next)) throw Error('local allocation postcondition failed');
  return next;
}

export function targets() {
  if (!process.env.PI_HARNESS_PATCH_TEST_CORE) throw Error("Legacy transform targets are test-only; set an isolated fixture core explicitly");
  const core = process.env.PI_HARNESS_PATCH_TEST_CORE ?? path.join(
    execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(),
    '@yunuspi/coding-agent',
  );
  const dir = path.join(core, 'dist/bundle/chunks');
  const files = [path.join(core, 'dist/core/provider-composer.js'), ...fs.readdirSync(dir)
    .filter(name => name.endsWith('.js')).map(name => path.join(dir, name))
    .filter(file => fs.readFileSync(file, 'utf8').includes('function applyModelOverride('))];
  if (files.length !== 2) throw Error('local allocation owners missing');
  return files.map(file => ({
    name: 'context allocation ' + path.basename(file),
    exists: () => fs.existsSync(file),
    isApplied: () => isAppliedSource(fs.readFileSync(file, 'utf8')),
    apply() {
      const source = fs.readFileSync(file, 'utf8'), next = patchSource(source);
      execFileSync(process.execPath, ['--input-type=module', '--check'], { input: next });
      if (next !== source) fs.writeFileSync(file, next);
    },
  }));
}
