import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const template=path.resolve(import.meta.dirname,'..');
const agent=[path.join(template,'agent'),path.resolve(template,'..')].find(p=>fs.existsSync(path.join(p,'extensions/lib/tool-discovery.ts')));
const {registerToolDiscovery}=await import(pathToFileURL(path.join(agent,'extensions/lib/tool-discovery.ts')));
function fixture() {
 const hooks={},entries=[],defs=new Map();let active=['read','bash','subagent','quality_review','session_self','project_report','browser_session','http_request','bg_run'],executed=0;
 const catalog=active.map(name=>({name,description:name==='browser_session'?'Browser navigation screenshot interaction':name.replaceAll('_',' '),parameters:{type:'object',properties:{}}}));
 const ctx={cwd:'/workspace',sessionManager:{getSessionId:()=> 'session-a',getBranch:()=>entries}};
 const api={on:(name,fn)=>{hooks[name]=fn;},getAllTools:()=>catalog,getActiveTools:()=>active,setActiveTools:names=>{active=names;},appendEntry:(customType,data)=>entries.push({type:'custom',customType,data}),registerTool:def=>{defs.set(def.name,def);catalog.push(def);active.push(def.name);},executeTool:()=>{executed++;}};
 registerToolDiscovery(api);hooks.session_start?.({},ctx);
 return {hooks,entries,defs,api,ctx,active:()=>active,executed:()=>executed,call:input=>defs.get('tool_search').execute('id',input,undefined,undefined,ctx)};
}
test('startup retains essential operations and loads specialized schemas only on discovery',async()=>{
 const f=fixture();
 assert.ok(f.active().includes('subagent')&&f.active().includes('quality_review'));
 assert.ok(!f.active().includes('browser_session'));
 const result=await f.call({query:'browser screenshot',limit:1});
 assert.deepEqual(result.details.tools.map(t=>t.name),['browser_session']);
 assert.ok(f.active().includes('browser_session'));
 assert.equal(f.executed(),0);
 assert.equal(f.entries.length,1);
 await f.call({names:['browser_session']});assert.equal(f.entries.length,1,'repeat discovery adds no receipts');
});
test('unknown names cannot broaden authority, and external selection changes are respected',async()=>{
 const f=fixture();const before=f.active().slice();
 assert.equal((await f.call({names:['not_registered','http_request']})).isError,true);
 assert.deepEqual(f.active(),before);
 f.api.setActiveTools(['read','tool_search']);
 assert.equal((await f.call({names:['http_request']})).isError,true);
 assert.deepEqual(f.active(),['read','tool_search']);
});
test('activation receipts restore on resume and separate session switches retain discovery',async()=>{
 const f=fixture();await f.call({names:['http_request']});
 f.hooks.session_start({},f.ctx);assert.ok(f.active().includes('http_request'));
 const other={...f.ctx,sessionManager:{getSessionId:()=> 'session-b',getBranch:()=>[]}};
 f.hooks.session_switch({},other);assert.ok(!f.active().includes('http_request'));
 const result=await f.defs.get('tool_search').execute('id',{names:['http_request']},undefined,undefined,other);
 assert.equal(result.isError,undefined);assert.ok(f.active().includes('http_request'),'switch does not lose original hidden catalog');
});
test('child sessions and explicit opt-out preserve their original tool selection',()=>{
 const oldChild=process.env.PI_SUBAGENT_CHILD,oldMode=process.env.PI_TOOL_DISCOVERY;
 try {
  process.env.PI_SUBAGENT_CHILD='1';let f=fixture();assert.ok(f.active().includes('browser_session'));assert.equal(f.defs.size,0);
  delete process.env.PI_SUBAGENT_CHILD;process.env.PI_TOOL_DISCOVERY='off';f=fixture();assert.ok(f.active().includes('browser_session'));assert.equal(f.defs.size,0);
 }finally{if(oldChild===undefined)delete process.env.PI_SUBAGENT_CHILD;else process.env.PI_SUBAGENT_CHILD=oldChild;if(oldMode===undefined)delete process.env.PI_TOOL_DISCOVERY;else process.env.PI_TOOL_DISCOVERY=oldMode;}
});
test('skill projection removes only the configured SDK catalog and keeps user instructions',async()=>{
 const {compactSkillCatalog}=await import(pathToFileURL(path.join(agent,'extensions/lib/tool-discovery.ts')));
 const skill={name:'voxel-art',description:'Compose voxel scenes',filePath:'/skills/voxel-art/SKILL.md'};
 const block='<available_skills>\n  <skill>\n    <name>voxel-art</name>\n    <description>Compose voxel scenes</description>\n    <location>/skills/voxel-art/SKILL.md</location>\n  </skill>\n</available_skills>';
 const event={systemPrompt:'Keep the user requirement.\n'+block+'\nPreserve project conventions.',systemPromptOptions:{skills:[skill]}};
 const projected=compactSkillCatalog(event,['skill_review']);
 assert.ok(projected.startsWith('Keep the user requirement.')&&projected.endsWith('Preserve project conventions.'));
 assert.ok(projected.includes('action:"search"'));
 assert.ok(!projected.includes('<available_skills>'));
 assert.equal(compactSkillCatalog(event,['read']),undefined,'no projection when discovery is unavailable');
 assert.equal(compactSkillCatalog({...event,systemPromptOptions:{skills:[{...skill,description:'Different registered evidence'}]}},['skill_review']),undefined,'custom catalogs are not rewritten');
 assert.equal(compactSkillCatalog({...event,systemPrompt:event.systemPrompt+'\n'+block},['skill_review']),undefined,'ambiguous duplicates are preserved');
});
