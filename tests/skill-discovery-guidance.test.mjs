import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
let agent=path.resolve(import.meta.dirname,'../agent');
if(!fs.existsSync(agent))agent=path.resolve(import.meta.dirname,'../..');
const {createRelevantGuidance}=await import(pathToFileURL(path.join(agent,'extensions/lib/relevant-guidance.ts')));
const RUNNER=Symbol.for('yunus-pi.skill-discovery-runner.v1');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(optIn=true){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'skill-guidance-'));const file=path.join(dir,'skills/spatial/SKILL.md');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'# Spatial balance\nCompare composition proportions.\n');
 const envKeys=['PI_OFFLINE','PI_SUBAGENT_CHILD','PI_SKILL_DISCOVERY','PI_RELEVANT_GUIDANCE','PI_SKILL_REVIEW'];const env=new Map(envKeys.map(key=>[key,process.env[key]]));for(const key of envKeys)delete process.env[key];if(optIn)process.env.PI_SKILL_DISCOVERY='on';
 const previous=globalThis[RUNNER],calls=[],entries=[],hooks={},registered={};let wake=0;
 globalThis[RUNNER]=(request,ctx,signal)=>new Promise(resolve=>calls.push({request,signal,resolve}));
 const api={getActiveTools:()=>['read','edit','subagent','skill_review'],on(name,fn){hooks[name]=fn;},registerTool(tool){registered[tool.name]=tool;},appendEntry(customType,data){entries.push({type:'custom',customType,data});},sendMessage(){wake++;},sendUserMessage(){wake++;}};
 const g=createRelevantGuidance(api);const ctx={cwd:dir,sessionManager:{getEntries:()=>entries,getBranch:()=>entries}};g.restore(ctx);
 const catalog='<available_skills><skill><name>spatial-balance</name><description>Composition proportions hierarchy</description><location>'+file+'</location></skill></available_skills>';
 const start=(prompt='Make this fit better',systemPrompt=catalog)=>g.start({prompt,systemPrompt},ctx);
 const read=(relative)=>g.record({toolName:'read',input:{path:relative},isError:false,content:[{type:'text',text:relative===file?fs.readFileSync(file,'utf8'):'SECRET SOURCE BODY'}]});
 const observe=()=>{read('ui/world.css');read('ui/index.html');};
 const finish=()=>calls.at(-1).resolve(JSON.stringify({suggestions:[{name:'spatial-balance',reason:'Observed styles and markup need composition proportion checks.'}]}));
 start();return {g,ctx,file,calls,hooks,registered,start,read,observe,finish,wakes:()=>wake,cleanup(){hooks.agent_end?.();if(previous===undefined)delete globalThis[RUNNER];else globalThis[RUNNER]=previous;for(const [key,value]of env)if(value===undefined)delete process.env[key];else process.env[key]=value;fs.rmSync(dir,{recursive:true,force:true});}};
}
test('actual guidance delivers async advice through bounded candidates, without wakes or new review requirements',async()=>{
 const f=fixture();try{
  f.observe();assert.equal(f.calls.length,0,'observation does not synchronously dispatch or wait for inference');await tick();assert.equal(f.calls.length,1);
  assert.match(f.calls[0].request.brief,/stylesheet responsive browser interface/);assert.doesNotMatch(f.calls[0].request.brief,/SECRET SOURCE BODY/);
  assert.equal(f.g.candidates().some(h=>h.skill===f.file),false,'stalled inference leaves ordinary work available');
  f.finish();await tick();const candidates=f.g.candidates();const workflow=candidates.find(h=>h.discovery==='workflow');
  assert.ok(workflow?.text.includes(f.file),'advice retains a directly readable catalog path');
  assert.match(workflow.text,/Observed styles and markup need composition proportion checks/,'task-specific discovery evidence survives delivery');
  assert.match(workflow.text,/optional|if useful/i);assert.ok(workflow.text.length<800);assert.ok(candidates.length<=2);assert.equal(f.wakes(),0);
  assert.equal(f.g.beforeToolCall({toolName:'edit',input:{path:'ui/world.css'}}),undefined);
  const status=await f.registered.skill_review.execute('inspect',{action:'inspect'});assert.equal(status.details.skills.length,0,'advisory suggestion is not a mandatory review target');
  f.g.commit(candidates);assert.equal(f.g.candidates().some(h=>h.discovery==='workflow'),false,'delivered suggestion does not repeat');
 }finally{f.cleanup();}
});
test('no skills, no tools and explicit discovery off prevent dispatch',async()=>{
 for(const prompt of ['No skills. Make this fit better.','No tools. Make this fit better.']){const f=fixture();try{f.start(prompt);f.observe();await tick();assert.equal(f.calls.length,0,prompt);}finally{f.cleanup();}}
 const f=fixture();try{process.env.PI_SKILL_DISCOVERY='off';f.observe();await tick();assert.equal(f.calls.length,0);}finally{f.cleanup();}
});
test('pending advice is discarded after optout, native skill read, catalog replacement or new input',async()=>{
 for(const change of ['optout','covered','catalog','input']){const f=fixture();try{
  f.observe();await tick();assert.equal(f.calls.length,1);
  if(change==='optout')process.env.PI_SKILL_DISCOVERY='off';
  if(change==='covered')f.read(f.file);
  if(change==='catalog')f.start('Make this fit better','<available_skills></available_skills>');
  if(change==='input')f.g.userInput();
  f.finish();await tick();assert.equal(f.g.candidates().some(h=>h.discovery==='workflow'),false,change);assert.equal(f.wakes(),0);
 }finally{f.cleanup();}}
});

test('default advisory discovery uses one bounded background request without waking or gating work',async()=>{
 const f=fixture(false);try{
  f.read('ui/world.css');await tick();assert.equal(f.calls.length,0,'one observation is insufficient');
  f.read('ui/index.html');await tick();assert.equal(f.calls.length,1,'discovery is enabled without an opt-in environment variable');
  assert.equal(f.g.beforeToolCall({toolName:'edit',input:{path:'ui/world.css'}}),undefined,'discovery never gates normal work');
  f.finish();await tick();f.observe();await tick();assert.equal(f.calls.length,1,'additional observations do not launch repeated helper requests');
  assert.equal(f.wakes(),0);
 }finally{f.cleanup();}
});
