import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/lib/output-distiller.ts')));
const {distillOutput,isSearchCommand}=await import(pathToFileURL(path.join(agent,'extensions/lib/output-distiller.ts')));

test('long compound shell search keeps locations and other output in a bounded excerpt',()=>{
 const command='cat package.json; rg -n widget assets/app.js; grep -n widget index.html';
 const metadata='{"name":"example-project"}';
 const warning='grep: missing.html: No such file or directory';
 const raw=[metadata,'assets/app.js:17:const widget='+('value,'.repeat(4500))+'FINAL_MATCH;', '42:<div>'+('widget '.repeat(1500))+'</div>',warning].join('\n');
 const original=raw;
 assert.ok(raw.length>30000);assert.equal(isSearchCommand(command),true);
 const result=distillOutput('bash',raw,command);
 assert.equal(result?.family,'search');assert.ok(result.text.length<6000);
 const projection=JSON.parse(result.text);
 assert.equal(projection.complete,false);assert.equal(projection.lineExcerpts,true);
 assert.ok(projection.excerpts.some(row=>row.text===metadata));
 assert.ok(projection.excerpts.some(row=>row.text===warning));
 assert.ok(projection.excerpts.some(row=>row.text.startsWith('assets/app.js:17:')&&row.text.endsWith('FINAL_MATCH;')&&row.omittedChars>0));
 assert.ok(projection.excerpts.some(row=>row.text.startsWith('42:')&&row.omittedChars>0));
 assert.match(result.text,/middle omitted/);assert.match(projection.locationNote,/original command/);
 assert.equal(raw,original,'the projection does not replace the source result');
 assert.equal(result.inputChars,raw.length);assert.equal(result.outputChars,result.text.length);
});

test('source reads and patch output are not misclassified as minified search results',()=>{
 const located='assets/app.js:17:'+('source '.repeat(4500));
 assert.equal(isSearchCommand('cat assets/app.js'),false);
 assert.equal(distillOutput('bash',located,'cat assets/app.js'),undefined);
 assert.equal(distillOutput('read',located,true),undefined);
 const diff=['diff --git a/app.js b/app.js','--- a/app.js','+++ b/app.js','@@ -1 +1 @@','-old','+new',located].join('\n');
 assert.equal(distillOutput('bash',diff,'git diff; rg -n source app.js'),undefined,'an oversized patch remains raw instead of entering search excerpting');
});
