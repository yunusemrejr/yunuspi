import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
const repositoryRoot=path.resolve(import.meta.dirname,'..');
const agentRoot=[path.join(repositoryRoot,'agent'),path.resolve(repositoryRoot,'..')].find(p=>fs.existsSync(path.join(p,'extensions/pi-subagents/src/shared/utils.ts')));
assert.ok(agentRoot,'subagent shared utils ship with the distribution');
const {getFinalOutput}=await import(pathToFileURL(path.join(agentRoot,'extensions/pi-subagents/src/shared/utils.ts')));
const {extractJsonEnvelope}=await import(pathToFileURL(path.join(agentRoot,'extensions/pi-subagents/src/shared/reviewer-envelope.ts')));

const envelope='```json\n{"reviews":[{"aspect":"correctness","outcome":"pass","evidence":["src/value.js:1 establishes the input contract"],"findings":[],"gap":""}]}\n```';
const notice='\n\n---\n⚠️ Continuation pending — this session will keep running after this answer:\n- queued follow-up messages will continue this session automatically\nThis notice is automatic; user instructions still govern what runs.';

test('final output keeps a fenced report when a hook appends a trailing notice part',()=>{
 const messages=[{role:'assistant',content:[{type:'text',text:envelope},{type:'text',text:notice}]}];
 const output=getFinalOutput(messages);
 assert.ok(output.includes('"reviews"'),'report envelope survives the trailing notice part');
 assert.ok(output.includes('Continuation pending'),'trailing notice stays visible');
 const parsed=extractJsonEnvelope(output);
 assert.equal(parsed?.reviews?.[0]?.aspect,'correctness','review dispatch can extract the envelope from final output alone');
});

test('final output still prefers the latest message and skips errored turns',()=>{
 assert.equal(getFinalOutput([{role:'assistant',content:[{type:'text',text:'done'}]}]),'done');
 const callsOnly={role:'assistant',content:[{type:'toolCall',id:'r1',name:'read',arguments:{path:'src/value.js'}}]};
 assert.equal(getFinalOutput([{role:'assistant',content:[{type:'text',text:'earlier answer'}]},callsOnly]),'earlier answer');
 assert.equal(getFinalOutput([{role:'assistant',content:[{type:'text',text:'good'}]},{role:'assistant',stopReason:'error',content:[{type:'text',text:'bad'}]}]),'good');
 assert.equal(getFinalOutput([{role:'assistant',content:[{type:'text',text:'   '}]}]),'');
 assert.equal(getFinalOutput([]),'');
});
