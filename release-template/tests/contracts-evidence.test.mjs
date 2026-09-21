import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/lib/session-cost.ts')));
const {collectSessionCost:collect}=await import(pathToFileURL(path.join(agent,'extensions/lib/session-cost.ts')));

test('audit: unpriced child usage renders unknown, not $0',()=>{
 const receipt=(runId,results)=>({type:'custom',customType:'subagent-cost-v1',data:{runId,results}});
 const r=collect([receipt('x',[{runId:'a',usage:{input:100,output:20,cacheRead:0,cacheWrite:0,turns:1,cost:'unknown'}}])]);
 assert.equal(r.unknown,true);
 assert.ok(!/^\$0(\.0+)?$/.test(r.formatted),'formatted='+r.formatted);
});
