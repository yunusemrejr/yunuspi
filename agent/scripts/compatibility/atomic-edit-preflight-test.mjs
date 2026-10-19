import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
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
console.log('Rejected batches do not execute partial writes.');
