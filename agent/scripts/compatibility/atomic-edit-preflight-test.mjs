import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRelevantGuidance} from '../../extensions/lib/relevant-guidance.ts';
const source=fs.readFileSync(new URL('../../extensions/pi-lens/dist/index.js',import.meta.url),'utf8');
const start=source.indexOf('      if (preflightError) {',source.indexOf('  if (isEditOnly && filePath && !getFlag("no-read-guard")) {'));
const end=source.indexOf('      logToolReadGuardEvent({',start);
assert.ok(start>0&&end>start);
const body=source.slice(start,end);
for(const partial of [[],[{oldText:'a',newText:'b'}]]) {
 let writes=0;
 const run=vm.runInNewContext('(async()=>{'+body+'return {block:false};})',{preflightError:'stale target; No edits were applied.',partiallyApplicable:partial,editBatchSummary:{},applyPartiallyApplicableEdits(){writes++;throw Error('must not mutate');},logBlockedEditSummary(){}});
 assert.equal((await run()).block,true);assert.equal(writes,0);
}
const ctx={cwd:'/edit-case',sessionManager:{getBranch:()=>[]},model:{input:['text']}};
const g=createRelevantGuidance({getActiveTools:()=>['read','edit'],appendEntry(){}});g.restore(ctx);g.start({prompt:'Continue',systemPrompt:''},ctx);
g.record({toolName:'edit',input:{path:'main.css'},isError:true,content:[{type:'text',text:'Could not find edits[0]. No edits were applied.'}]});
const hints=g.candidates();assert.ok(hints.some(h=>h.key==='signal:edit-recovery'));g.commit(hints);
g.record({toolName:'edit',input:{path:'main.css'},isError:true,content:[{type:'text',text:'Edit without read'}]});assert.ok(!g.candidates().some(h=>h.key==='signal:edit-recovery'));
const coverageGuidance=createRelevantGuidance({getActiveTools:()=>['read','edit'],appendEntry(){}});coverageGuidance.restore(ctx);coverageGuidance.start({prompt:'Continue',systemPrompt:''},ctx);
coverageGuidance.record({toolName:'edit',input:{path:'main.css'},isError:true,content:[{type:'text',text:'No verified read-tool coverage for `main.css`. Shell cat/sed/grep output does not establish read-guard coverage.'}]});
const coverageHints=coverageGuidance.candidates();assert.ok(coverageHints.some(h=>h.key==='signal:edit-recovery'),'updated read guard wording triggers recovery on first error');coverageGuidance.commit(coverageHints);
coverageGuidance.record({toolName:'edit',input:{path:'main.css'},isError:true,content:[{type:'text',text:'No verified read-tool coverage for `main.css`.'}]});assert.ok(!coverageGuidance.candidates().some(h=>h.key==='signal:edit-recovery'));
console.log('Rejected batches do not execute partial writes; first-error guidance is bounded.');
