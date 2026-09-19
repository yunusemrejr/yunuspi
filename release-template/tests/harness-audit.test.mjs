import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agent = [path.join(root,"agent"),path.resolve(root,"..")]
  .find(dir=>fs.existsSync(path.join(dir,"extensions/lib/session-diagnostics.ts")));
const {collectSessionDiagnostics} = await import(pathToFileURL(path.join(agent,"extensions/lib/session-diagnostics.ts")));
const {default:sessionHooks} = await import(pathToFileURL(path.join(agent,"extensions/session-hooks.ts")));
const {runPool,parseSelection} = await import(pathToFileURL(path.join(agent,"scripts/lib/test-runner.mjs")));
const {buildSkillIndex,rankSkills} = await import(pathToFileURL(path.join(agent,"extensions/lib/skill-relevance.ts")));
const {SemanticIndex} = await import(pathToFileURL(path.join(agent,"extensions/pi-lens/semantic-radar/index.mjs")));
const {assertNoStaleCheckoutPaths} = await import(pathToFileURL(path.join(agent,"scripts/publish-public.mjs")));
const {createHookLedger} = await import(pathToFileURL(path.join(agent,"extensions/lib/hook-ledger.ts")));

test("fresh installations expose built-in search and economical child thinking",()=>{
  const settings=JSON.parse(fs.readFileSync(path.join(root,"config/settings.example.json"),"utf8"));
  assert.deepEqual(settings.defaultTools,["read","bash","edit","write","grep","find","ls"]);
  assert.equal(settings.subagents.defaultThinking,"low");
});

test("diagnostics distinguish model, tool, child and controller evidence",()=>{
  const entries=[
    {type:"message",message:{role:"assistant",stopReason:"error",errorMessage:"429 rate limit",content:[]}},
    {type:"message",message:{role:"toolResult",toolName:"bash",toolCallId:"one",isError:true,content:[{type:"text",text:"Blocked: outside workspace"}]}},
    {type:"custom",customType:"subagent-lifecycle-v1",data:{runId:"child",results:[{exitCode:1,error:"acceptance failed"}]}},
    {type:"custom",customType:"subagent-lifecycle-v1",data:{runId:"flow",mode:"workflow",state:"failed",results:[]}},
  ];
  const report=collectSessionDiagnostics(entries,{excerpts:false});
  assert.deepEqual(new Set(report.failures.map(f=>f.kind)),new Set(["model","tool","child","workflow"]));
  assert.equal(report.activity.childFailures,1);
  assert.ok(report.failures.every(f=>!("error" in f)));
  const bounded=collectSessionDiagnostics(Array(3000).fill(entries[1]));
  assert.equal(bounded.inspected,2000);assert.equal(bounded.count,1);assert.equal(bounded.truncated,true);
});

test("concurrent hook results emit once and optional telemetry cannot break tools",()=>{
  const handlers=new Map();
  sessionHooks({on:(name,fn)=>handlers.set(name,[...(handlers.get(name)??[]),fn])});
  const fire=(name,event)=>{let result;for(const fn of handlers.get(name)??[])result=fn(event)??result;return result;};
  for(const id of ["a","b"])fire("tool_call",{toolCallId:id,toolName:"web_search"});
  const sink=Symbol.for("yunus-pi.health.v1"), before=globalThis[sink];
  globalThis[sink]=()=>{throw Error("fixture sink failure");};
  try {
    assert.ok(fire("tool_result",{toolCallId:"b",toolName:"web_search",content:[]}));
    assert.equal(fire("tool_result",{toolCallId:"a",toolName:"web_search",content:[]}),undefined);
    fire("tool_call",{toolCallId:"late",toolName:"render_see"});fire("session_switch",{});
    assert.equal(fire("tool_result",{toolCallId:"late",toolName:"render_see",content:[]}),undefined);
    fire("tool_call",{toolCallId:"child",toolName:"subagent"});
    assert.match(fire("tool_result",{toolCallId:"child",toolName:"subagent",isError:true,content:[]}).content[0].text,/successful siblings/);
  }finally{if(before===undefined)delete globalThis[sink];else globalThis[sink]=before;}
});

test("hook ledger eviction removes stale indexes with the bounded dispatch window",()=>{
  const ledger=createHookLedger({maxDispatches:1,maxRows:4});
  ledger.record({owner:"old",hook:"tool_call",eventId:"old-call"});
  ledger.record({owner:"new",hook:"tool_call",eventId:"new-call"});
  const snapshot=ledger.snapshot();
  assert.equal(snapshot.dispatches,1);
  assert.equal(snapshot.records,2);
  assert.equal(snapshot.expectedPairs,1);
  assert.equal(snapshot.duplicated.some(row=>row.eventId==="old-call"),false);
});

test("hook ledger eviction preserves duplicate counts inside retained dispatches",()=>{
  const ledger=createHookLedger({maxDispatches:1,maxRows:1});
  ledger.record({owner:"old",hook:"tool_call",eventId:"evicted"});
  ledger.record({owner:"same",hook:"tool_call",eventId:"kept"});
  ledger.record({owner:"same",hook:"tool_call",eventId:"kept"});
  const snapshot=ledger.snapshot();
  assert.equal(snapshot.duplicated[0]?.eventId,"kept");
  assert.equal(snapshot.duplicated[0]?.count,2);
});

test("offline scheduler keeps explicit bounds and input ordering",async()=>{
  let active=0,peak=0;
  const results=await runPool([3,1,2],2,async value=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,value*5));active--;return value;});
  assert.equal(peak,2);assert.deepEqual(results,[3,1,2]);
  assert.equal(parseSelection([], ["one"]).jobs,1);
  assert.throws(()=>parseSelection(["--jobs","99"],["one"]));
  const suites=["bench/quality-review.mjs","tests/quality-review.test.mjs","bench/provider.mjs"];
  const listing=parseSelection(["--match","quality","--test",suites[0],"--list"],suites);
  assert.equal(listing.list,true);
  assert.deepEqual(listing.selected,suites.slice(0,2));
  assert.deepEqual(parseSelection([], ["one","one"]).selected,["one"]);
  for(const query of ["absent",".*",""]) assert.throws(()=>parseSelection(["--match",query],suites));
});

test("fuzzy skill retrieval needs two distinct concepts",()=>{
  const skills=[{name:"orbital-mechanics",file:"/fixture/orbital/SKILL.md",description:"orbital ephemeris propagation integrator"},
    ...Array.from({length:5},(_,i)=>({name:`generic-${i}`,file:`/fixture/${i}/SKILL.md`,description:"workflow evidence checks"}))];
  const index=buildSkillIndex(skills);
  assert.equal(rankSkills(index,"orbitl ephemeri")[0]?.skill.name,"orbital-mechanics");
  assert.equal(rankSkills(index,"ephemeris ephemeri").length,0);
  assert.equal(rankSkills(index,"workflow evidence checks").length,0);
});

test("corrupt semantic cache entries become rebuildable instead of trusted",async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),"pi-public-index-"));
  try{
    fs.writeFileSync(path.join(temp,"semantic-radar-index.json"),JSON.stringify({version:5,files:{
      "damaged.ts":{contentHash:"unchanged",mtimeMs:1,statKey:"unchanged",funcs:[{id:"broken",sig:[1]}]},
    }}));
    const index=await SemanticIndex.load(temp);
    assert.equal(index.files["damaged.ts"],undefined);
    assert.deepEqual(index.query({sig:[1]}),[]);
    assert.equal(index.upsertFile("damaged.ts","unchanged",1,[],"unchanged"),true);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});

test("publication cannot silently retain files removed from the export",()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),"pi-public-stale-"));
  try{
    const source=path.join(temp,"export"),checkout=path.join(temp,"checkout");
    fs.mkdirSync(source);fs.mkdirSync(path.join(checkout,".git"),{recursive:true});
    assert.doesNotThrow(()=>assertNoStaleCheckoutPaths(source,checkout));
    fs.writeFileSync(path.join(checkout,"retired.txt"),"old");
    assert.throws(()=>assertNoStaleCheckoutPaths(source,checkout),/retired.txt/);
    assert.equal(fs.readFileSync(path.join(checkout,"retired.txt"),"utf8"),"old");
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
