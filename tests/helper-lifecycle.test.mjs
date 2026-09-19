import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
const agent = [path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/micro-intelligence.ts')));
const { default: register, lastMicroRequest, microRequestAdvice } = await import(pathToFileURL(path.join(agent,'extensions/micro-intelligence.ts')));
const { buildInterpBrief, parseInterpRead } = await import(pathToFileURL(path.join(agent,'extensions/lib/prompt-interpretation.ts')));
const { searchCapabilityMetadata } = await import(pathToFileURL(path.join(agent,'extensions/lib/capability-groups.ts')));
const { collectSessionMetrics } = await import(pathToFileURL(path.join(agent,'extensions/lib/session-metrics.ts')));
const tick = () => new Promise(resolve=>setImmediate(resolve));
const prompt = 'Implement robust API contracts and transaction validation for the payment handler.';
function fixture() {
 const hooks = new Map(), classifications=[], calls=[];
 register({on:(event,fn)=>hooks.set(event,fn),registerTool(){}},{
  warmup(){},
  classify:()=>new Promise(resolve=>classifications.push(resolve)),
  ask:(_site,_state,_questions,opts)=>new Promise(resolve=>calls.push({signal:opts.signal,resolve})),
 });
 return {classifications,calls,emit:(name,event={})=>hooks.get(name)?.(event)};
}
const unavailable = {ok:false,reason:'unavailable'};
const advisory = {ok:true,answers:{multiPerspective:{noul:.9},perspective:{probabilities:{security:.7,testing:.3}}},usage:{inputTokens:1,cached:false}};

test('superseded request classification cannot launch paid work or modify the new session', async()=>{
 const f=fixture();
 f.emit('before_agent_start',{prompt});
 f.emit('input');
 f.classifications[0](unavailable);
 await tick();
 assert.equal(f.calls.length,0);
 assert.equal(lastMicroRequest(),undefined);
 f.emit('before_agent_start',{prompt});
 f.classifications[1](unavailable);
 await tick();
 assert.equal(f.calls.length,1);
 f.emit('session_before_switch');
 assert.equal(f.calls[0].signal.aborted,true);
 f.calls[0].resolve(advisory);
 await tick();
 assert.equal(lastMicroRequest(),undefined);
});

test('completed advice is exact-request scoped, inspectable at idle, and cleared on branching', async()=>{
 const f=fixture();
 f.emit('before_agent_start',{prompt});
 assert.equal(lastMicroRequest().family,'implementation');
 f.classifications[0](unavailable);
 await tick();
 f.calls[0].resolve(advisory);
 await tick();
 assert.deepEqual(microRequestAdvice(prompt).perspectives,['security','testing']);
 assert.equal(microRequestAdvice(prompt+' also deploy'),undefined);
 f.emit('agent_end');
 assert.equal(lastMicroRequest().advisoryPending,false);
 assert.ok(microRequestAdvice(prompt));
 f.emit('session_before_tree');
 assert.equal(lastMicroRequest(),undefined);
});

test('interpretation keeps tail constraints and rejects quoted or contradictory verdicts',()=>{
 const brief=buildInterpBrief('Do the existing work. '+ 'Context. '.repeat(600)+'Also update the tests; do not deploy.','Earlier user direction');
 assert.match(brief,/do not deploy/);
 assert.match(brief,/middle omitted/);
 assert.deepEqual(parseInterpRead('READ: additive\nWHY: The request says also.'),{read:'additive',why:'The request says also.'});
 assert.equal(parseInterpRead('Example: READ: redirect\nWHY: quoted instructions'),undefined);
 assert.equal(parseInterpRead('READ: redirect\nREAD: additive\nWHY: ambiguous'),undefined);
});

test('discovery recovers a long typo without confusing short domain words or exact names',()=>{
 const tools=[{name:'browser_session',description:'Browser screenshot navigation'},{name:'keyboard',description:'keyboard input'},{name:'capital',description:'capital markets'},{name:'api_probe',description:'API requests'}];
 assert.equal(searchCapabilityMetadata(tools,'screenshto')[0]?.name,'browser_session');
 assert.deepEqual(searchCapabilityMetadata(tools,'api').map(t=>t.name),['api_probe']);
 assert.deepEqual(searchCapabilityMetadata(tools,'board'),[]);
 assert.equal(searchCapabilityMetadata(tools,'browser_session')[0].name,'browser_session');
});

test('powers include readable names beside the emoji and count',()=>{
 const m=collectSessionMetrics([{type:'message',message:{role:'toolResult',toolCallId:'one',toolName:'tool_search',content:[]}}]);
 assert.ok(m.footer.some(line=>line.includes('🧰 Tools 1')));
});
