#!/usr/bin/env node
/** Parse source files with the extension loader's own parser (jiti), so a file
 * the runtime cannot load never reaches main. Per-file tests import libraries
 * and can pass while an entry file fails to parse at load.
 * Usage: node scripts/check-syntax.mjs [files...]   (default: every tracked source file)
 *        node scripts/check-syntax.mjs --changed BASE (changed sources; unknown history checks all)
 *        node scripts/check-syntax.mjs --pre-push    (files changed by the pushed commits; refs on stdin) */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = /^(?:agent|core\/[^/]+\/src|scripts|tests)\/.+\.(?:ts|mts|js|mjs)$/;
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
const ZERO = /^0+$/;

function changedByPush(stdin) {
  const files = new Set();
  for (const line of stdin.split('\n')) {
    const [, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue; // a deleted ref pushes no source
    const range = remoteSha && !ZERO.test(remoteSha) ? [`${remoteSha}..${localSha}`] : [localSha, '--not', '--remotes'];
    for (const file of git('log', '--name-only', '--diff-filter=AM', '--format=', ...range).split('\n')) if (file) files.add(file);
  }
  return [...files];
}

// Explicit paths are checked as given (relative to the repository or absolute); enumerated ones are source files only.
const tracked = () => git('ls-files', '-z').split('\0').filter(file => SOURCE.test(file));
let files = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
if (process.argv.includes('--changed')) {
  const base = process.argv[process.argv.indexOf('--changed') + 1];
  try {
    if (!/^[a-f0-9]{40}$/.test(base ?? '') || ZERO.test(base)) throw Error('Unknown baseline');
    files = git('diff', '--name-only', '-z', base, 'HEAD', '--').split('\0').filter(file => SOURCE.test(file));
  } catch { files = tracked(); }
} else if (process.argv.includes('--pre-push')) files = changedByPush(fs.readFileSync(0, 'utf8')).filter(file => SOURCE.test(file));
else if (!files.length) files = tracked();
files = files.filter(file => /\.(?:ts|mts|js|mjs)$/.test(file) && fs.existsSync(path.resolve(root, file)));

let createJiti;
try { ({ createJiti } = createRequire(path.join(root, 'core/coding-agent/package.json'))('jiti')); }
catch { console.error('check-syntax: jiti is not installed; run npm ci before checking syntax.'); process.exit(1); }
const jiti = createJiti(root);
const failures = [];
for (const file of files) {
  const source = fs.readFileSync(path.resolve(root, file), 'utf8');
  let out;
  try { out = jiti.transform({ source, filename: file, ts: /\.m?ts$/.test(file) }); }
  catch (error) { failures.push(`${file}: ${error.message}`); continue; }
  const marker = /__JITI_ERROR__ = (\{.*\})/.exec(out)?.[1];
  if (marker) {
    let detail = marker;
    try { const e = JSON.parse(marker); detail = `${e.line}:${e.column} ${e.code}: ${String(e.message).trim()}`; } catch { /* keep raw */ }
    failures.push(`${file}:${detail}`);
  }
}
if (failures.length) {
  console.error(`check-syntax: ${failures.length} file(s) cannot be parsed by the extension loader:\n${failures.map(line => `  ${line}`).join('\n')}`);
  process.exit(1);
}
console.log(`check-syntax: ${files.length} file(s) parse.`);
