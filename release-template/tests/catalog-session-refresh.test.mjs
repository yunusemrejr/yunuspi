import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('long active sessions refresh catalogs at turn boundaries with one bounded attempt per interval', async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'catalog-session-refresh-'));
  const savedEnv=Object.fromEntries(['PI_CODING_AGENT_DIR','PI_MODEL_RESEARCH','PI_OFFLINE','PI_SUBAGENT_CHILD'].map(key=>[key,process.env[key]]));
  const originalNow=Date.now,originalFetch=globalThis.fetch;
  let now=1_800_000_000_000;Date.now=()=>now;
  process.env.PI_CODING_AGENT_DIR=directory;process.env.PI_MODEL_RESEARCH='off';delete process.env.PI_OFFLINE;delete process.env.PI_SUBAGENT_CHILD;
  globalThis.fetch=async()=>{throw new Error('Refresh hooks delegate to the native registry only');};
  try {
    await fs.writeFile(path.join(directory,'models.json'),'{}');
    const {default:register}=await import('../agent/extensions/live-models.ts');
    const hooks={},refreshes=[];
    await register({registerProvider(){},registerCommand(){},on:(name,handler)=>hooks[name]=handler});
    let pendingResolve;
    const ctx={hasUI:false,model:{provider:'deepseek'},modelRegistry:{getAvailable:()=>[{provider:'openai-codex'}],refresh:options=>{refreshes.push(options);return new Promise(resolve=>{pendingResolve=resolve;});}}};
    const settle=async()=>{pendingResolve?.({errors:new Map()});await new Promise(resolve=>setImmediate(resolve));};
    hooks.session_start({},ctx);assert.equal(refreshes.length,1);
    now+=15*60_000;hooks.turn_end({},ctx);assert.equal(refreshes.length,1,'startup refresh owns the same single-flight slot');await settle();
    hooks.turn_end({},ctx);assert.equal(refreshes.length,2);
    assert.ok(refreshes[1].providers.includes('deepseek'));assert.ok(refreshes[1].providers.includes('openai-codex'));
    now+=15*60_000;hooks.turn_end({},ctx);hooks.before_agent_start({},ctx);assert.equal(refreshes.length,2,'pending refresh stays single-flight even across another interval');
    await settle();hooks.turn_end({},ctx);assert.equal(refreshes.length,3);await settle();
    const count=refreshes.length;
    process.env.PI_OFFLINE='1';now+=15*60_000;hooks.turn_end({},ctx);assert.equal(refreshes.length,count);
    delete process.env.PI_OFFLINE;process.env.PI_SUBAGENT_CHILD='1';hooks.turn_end({},ctx);assert.equal(refreshes.length,count);delete process.env.PI_SUBAGENT_CHILD;
    ctx.modelRegistry.refresh=async options=>{refreshes.push(options);throw new Error('synthetic registry failure');};
    hooks.turn_end({},ctx);await new Promise(resolve=>setImmediate(resolve));assert.equal(refreshes.length,count+1);
    hooks.turn_end({},ctx);assert.equal(refreshes.length,count+1,'failure must not cause every-turn retries');
    now+=15*60_000;hooks.turn_end({},ctx);await new Promise(resolve=>setImmediate(resolve));assert.equal(refreshes.length,count+2,'later interval retries a failed refresh');
    hooks.session_shutdown({},ctx);assert.equal(refreshes.at(-1).signal.aborted,true);
  } finally {
    Date.now=originalNow;globalThis.fetch=originalFetch;
    for(const [key,value]of Object.entries(savedEnv))if(value===undefined)delete process.env[key];else process.env[key]=value;
    await fs.rm(directory,{recursive:true,force:true});
  }
});
