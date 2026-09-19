import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/lib/continuation-notice.ts')));
const {CONTINUATION_SOURCES,registerContinuationSource}=await import(pathToFileURL(path.join(agent,'extensions/lib/continuation-notice.ts')));
const {default:extension}=await import(pathToFileURL(path.join(agent,'extensions/continuation-notice.ts')));

test('settled blocked verification remains visible on each final without waking the model',()=>{
 const previous=globalThis[CONTINUATION_SOURCES];globalThis[CONTINUATION_SOURCES]=[];
 try {
  let blocked=true;const hooks={};
  registerContinuationSource({name:'project tests',pending:()=>[],verification:()=>blocked?['Live window pixels could not be verified.']:[]});
  extension({on:(name,fn)=>hooks[name]=fn});hooks.session_start();
  const event={message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'The app is ready.'}]}};
  const ctx={hasPendingMessages:()=>false};
  for(let i=0;i<2;i++) {
   const result=hooks.message_end(event,ctx),text=result.message.content.map(x=>x.text).join('\n');
   assert.match(text,/Verification incomplete/);assert.match(text,/Live window pixels/);
   assert.ok(!text.includes('will keep running'),'blocked verification creates no continuation promise');
  }
  blocked=false;assert.equal(hooks.message_end(event,ctx),undefined);
 } finally {globalThis[CONTINUATION_SOURCES]=previous;}
});

test('pi-lens warnings refer callers to the diagnostic owner instead of an absent cache file',()=>{
 const source=fs.readFileSync(path.join(agent,'extensions/pi-lens/dist/index.js'),'utf8');
 const match=/function formatCodeQualityWarningsAdvisory\(report\) \{[\s\S]*?\n\}/.exec(source);
 assert.ok(match);
 const format=new Function(`${match[0]}; return formatCodeQualityWarningsAdvisory;`)();
 const text=format({summary:{warnings:1,files:1,topRules:[]}});
 assert.match(text,/lens_diagnostics\(\{mode:"delta"\}\)/);
 assert.ok(!text.includes('.pi-lens/cache/'));
});
