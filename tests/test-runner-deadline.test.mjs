import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const template=path.resolve(import.meta.dirname,'..');
const agent=[path.join(template,'agent'),path.resolve(template,'..')].find(p=>fs.existsSync(path.join(p,'scripts/lib/test-runner.mjs')));
const {runSuite}=await import(pathToFileURL(path.join(agent,'scripts/lib/test-runner.mjs')));

test('a successful test parent cannot leave inherited output pipes beyond the suite deadline',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'runner-deadline-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'fixture.mjs');
 fs.writeFileSync(file,`import {spawn} from 'node:child_process';
spawn(process.execPath,['-e','setTimeout(()=>{},1500)'],{stdio:'inherit'}).unref();`);
 const result=await runSuite('inherited-pipes',file,{timeoutMs:200});
 assert.equal(result.ok,false,'open descendant pipes are not a completed suite');
 assert.match(result.error,/deadline/);
 assert.ok(result.ms<1200,`deadline must cover pipe closure, took ${result.ms}ms`);
});
