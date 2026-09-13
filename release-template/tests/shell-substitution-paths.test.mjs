import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
const template = path.resolve(import.meta.dirname, '..');
const agent = [path.join(template, 'agent'), path.resolve(template, '..')].find(p => fs.existsSync(path.join(p, 'extensions/filesystem-safety.ts')));
const filename = path.join(agent, 'extensions/filesystem-safety.ts');
let source = fs.readFileSync(filename, 'utf8')
  .replace(/import \{\s*getAgentDir,[\s\S]*?from "@earendil-works\/pi-coding-agent";/, `const getAgentDir=()=>${JSON.stringify(agent)};`)
  .replace(/from "(\.\/?[^"\n]+)"/g, (_, ref) => `from ${JSON.stringify(new URL(ref, pathToFileURL(filename)).href)}`);
const { invalidShellPath, assessShellMutation } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source)).toString('base64'));

test('quoted grep command substitutions do not turn regexes into redirection paths', () => {
  const command = String.raw`for app in alpha beta; do
 f=$app/index.html
 printf "%s input=%s id=%s\n" "$app" \
  "$(grep -coE '<input[^>]*type="(search|text)"' $f)" \
  "$(grep -oE '<input[^>]*type="(search|text)"[^>]*' $f | grep -oE 'id="[^"]+"' | head -1)" \
  "$(grep -c 'type="search"' $f)"
done`;
  assert.equal(invalidShellPath(command), undefined);
  assert.equal(invalidShellPath(String.raw`printf '%s' "$(printf '%s' "$(grep -oE '<input[^>]*type="(search|text)"' index.html)")"`), undefined);
});

test('literal invalid paths within and after substitutions remain blocked', () => {
  for (const command of [
    'printf "%s" "$(touch "bad\nfile")"',
    'printf "%s" "$(printf "%s" "$(touch \'bad\nfile\')")"',
    'printf "%s" "$(grep -oE \'[^>]*\' index.html)"; touch "bad\nfile"',
    'cat "$(printf filename)" > "bad\nfile"',
    "touch 'bad\n$(printf filename)'",
  ]) assert.match(invalidShellPath(command) ?? '', /invalid filesystem path/, command);
  assert.equal(assessShellMutation('printf "%s" "$(rm -rf /)"', '/tmp/fixture', {})?.level, 'block', 'independent mutation guard still rejects protected destructive substitution');
});
