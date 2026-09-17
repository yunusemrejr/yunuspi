import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {skillRoutes, routeSkills} from '../../extensions/lib/skill-routing.ts';
import {createRelevantGuidance} from '../../extensions/lib/relevant-guidance.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
const cases=[
 ['search-discoverability','Audit SEO and structured data'],
 ['linux-host-defense','Harden the Ubuntu server firewall'],
 ['ubuntu-operations','Configure apt on Ubuntu'],
 ['web-component-patterns','Build an accessible web dialog'],
 ['web-ui-stack-selection','Choose a UI library and CDN setup'],
 ['php-application-engineering','Implement a PHP endpoint'],
 ['browser-javascript-engineering','Fix vanilla JavaScript stale updates'],
 ['python-software-engineering','Write a Python desktop tool'],
 ['node-runtime-engineering','Build a Node.js server'],
 ['c-systems-engineering','Implement this in C'],
 ['cpp-performance-engineering','Optimize this C++ renderer'],
 ['rust-systems-engineering','Review Rust FFI code'],
 ['go-service-engineering','Build a Go service'],
 ['java-platform-engineering','Fix a Java transaction'],
 ['x86-assembly-engineering','Optimize the x86-64 SIMD kernel'],
 ['fortran-scientific-computing','Review Fortran array handling'],
 ['dotnet-linux-engineering','Build a C# Linux application'],
 ['winecharm','Install WineCharm via flatpak'],
 ['windows-on-linux-engineering','Debug exe load failure under Proton'],
 ['sql-query-engineering','Review SQL joins'],
 ['typescript-contract-engineering','Write TypeScript contracts'],
 ['wasm-runtime-engineering','Debug WebAssembly memory growth'],
 ['cloudflare-platform-engineering','Integrate Cloudflare Turnstile'],
 ['google-identity-integration','Implement signup with Google'],
 ['github-identity-integration','Implement GitHub login'],
 ['edge-model-deployment','Deploy edge ML on ESP32'],
 ['llm-systems-engineering','Optimize LLM attention kernels'],
 ['small-model-engineering','Train a small language model'],
 ['nlp-system-design','Evaluate multilingual NLP tokenization'],
 ['classical-ml-modeling','Train a tabular classifier'],
 ['hybrid-ml-systems','Evaluate a hybrid ML model ensemble'],
 ['rl-decision-systems','Train an SLM with reinforcement learning'],
 ['physics-modeling','Derive a quantum physics simulation'],
 ['resourceful-market-strategy','Design a marketing experiment'],
 ['anti-ai-slop','Review this artifact for anti-ai-slop'],
 ['natural-editorial-writing','Rewrite this article in my voice'],
 ['ui-antipattern-review','Review this generic UI design'],
 ['github-readme-authoring','Write a README for the new library'],
 ['github-repo-presentation','Add a CONTRIBUTING guide and issue templates'],
 ['github-release-notes','Write release notes for v1.2.0'],
 ['github-actions-workflows','Add a GitHub Actions workflow that runs the tests'],
];
assert.equal(cases.length,41);
for(const prompt of ['Inspect the user interface design and marketing security, then publish these changes to the hosting server','Review website security on a shared hosting server'])
 assert.ok(!routeSkills(prompt).some(r=>r.name==='linux-host-defense'),'generic site security/hosting does not imply Linux host administration');
for(const prompt of ['Inspect and improve the user interface and landing page','Review the website layout and screenshots'])
 assert.ok(routeSkills(prompt).some(r=>r.name==='product-ui-verification'),'parent and child share UI workflow routing');
for(const prompt of ['Harden the Ubuntu server firewall','Secure the server','Review host intrusion and exposed SSH ports'])
 assert.ok(routeSkills(prompt).some(r=>r.name==='linux-host-defense'),'actual host administration remains routed');

assert.ok(routeSkills('Review C++20 code').some(r=>r.name==='cpp-performance-engineering'));
assert.ok(routeSkills('Write frontend JS').some(r=>r.name==='browser-javascript-engineering'));
assert.deepEqual(new Set([...cases.map(c=>c[0]),"product-ui-verification","colors","svg-motion-engineering","browser-animation-engineering","physical-animation-systems","procedural-animation-math","threejs-animation-engineering","wasm-animation-pipelines","llm-fine-tuning","llm-dataset-preparation","google-colab-training","local-network-analysis","wireless-signal-analysis","network-traffic-analysis","network-iso-compliance","industrial-automation-control","industrial-device-protocols","browser-automation","proxy-operations","audio-processing","image-analysis","financial-statement-analysis","investment-risk-analysis","rag-engineering","scientific-paper-research","spreadsheet-authoring","presentation-authoring","word-document-authoring","libreoffice-automation","blender-production","terminal-video-editing","cad-engineering","media-in-web","harness-self-maintenance","community-promotion","organic-growth-engineering","motion-graphics-production","video-analysis","sound-analysis","music-composition","email"]),new Set(skillRoutes.map(r=>r.name)));
const catalog='<available_skills>'+cases.map(([name])=>`<skill><name>${name}</name><description>fixture</description><location>${root}skills/${name}/SKILL.md</location></skill>`).join('')+'</available_skills>';
function fixture(prompt='',systemPrompt=catalog) {
 const entries=[];const ctx={cwd:'/routing-case',sessionManager:{getBranch:()=>entries}};
 const pi={getActiveTools:()=>['read','write','edit'],appendEntry:(customType,data)=>entries.push({type:'custom',customType,data})};
 const g=createRelevantGuidance(pi);g.restore(ctx);g.start({prompt,systemPrompt},ctx);return {g,ctx,pi};
}
const priorityFixture=fixture('Implement PHP Google login SQL');
priorityFixture.g.record({toolName:'write',input:{path:'api.ts',content:'const input = data as any;'},isError:false});
assert.equal(priorityFixture.g.candidates()[0].key,'signal:type-bypass','actual code evidence outranks domain routing');
for(const [name,prompt] of cases) {
 assert.ok(routeSkills(prompt).some(r=>r.name===name),prompt);
 const {g}=fixture(prompt);assert.ok(g.candidates().some(h=>h.skill?.endsWith(`/${name}/SKILL.md`)),`delivered: ${prompt}`);
 const dir=path.join(root,'skills',name), text=fs.readFileSync(path.join(dir,'SKILL.md'),'utf8');
 assert.ok(text.split(/\s+/).length<300,`${name}: compact entry`);
 assert.ok(text.includes('references/patterns.md'));
 const reference=fs.readFileSync(path.join(dir,'references/patterns.md'),'utf8');
 assert.ok(reference.split(/\s+/).length>=220,`${name}: substantive examples`);
 assert.ok(reference.includes('https://'),`${name}: primary references`);
 assert.doesNotMatch(text+'\n'+reference,/\[TODO\]|TODO:|TBD/);
}
for(const prompt of ['Go on','What is Python?','Write a story about where we go','Review the vitamin C label','Write JavaScript for a browser','Fix the Go button','Review this assembly of parts']) {
 const routes=routeSkills(prompt).map(r=>r.name);
 assert.ok(!routes.includes('go-service-engineering'),prompt);
 assert.ok(!routes.includes('c-systems-engineering'),prompt);
 assert.ok(!routes.includes('java-platform-engineering'),prompt);
 assert.ok(!routes.includes('x86-assembly-engineering'),prompt);
}
assert.equal(routeSkills('What is Python?').length,0);
assert.ok(!routeSkills('Write an article with wit').some(r=>r.name==='wasm-runtime-engineering'));
assert.ok(!routeSkills('Build an Arduino blinking LED').some(r=>r.name==='edge-model-deployment'));
const noOutputScan=fixture('Fix this');
noOutputScan.g.record({toolName:'read',input:{path:'notes.txt'},content:[{type:'text',text:'Implement PHP Google login'}],isError:false});
assert.equal(noOutputScan.g.candidates().length,0,'document prose does not become task intent');
const failedFile=fixture('Fix this');failedFile.g.record({toolName:'read',input:{path:'missing.php'},isError:true});assert.equal(failedFile.g.candidates().length,0,'failed read is not file evidence');
for(const [file,name] of [['src/main.c','c-systems-engineering'],['src/a.cpp','cpp-performance-engineering'],['x.cs','dotnet-linux-engineering'],['x.f90','fortran-scientific-computing'],['a.rs','rust-systems-engineering'],['a.go','go-service-engineering'],['a.java','java-platform-engineering'],['a.py','python-software-engineering'],['a.php','php-application-engineering'],['a.tsx','typescript-contract-engineering'],['a.sql','sql-query-engineering'],['module.wat','wasm-runtime-engineering'],['wrangler.toml','cloudflare-platform-engineering']]) {
 const {g}=fixture('Fix this');g.record({toolName:'read',input:{path:file},isError:false});
 assert.ok(g.candidates().some(h=>h.skill?.endsWith(`/${name}/SKILL.md`)),file);
}
for(const file of ['common.h','kernel.S','unknown.asm','package.json','generic.js']) assert.equal(routeSkills('',file).length,0,`ambiguous ${file}`);
assert.equal(fixture('Implement PHP','').g.candidates().length,0,'no invented paths');
assert.equal(fixture('Fix this').g.candidates().length,0,'no irrelevant loaded catalog flood');
const {g,ctx,pi}=fixture('Implement PHP Google login SQL');
assert.match(g.candidates()[0].skill,/google-identity/,'security domain outranks general language');
let delivered=0;while(g.candidates().length){const h=g.candidates();assert.ok(h.length<=2);delivered+=h.length;g.commit(h);}
assert.ok(delivered<=3,'per-run budget');
const readFixture=fixture('Implement PHP');const php=path.join(root,'skills/php-application-engineering/SKILL.md');
readFixture.g.record({toolName:'read',input:{path:php},isError:true});assert.ok(readFixture.g.candidates().some(h=>h.skill===php));
readFixture.g.record({toolName:'read',input:{path:php},isError:false});assert.ok(readFixture.g.candidates().every(h=>h.skill!==php));
const restored=createRelevantGuidance(readFixture.pi);restored.restore(readFixture.ctx);restored.start({prompt:'Implement PHP',systemPrompt:catalog},readFixture.ctx);assert.ok(restored.candidates().every(h=>h.skill!==php));
const compacted={...readFixture.ctx,sessionManager:{getBranch:()=>[{type:'compaction'}]}};
restored.restore(compacted);restored.start({prompt:'Implement PHP',systemPrompt:catalog},compacted);assert.ok(restored.candidates().some(h=>h.skill===php),'compaction invalidates read receipt');
const disabled=process.env.PI_RELEVANT_GUIDANCE;process.env.PI_RELEVANT_GUIDANCE='off';assert.equal(fixture('Implement PHP').g.candidates().length,0);if(disabled===undefined)delete process.env.PI_RELEVANT_GUIDANCE;else process.env.PI_RELEVANT_GUIDANCE=disabled;
const core=path.join(execFileSync('npm',['root','-g'],{encoding:'utf8',timeout:5000}).trim(),'@earendil-works/pi-coding-agent/dist/core/skills.js');
const {loadSkillsFromDir}=await import(pathToFileURL(core));
const loaded=loadSkillsFromDir({dir:path.join(root,'skills'),source:'user'});assert.deepEqual(loaded.diagnostics,[]);
for(const [name] of cases)assert.ok(loaded.skills.some(s=>s.name===name),`Pi SDK loads ${name}`);
const threejs=loaded.skills.find(s=>s.name==='threejs');assert.ok(threejs,'Pi SDK loads threejs');assert.match(threejs.description,/voxel\/low-poly/);
const voxelCatalog='<available_skills>'+loaded.skills.map(s=>`<skill><name>${s.name}</name><description>${s.description}</description><location>${s.filePath}</location></skill>`).join('')+'</available_skills>';
const voxelEntries=[];const voxelCtx={cwd:root,sessionManager:{getBranch:()=>voxelEntries}};
const voxelGuidance=createRelevantGuidance({getActiveTools:()=>['read'],appendEntry:(customType,data)=>voxelEntries.push({type:'custom',customType,data})});
voxelGuidance.restore(voxelCtx);voxelGuidance.start({prompt:'Create a voxel Three.js scene with low-poly composition',systemPrompt:voxelCatalog},voxelCtx);
assert.ok(voxelGuidance.candidates().some(h=>h.skill===threejs.filePath&&/Voxel and low-poly art/.test(h.text)),'voxel task reaches the loaded threejs section');
for(const prompt of ['Search old emails about the license renewal','Find Thunderbird inbox messages from last year','Send the newsletter to our subscribers','Triage the support mailbox','Check mail on the IMAP server','Read my gmail inbox'])
 assert.ok(routeSkills(prompt).some(r=>r.name==='email'),`email routes: ${prompt}`);
for(const prompt of ['Write a spring newsletter','Rewrite this article in my voice','Implement signup with Google','What is email?','Do not send email','Check the installed package version'])
 assert.ok(!routeSkills(prompt).some(r=>r.name==='email'),`email ignores: ${prompt}`);
assert.ok(routeSkills('','snap/thunderbird/common/.thunderbird/x/prefs.js').some(r=>r.name==='email'),'thunderbird profile path routes email');
assert.ok(routeSkills('','mail/Archive.mbox').some(r=>r.name==='email'),'mbox file routes email');
const emailLoaded=loaded.skills.find(s=>s.name==='email');assert.ok(emailLoaded,'Pi SDK loads email');
const emailCatalog=`<available_skills><skill><name>email</name><description>${emailLoaded.description}</description><location>${emailLoaded.filePath}</location></skill></available_skills>`;
const emailEntries=[];const emailCtx={cwd:'/email-case',sessionManager:{getBranch:()=>emailEntries}};
const emailGuidance=createRelevantGuidance({getActiveTools:()=>['read'],appendEntry:(customType,data)=>emailEntries.push({type:'custom',customType,data})});
emailGuidance.restore(emailCtx);emailGuidance.start({prompt:'Search old emails about the license renewal',systemPrompt:emailCatalog},emailCtx);
assert.ok(emailGuidance.candidates().some(h=>h.skill===emailLoaded.filePath),'email delivery reaches the loaded skill');
const emailBody=fs.readFileSync(emailLoaded.filePath,'utf8');
assert.ok(emailBody.split(/\s+/).length<350,'email: compact entry');
assert.ok(emailBody.includes('references/mailbox-search.md'),'email: conditional reference');
const emailRef=fs.readFileSync(path.join(path.dirname(emailLoaded.filePath),'references/mailbox-search.md'),'utf8');
assert.ok(emailRef.includes('https://'),'email: primary references');
assert.doesNotMatch(emailBody+'\n'+emailRef,/\[TODO\]|TODO:|TBD/);
console.log(`PASS: 34 skills, intent/file routing, ambiguity, priority, limits, receipts, compaction, voxel relevance and real Pi discovery (${loaded.skills.length} total skills)`);

assert.ok(!routeSkills('sudo cp /etc/sudoers.d/rule ~/backup\nsetfacl: /workspace/lib/Net.cpp.o: Operation not permitted').some(r=>r.name==='cpp-performance-engineering'));
