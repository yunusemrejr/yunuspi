import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve(import.meta.dirname,'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/lib/skill-discovery-controller.ts')));
const {createSkillDiscoveryController}=await import(pathToFileURL(path.join(agent,'extensions/lib/skill-discovery-controller.ts')));
const RUNNER=Symbol.for('yunus-pi.skill-discovery-runner.v1');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const skills=[{name:'layout-design',file:'/skills/layout/SKILL.md',description:'Responsive stylesheet and visual hierarchy'}];
function fixture() {
 const offers=[],calls=[];let resolve;
 const previous=globalThis[RUNNER],offline=process.env.PI_OFFLINE;delete process.env.PI_OFFLINE;
 globalThis[RUNNER]=(request,ctx,signal)=>{calls.push({request,signal});return new Promise(r=>resolve=r);};
 const controller=createSkillDiscoveryController({catalog:()=>skills,covered:()=>false,enabled:()=>true,offer:(...args)=>offers.push(args)});
 const start=()=>controller.start({prompt:'Make this fit better'},{cwd:'/project'});
 const observe=(name,file)=>controller.observe({toolName:name,input:{path:file},content:[{type:'text',text:'SECRET BODY MUST NOT ENTER DISCOVERY'}]});
 start();
 return {controller,offers,calls,start,observe,finish:()=>resolve(JSON.stringify({suggestions:[{name:'layout-design',reason:'Observed stylesheet layout needs responsive design.'}]})),cleanup(){controller.cancel();if(previous===undefined)delete globalThis[RUNNER];else globalThis[RUNNER]=previous;if(offline===undefined)delete process.env.PI_OFFLINE;else process.env.PI_OFFLINE=offline;}};
}
test('discovery uses distinct observations once, excludes bodies and stays advisory',async()=>{
 const f=fixture();try {
  f.observe('read','ui/world.css');f.observe('read','ui/world.css');await tick();assert.equal(f.calls.length,0);
  f.observe('read','ui/index.html');await tick();assert.equal(f.calls.length,1);
  assert.match(f.calls[0].request.brief,/world.css/);assert.doesNotMatch(f.calls[0].request.brief,/SECRET BODY/);
  f.finish();await tick();assert.equal(f.offers.length,1);
  f.observe('edit','ui/world.css');await tick();assert.equal(f.calls.length,1);
  f.start();f.observe('read','ui/world.css');f.observe('read','ui/index.html');await tick();assert.equal(f.calls.length,1,'identical discovery is cached');
 }finally{f.cleanup();}
});
test('new input cancels and discards late results',async()=>{
 const f=fixture();try{f.observe('read','one.css');f.observe('read','two.html');await tick();f.start();assert.equal(f.calls[0].signal.aborted,true);f.finish();await tick();assert.equal(f.offers.length,0);}finally{f.cleanup();}
});
test('offline, failed results and skill reads never launch discovery',async()=>{
 const f=fixture();try {
  f.observe('read','/skills/layout/SKILL.md');f.observe('read','/skills/other/SKILL.md');await tick();assert.equal(f.calls.length,0);
  f.controller.observe({toolName:'read',input:{path:'one.css'},isError:true});await tick();assert.equal(f.calls.length,0);
  process.env.PI_OFFLINE='1';f.observe('read','one.css');f.observe('read','two.html');await tick();assert.equal(f.calls.length,0);
 }finally{f.cleanup();}
});

test('native browser actions discover workflows without copying page content or URLs',async()=>{
 const f=fixture();try {
  for(const action of ['navigate','snapshot']) f.controller.observe({toolName:'browser',input:{action,url:'https://private.invalid'},content:[{type:'text',text:'PRIVATE PAGE CONTENT'}]});
  await tick();assert.equal(f.calls.length,1);assert.match(f.calls[0].request.brief,/browser interaction/);assert.doesNotMatch(f.calls[0].request.brief,/private.invalid|PRIVATE PAGE/);
  f.finish();await tick();
 }finally{f.cleanup();}
});
