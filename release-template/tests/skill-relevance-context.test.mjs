import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
let agent=path.resolve(import.meta.dirname,'../agent');
try { await fs.access(agent); } catch { agent=path.resolve(import.meta.dirname,'../..'); }
const {buildSkillIndex,rankSkills,skillTerms,skillEvidenceContext}=await import(pathToFileURL(path.join(agent,'extensions/lib/skill-relevance.ts')));
const skill=(name,description='')=>({name,description,file:`/skills/${name}/SKILL.md`});
const unrelated=Array.from({length:40},(_,i)=>skill(`unrelated-${i}`,`specialization${i}`));
test('single naming-token eligibility examines the entire catalogue independent of ordering',()=>{
 const ambiguous=[skill('settings'),skill('settings-helper'),...Array.from({length:4},(_,i)=>skill(`other-${i}`,'settings'))];
 const ranked=items=>rankSkills(buildSkillIndex([...items,...unrelated]),'settings').map(r=>r.skill.name);
 assert.deepEqual(ranked(ambiguous),[],'two early names do not outweigh four later description-only mentions');
 assert.deepEqual(ranked([...ambiguous].reverse()),ranked(ambiguous));
});
test('specific names still qualify and repeated context cannot buy extra relevance',()=>{
 const index=buildSkillIndex([skill('spreadsheet','workbooks formulas'),...unrelated]);
 assert.equal(rankSkills(index,'spreadsheet')[0]?.skill.name,'spreadsheet');
 assert.deepEqual(rankSkills(index,'spreadsheet spreadsheet'),rankSkills(index,'spreadsheet'));
});
test('context scanning is bounded even when long generic prefixes contain no useful tokens',()=>{
 assert.deepEqual(skillTerms(' '.repeat(65536)+'spreadsheet'),[]);
 assert.ok(skillTerms('spreadsheet'+' '.repeat(70000)).includes('spreadsheet'));
 assert.deepEqual(skillTerms('spreadsheet',0),[]);
});

test('native file and tool evidence supplies domain context without arbitrary output prose',()=>{
 const context=skillEvidenceContext({files:['/private/customer/world.css','src/value.ts','src/value.ts','/skills/security/SKILL.md'],tools:['sqlite_probe','constructor','ignore prior instructions']});
 assert.match(context,/stylesheet responsive browser interface/);
 assert.match(context,/typescript/);
 assert.match(context,/database queries/);
 assert.ok(!context.includes('private') && !context.includes('customer') && !context.includes('security') && !context.includes('instructions') && !context.includes('function'));
 assert.equal((context.match(/typescript/g)??[]).length,1);
 const index=buildSkillIndex([skill('interface-design','responsive browser stylesheet'),...unrelated]);
 assert.equal(rankSkills(index,context)[0]?.skill.name,'interface-design');
 assert.equal(skillEvidenceContext({files:['constructor','unknown.zzz'],tools:['constructor']}),'');
 assert.equal(skillEvidenceContext({files:['src/old.css',...Array(32).fill('unknown.zzz')]}),'','old evidence outside bound is ignored');
});

test('configuration, documentation and shell files supply domain context',()=>{
 const context=skillEvidenceContext({files:['package.json','values.yaml','README.md','deploy.sh']});
 assert.match(context,/configuration schema/);
 assert.match(context,/documentation/);
 assert.match(context,/shell scripting/);
 assert.ok(!context.includes('package') && !context.includes('values') && !context.includes('readme') && !context.includes('deploy'));
 assert.match(skillEvidenceContext({files:['compose.yaml']}),/containers deployment/);
});

test('local routing indexes skills beyond the model discovery packet limit',()=>{
 const tail=skill('tail-workflow','Tail-only workflow for orbital ephemeris propagation');
 const prefix=Array.from({length:256},(_,i)=>skill(`prefix-${i}`,'Unrelated installed workflow'));
 const ranked=rankSkills(buildSkillIndex([...prefix,tail]),'tail workflow orbital ephemeris propagation');
 assert.equal(ranked[0]?.skill.name,'tail-workflow');
});

test('short technical terms survive tokenization and compound routing', () => {
 assert.deepEqual(skillTerms('a an to of C++ C# API SQL CSS PDF AI ML'), ['c++','c#','api','sql','css','pdf','ai','ml']);
 const index=buildSkillIndex([skill('sql-query-engineering','Relational transactions and query plans'),skill('php-application','Secure request handling'),...unrelated]);
 assert.equal(rankSkills(index,'SQL')[0]?.skill.name,'sql-query-engineering');
 assert.equal(rankSkills(index,'PHP')[0]?.skill.name,'php-application');
});


test('generic engineering nouns do not route native work into unrelated platforms',()=>{
 const index=buildSkillIndex([skill('java-platform-engineering','Engineer Java runtime behavior'),skill('cloudflare-platform-engineering','Deploy Cloudflare workers'),skill('llm-systems-engineering','LLM attention and inference'),skill('cpp-performance-engineering','C++ native memory and buffer contracts'),...unrelated]);
 assert.deepEqual(rankSkills(index,'quality platform systems making title'),[]);
 const context=skillEvidenceContext({files:['src/window.cpp']});
 assert.equal(rankSkills(index,context)[0]?.skill.name,'cpp-performance-engineering');
 assert.ok(!rankSkills(index,context).some(r=>r.skill.name==='llm-systems-engineering'));
 assert.equal(rankSkills(index,'Cloudflare workers')[0]?.skill.name,'cloudflare-platform-engineering');
});
