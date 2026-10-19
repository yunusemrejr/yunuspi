import {resolveOwnedCore} from '../lib/owned-core.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {skillRoutes, routeSkills} from '../../extensions/lib/skill-routing.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
const cases=[
 ['growth-finance','Audit SEO and structured data'],
 ['api-security','Harden the Ubuntu server firewall'],
 ['linux-ops','Configure apt on Ubuntu'],
 ['frontend','Build an accessible web dialog'],
 ['frontend','Choose a UI library and CDN setup'],
 ['systems-languages','Implement a PHP endpoint'],
 ['frontend','Fix vanilla JavaScript stale updates'],
 ['engineering','Write a Python desktop tool'],
 ['engineering','Build a Node.js server'],
 ['systems-languages','Implement this in C'],
 ['systems-languages','Optimize this C++ renderer'],
 ['systems-languages','Review Rust FFI code'],
 ['systems-languages','Build a Go service'],
 ['systems-languages','Fix a Java transaction'],
 ['systems-languages','Optimize the x86-64 SIMD kernel'],
 ['systems-languages','Review Fortran array handling'],
 ['systems-languages','Build a C# Linux application'],
 ['winecharm','Install WineCharm via flatpak'],
 ['linux-ops','Debug exe load failure under Proton'],
 ['data-science','Review SQL joins'],
 ['engineering','Write TypeScript contracts'],
 ['wasm','Debug WebAssembly memory growth'],
 ['api-security','Integrate Cloudflare Turnstile'],
 ['api-security','Implement signup with Google'],
 ['api-security','Implement GitHub login'],
 ['ml','Deploy edge ML on ESP32'],
 ['ml','Optimize LLM attention kernels'],
 ['ml','Train a small language model'],
 ['ml','Evaluate multilingual NLP tokenization'],
 ['ml','Train a tabular classifier'],
 ['ml','Evaluate a hybrid ML model ensemble'],
 ['ml','Train an SLM with reinforcement learning'],
 ['data-science','Derive a quantum physics simulation'],
 ['growth-finance','Design a marketing experiment'],
 ['ui-design','Review this artifact for ui-design'],
 ['research-writing','Rewrite this article in my voice'],
 ['ui-design','Review this generic UI design'],
 ['git-github','Write a README for the new library'],
 ['git-github','Add a CONTRIBUTING guide and issue templates'],
 ['git-github','Write release notes for v1.2.0'],
 ['git-github','Add a GitHub Actions workflow that runs the tests'],
];
assert.equal(cases.length,41);
for(const prompt of ['Inspect the user interface design and marketing security, then publish these changes to the hosting server','Review website security on a shared hosting server'])
 assert.ok(!routeSkills(prompt).some(r=>r.name==='api-security'),'generic site security/hosting does not imply Linux host administration');
for(const prompt of ['Inspect and improve the user interface and landing page','Review the website layout and screenshots'])
 assert.ok(routeSkills(prompt).some(r=>r.name==='ui-design'),'parent and child share UI workflow routing');
for(const prompt of ['Harden the Ubuntu server firewall','Secure the server','Review host intrusion and exposed SSH ports'])
 assert.ok(routeSkills(prompt).some(r=>r.name==='api-security'),'actual host administration remains routed');

assert.ok(routeSkills('Review C++20 code').some(r=>r.name==='systems-languages'));
assert.ok(routeSkills('Write frontend JS').some(r=>r.name==='frontend'));
for(const [name,prompt] of cases) {
 assert.ok(routeSkills(prompt).some(r=>r.name===name),prompt);
 const dir=path.join(root,'skills',name), text=fs.readFileSync(path.join(dir,'SKILL.md'),'utf8');
 // Guides vary in length and reference layout. Validate actual local links
 // instead of imposing the former compact-template word and filename quotas.
 const referenceBodies=[];
 for(const match of text.matchAll(/\]\((references\/[^)#]+)\)/g)) {
  const reference=path.resolve(dir,match[1]);
  assert.ok(reference.startsWith(path.resolve(dir)+path.sep),`${name}: reference stays in the skill`);
  referenceBodies.push(fs.readFileSync(reference,'utf8'));
 }
 assert.doesNotMatch(text+'\n'+referenceBodies.join('\n'),/\[TODO\]|TODO:|TBD/);
}
for(const prompt of ['Go on','What is Python?','Write a story about where we go','Review the vitamin C label','Write JavaScript for a browser','Fix the Go button','Review this assembly of parts']) {
 const routes=routeSkills(prompt).map(r=>r.name);
 assert.ok(!routes.includes('systems-languages'),prompt);
 assert.ok(!routes.includes('systems-languages'),prompt);
 assert.ok(!routes.includes('systems-languages'),prompt);
 assert.ok(!routes.includes('systems-languages'),prompt);
}
assert.equal(routeSkills('What is Python?').length,0);
assert.ok(!routeSkills('Write an article with wit').some(r=>r.name==='wasm'));
assert.ok(!routeSkills('Build an Arduino blinking LED').some(r=>r.name==='ml'));
for(const file of ['common.h','kernel.S','unknown.asm','package.json','generic.js']) assert.equal(routeSkills('',file).length,0,`ambiguous ${file}`);
const core=path.join(resolveOwnedCore(),'dist/core/skills.js');
const {loadSkillsFromDir}=await import(pathToFileURL(core));
const loaded=loadSkillsFromDir({dir:path.join(root,'skills'),source:'user'});assert.deepEqual(loaded.diagnostics,[]);
for(const {name} of skillRoutes)assert.ok(loaded.skills.some(s=>s.name===name),`Pi SDK loads ${name}`);
const threejs=loaded.skills.find(s=>s.name==='web-motion');assert.ok(threejs,'Pi SDK loads threejs');assert.match(threejs.description,/voxel\/low-poly/);
for(const prompt of ['Search old emails about the license renewal','Find Thunderbird inbox messages from last year','Send the newsletter to our subscribers','Triage the support mailbox','Check mail on the IMAP server','Read my gmail inbox'])
 assert.ok(routeSkills(prompt).some(r=>r.name==='research-writing'),`email routes: ${prompt}`);
for(const prompt of ['Write a spring newsletter','Rewrite this article in my voice','Implement signup with Google','What is email?','Do not send email','Check the installed package version'])
 assert.ok(!routeSkills(prompt).some(r=>r.name==='research-writing'),`email ignores: ${prompt}`);
assert.ok(routeSkills('','snap/thunderbird/common/.thunderbird/x/prefs.js').some(r=>r.name==='research-writing'),'thunderbird profile path routes email');
assert.ok(routeSkills('','mail/Archive.mbox').some(r=>r.name==='research-writing'),'mbox file routes email');
const emailLoaded=loaded.skills.find(s=>s.name==='research-writing');assert.ok(emailLoaded,'Pi SDK loads email');
const emailBody=fs.readFileSync(emailLoaded.filePath,'utf8');
assert.ok(emailBody.split(/\s+/).length<350,'email: compact entry');
assert.ok(emailBody.includes('references/mailbox-search.md'),'email: conditional reference');
const emailRef=fs.readFileSync(path.join(path.dirname(emailLoaded.filePath),'references/mailbox-search.md'),'utf8');
assert.ok(emailRef.includes('https://'),'email: primary references');
assert.doesNotMatch(emailBody+'\n'+emailRef,/\[TODO\]|TODO:|TBD/);
console.log(`PASS: ${cases.length} task fixtures, intent/file routing, ambiguity and real Pi discovery (${loaded.skills.length} total skills)`);

assert.ok(!routeSkills('sudo cp /etc/sudoers.d/rule ~/backup\nsetfacl: /workspace/lib/Net.cpp.o: Operation not permitted').some(r=>r.name==='systems-languages'));
