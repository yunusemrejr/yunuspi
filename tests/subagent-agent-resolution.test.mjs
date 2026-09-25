import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {register} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const rootDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const agent=[path.join(rootDir,'agent'),path.resolve(rootDir,'..')].find(p=>fs.existsSync(path.join(p,'extensions/pi-subagents/src/agents/agents.ts')));
register('data:text/javascript,'+encodeURIComponent(`import fs from 'node:fs';export function resolve(n,c,next){if(n.startsWith('.')&&n.endsWith('.js')){const u=new URL(n.slice(0,-3)+'.ts',c.parentURL);if(fs.existsSync(u))return next(u.href,c);}return next(n,c);}`),import.meta.url);
const {resolveAgentName,suggestAgentNames,formatUnknownAgentError}=await import(pathToFileURL(path.join(agent,'extensions/pi-subagents/src/agents/agents.ts')).href);
const {parseFrontmatter,parseFrontmatterList}=await import(pathToFileURL(path.join(agent,'extensions/pi-subagents/src/agents/frontmatter.ts')).href);
const cfg=(name,extra={})=>({name,description:'test',systemPromptMode:'append',inheritProjectContext:false,inheritGlobalContext:false,inheritSkills:false,systemPrompt:'',source:'builtin',filePath:`${name}.md`,...extra});

test('shipped delegate builtin answers to generic, exact names still win',()=>{
 const raw=fs.readFileSync(path.join(agent,'extensions/pi-subagents/agents/delegate.md'),'utf8');
 const {frontmatter}=parseFrontmatter(raw);
 assert.ok((parseFrontmatterList(frontmatter.aliases)??[]).includes('generic'),'delegate.md must keep the generic alias');
 const delegate=cfg('delegate',{aliases:['generic'],source:'builtin'});
 assert.equal(resolveAgentName('generic',[delegate]).agent?.name,'delegate');
 const userGeneric=cfg('generic',{source:'user'});
 assert.equal(resolveAgentName('generic',[delegate,userGeneric]).agent?.source,'user','an exact user name beats the builtin alias');
});

test('agent resolution tolerates case but not case-only ambiguity',()=>{
 assert.equal(resolveAgentName('CRITIC',[cfg('critic')]).agent?.name,'critic');
 assert.equal(resolveAgentName('Generic',[cfg('delegate',{aliases:['generic']})]).agent?.name,'delegate');
 assert.equal(resolveAgentName('critic',[cfg('Critic'),cfg('critic')]).agent?.name,'critic','exact still wins');
 const clash=resolveAgentName('CRITIC',[cfg('Critic'),cfg('critic')]);
 assert.match(clash.error??'',/Ambiguous agent name/);
});

test('unknown agent names get ranked suggestions, never a guess',()=>{
 const agents=[cfg('delegate',{aliases:['generic']}),cfg('critic'),cfg('researcher')];
 assert.deepEqual(suggestAgentNames('delgate',agents),['delegate']);
 assert.deepEqual(suggestAgentNames('edlegate',agents),['delegate'],'single transposition');
 assert.deepEqual(suggestAgentNames('crit',agents),['critic'],'substring');
 assert.deepEqual(suggestAgentNames('genric',agents),['delegate'],'close to the generic alias');
 assert.deepEqual(suggestAgentNames('zzzqqq',agents),[]);
 assert.deepEqual(suggestAgentNames('x',agents),[]);
});

test('unknown agent error leads with recovery and caps huge catalogs',()=>{
 const many=Array.from({length:50},(_,i)=>cfg(`agent-${String(i).padStart(2,'0')}`));
 const context={cwd:'/tmp/proj',scope:'both',directories:[],agents:many};
 const typoCtx={cwd:'/tmp/proj',scope:'both',directories:[],agents:[cfg('delegate'),cfg('critic')]};
 const typo=formatUnknownAgentError('delgate',typoCtx);
 assert.match(typo,/Unknown agent: delgate\nDid you mean 'delegate'\?/);
 const capped=formatUnknownAgentError('zzzqqq',context);
 assert.match(capped,/No close match; use subagent\({ action: "list" }\)/);
 assert.match(capped,/\.\.\. and 10 more; use subagent\({ action: "list" }\) for the full list/);
 assert.equal(capped.split('\n').filter(line=>line.startsWith('- agent-')).length,40);
});
