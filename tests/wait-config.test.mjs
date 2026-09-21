import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const agentRoot=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/pi-subagents/src/runs/background/wait-config.ts')));
assert.ok(agentRoot,'wait-config source ships with the distribution');
const {resolveWaitToolConfig,WAIT_TOOL_DEFAULT_TIMEOUT_MS_ENV}=await import(pathToFileURL(path.join(agentRoot,'extensions/pi-subagents/src/runs/background/wait-config.ts')));

test('wait-config omits defaultTimeoutMs when neither env nor config sets it',()=>{
 assert.deepEqual(resolveWaitToolConfig(undefined,{}),{enabled:true});
});

test('wait-config takes defaultTimeoutMs from config',()=>{
 assert.deepEqual(resolveWaitToolConfig({defaultTimeoutMs:5000},{}),{enabled:true,defaultTimeoutMs:5000});
});

test('wait-config env defaultTimeoutMs wins over config',()=>{
 assert.deepEqual(
  resolveWaitToolConfig({defaultTimeoutMs:5000},{[WAIT_TOOL_DEFAULT_TIMEOUT_MS_ENV]:'7000'}),
  {enabled:true,defaultTimeoutMs:7000});
});

test('wait-config keeps enabled=false without a timeout',()=>{
 assert.deepEqual(resolveWaitToolConfig({enabled:false},{}),{enabled:false});
});
