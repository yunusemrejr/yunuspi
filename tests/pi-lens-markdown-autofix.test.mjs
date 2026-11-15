import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {parseExpressionAt} from 'acorn';

// In a real session markdownlint --fix rewrote README bullets the edit had not
// touched (* -> -, MD004), and the edit result did not say so. Autofix for
// markdown now follows the project's own config only; without one, no fixer runs.
// The bundle ships as one file, so the shipped function sources are evaluated
// with injected collaborators.
const bundle=fs.readFileSync(new URL('../agent/extensions/pi-lens/dist/index.js',import.meta.url),'utf8');
function declaration(name) {
  const marker=[`async function ${name}(`,`function ${name}(`,`function* ${name}(`].map(needle=>bundle.indexOf(needle)).filter(at=>at>=0).sort((a,b)=>a-b)[0];
  assert.ok(marker!==undefined,`shipped ${name} exists`);
  return bundle.slice(marker,parseExpressionAt(bundle,marker,{ecmaVersion:'latest'}).end);
}
const configListAt=bundle.indexOf('MARKDOWNLINT_CONFIGS = [');
assert.ok(configListAt>=0,'the shipped markdownlint config names exist');
const configList=bundle.slice(configListAt,parseExpressionAt(bundle,configListAt,{ecmaVersion:'latest'}).end);

function harness() {
  const calls=[];
  const context=vm.createContext({
    fs34:fs,path44:path,path2:path,path152:path,existsSync:fs.existsSync,process,Date,Set,Map,Promise,
    lensWorkState:()=>true,__piLensRecentlyWritten:()=>false,
    getFlag:()=>false,getFlagSource:()=>undefined,dbg2(){},
    markdownlintConfigArgs:()=>[],
    tryMarkdownlintFix:async(target)=>{calls.push(target);fs.writeFileSync(target,fs.readFileSync(target,'utf8').replace(/^\* /gm,'- '));return 1;},
  });
  for (const name of ['Eslint','Stylelint','Sqlfluff','Rubocop','Biome','Golangci','Detekt','Ktfmt','Ktlint','Oxlint'])
    context[`has${name}Config`]=()=>false;
  for (const name of ['EslintFix','StylelintFix','SqlfluffFix','RubocopFix','KtlintFix','RustClippyFix','DartFix','GolangciLintFix','DetektFix','KtfmtFix','OxlintFix'])
    context[`try${name}`]=async()=>0;
  context.detectFileChangedAfterCommand=async()=>0;
  const names=['walkUpDirs','findNearestContaining','hasMarkdownlintConfig','getAutofixPolicyForFile','getPreferredAutofixTools','runAutofix'];
  vm.runInContext(`var ${configList};\n${names.map(declaration).join('\n')}\nthis.api={${names.join(',')}};`,context);
  return {api:context.api,calls};
}

const readme=`# Tool\n\n* **\`--force\` re-sends, it does not bypass the floors.** Minimum gaps remain.\n* **Archive requests are checked.** A save is confirmed before it is reported.\n* **Watch comparisons preserve unknowns.** Missing stays missing.\n`;

test('editing a markdown file in a project without markdown config leaves its * bullets alone',async()=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'lens-md-autofix-'));
  try {
    const file=path.join(cwd,'README.md');
    fs.writeFileSync(file,readme);
    const {api,calls}=harness();
    const result=await api.runAutofix(file,cwd,()=>false,()=>{}, {fixedThisTurn:new Set()});
    assert.equal(result.skipReason,'no_safe_tools','no fixer is chosen for markdown without a project config');
    assert.deepEqual(calls,[],'markdownlint --fix is never spawned');
    assert.equal(fs.readFileSync(file,'utf8'),readme,'the file the edit wrote is left exactly as it was');
  } finally { fs.rmSync(cwd,{recursive:true,force:true}); }
});

test('a project markdownlint config still opts markdown autofix in',async()=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'lens-md-autofix-'));
  try {
    fs.writeFileSync(path.join(cwd,'.markdownlint.json'),'{"MD013":false}\n');
    const file=path.join(cwd,'README.md');
    fs.writeFileSync(file,readme);
    const {api,calls}=harness();
    const result=await api.runAutofix(file,cwd,()=>false,()=>{}, {fixedThisTurn:new Set()});
    assert.deepEqual(calls,[file],'the configured fixer runs on the edited file');
    assert.equal(result.autofixTools.join(','),'markdownlint:1');
  } finally { fs.rmSync(cwd,{recursive:true,force:true}); }
});
