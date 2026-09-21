import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const agentRoot=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/pi-subagents/src/extension/autonomous-recovery.ts')));
assert.ok(agentRoot,'recovery source ships with the distribution');
const {findGroupLaunchModel,splitRouteForAccounting}=await import(pathToFileURL(path.join(agentRoot,'extensions/pi-subagents/src/extension/autonomous-recovery.ts')));

const models=[{provider:'deepseek',id:'deepseek-flash'},{provider:'friendli',id:'zai-org/GLM-5.3-Flash'}];

test('team route lookup tolerates thinking suffixes',()=>{
 assert.equal(findGroupLaunchModel(models,'deepseek/deepseek-flash'),models[0]);
 assert.equal(findGroupLaunchModel(models,'deepseek/deepseek-flash:high'),models[0]);
 assert.equal(findGroupLaunchModel(models,'friendli/zai-org/GLM-5.3-Flash:max'),models[1]);
});

test('team route lookup misses cleanly instead of throwing',()=>{
 assert.equal(findGroupLaunchModel(models,'runinfra/glm-5-3-flash'),undefined);
 assert.equal(findGroupLaunchModel(models,'deepseek/nope:low'),undefined);
 assert.equal(findGroupLaunchModel([], 'deepseek/deepseek-flash'),undefined);
});

test('route accounting splits provider/id off the base route',()=>{
 assert.deepEqual(splitRouteForAccounting('deepseek/deepseek-flash:high'),{provider:'deepseek',model:'deepseek-flash'});
 assert.deepEqual(splitRouteForAccounting('friendli/zai-org/GLM-5.3-Flash'),{provider:'friendli',model:'zai-org/GLM-5.3-Flash'});
 assert.deepEqual(splitRouteForAccounting('bare-id'),{provider:'bare-id',model:'bare-id'});
});
