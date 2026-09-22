import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/lib/session-cost.ts')));
const coreRoot=[path.join(root,'core'),path.join(agent,'runtime','core')].find(p=>fs.existsSync(path.join(p,'coding-agent','src','core','skills.js')));
assert.ok(coreRoot,'owned core with coding-agent/src/core/skills.js not found');
const {loadSkills}=await import(pathToFileURL(path.join(coreRoot,'coding-agent','src','core','skills.js')));
const skillMd=(name,extra='')=>`---\nname: ${name}\ndescription: Fixture skill for collision tests.\n---\n\n# ${name}\n${extra}\n`;
const stage=()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pi-skill-collision-'));
 const agentDir=path.join(tmp,'agent'),extra=path.join(tmp,'extra');
 fs.mkdirSync(path.join(agentDir,'skills','dup'),{recursive:true});
 fs.mkdirSync(path.join(extra,'dup'),{recursive:true});
 return {tmp,agentDir,extra};
};
const collisions=result=>result.diagnostics.filter(d=>d.type==='collision');

test('byte-identical skill directories across load paths report no collision',()=>{
 const {agentDir,extra}=stage();
 fs.writeFileSync(path.join(agentDir,'skills','dup','SKILL.md'),skillMd('dup'));
 fs.writeFileSync(path.join(extra,'dup','SKILL.md'),skillMd('dup'));
 const result=loadSkills({agentDir,skillPaths:[extra],includeDefaults:true,cwd:agentDir});
 assert.equal(result.skills.filter(s=>s.name==='dup').length,1);
 assert.deepEqual(collisions(result),[]);
 assert.ok(result.skills.find(s=>s.name==='dup').filePath.startsWith(agentDir),'agent copy wins');
});

test('divergent skill bodies still report a collision',()=>{
 const {agentDir,extra}=stage();
 fs.writeFileSync(path.join(agentDir,'skills','dup','SKILL.md'),skillMd('dup'));
 fs.writeFileSync(path.join(extra,'dup','SKILL.md'),skillMd('dup','Extra loser-only guidance.'));
 const result=loadSkills({agentDir,skillPaths:[extra],includeDefaults:true,cwd:agentDir});
 const hit=collisions(result);
 assert.equal(hit.length,1);
 assert.equal(hit[0].collision.name,'dup');
 assert.ok(hit[0].collision.winnerPath.startsWith(agentDir));
 assert.ok(hit[0].collision.loserPath.startsWith(extra));
});

test('extra files on one side still report a collision',()=>{
 const {agentDir,extra}=stage();
 fs.writeFileSync(path.join(agentDir,'skills','dup','SKILL.md'),skillMd('dup'));
 fs.writeFileSync(path.join(extra,'dup','SKILL.md'),skillMd('dup'));
 fs.mkdirSync(path.join(extra,'dup','references'),{recursive:true});
 fs.writeFileSync(path.join(extra,'dup','references','note.md'),'loser-only reference');
 const result=loadSkills({agentDir,skillPaths:[extra],includeDefaults:true,cwd:agentDir});
 assert.equal(collisions(result).length,1);
});
