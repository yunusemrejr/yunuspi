import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {register} from 'node:module';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const agent=[path.join(root,'agent'),path.resolve(root,'..')].find(p=>fs.existsSync(path.join(p,'extensions/lib/quality-review.ts')));
// Schema construction is not under test; the installed harness uses TypeBox.
// The release's dependency-free fixtures exercise actual lifecycle/IO owners.
const schema='data:text/javascript,'+encodeURIComponent('export const Type=new Proxy({}, {get:(_t,name)=>(...args)=>({name,args})});');
register('data:text/javascript,'+encodeURIComponent(`export function resolve(n,c,next){return n==='typebox'?{url:${JSON.stringify(schema)},shortCircuit:true}:next(n,c);}`),import.meta.url);
const {createQualityReviewLifecycle,reviewAspects,parseReviewReport,REVIEW_LIMITS}=await import(pathToFileURL(path.join(agent,'extensions/lib/quality-review.ts')));
const {projectTestFacts,isProjectReviewSource}=await import(pathToFileURL(path.join(agent,'scripts/workspace-facts.mjs')));
const storePath=path.join(agent,'extensions/lib/project-intelligence/store.mjs');
const openStore=fs.existsSync(storePath)?(await import(pathToFileURL(storePath))).openStore:undefined;
const pass=(aspect)=>({aspect,ok:true,text:JSON.stringify({outcome:'pass',evidence:['src/value.js:1 preserves zero and negative inputs; source and focused tests checked.'],findings:[],gap:''})});
async function fixture(t,{runner,context}={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'quality-check-'));
 const tools={},sent=[],branch=[],calls=[];let idle=true,queued=false,tests={need:null},rejectDelivery=false;
 const ctx={cwd:dir,isIdle:()=>idle,hasPendingMessages:()=>queued,sessionManager:{getBranch:()=>branch}};
 const api=createQualityReviewLifecycle({registerTool:d=>tools[d.name]=d,getActiveTools:()=>['quality_review','project_tests','subagent'],appendEntry:(customType,data)=>branch.push({type:'custom',customType,data:structuredClone(data)}),sendMessage:(m,o)=>{if(rejectDelivery)throw Error('queue unavailable');sent.push({m,o});}},
  {refresh:async()=>api.observe(await projectTestFacts(dir),false),tests:()=>tests,runner:async(...args)=>{calls.push(args);return runner?runner(...args):args[0].aspects.map(a=>pass(a.id));},context:context??(async()=>({graph:'Checkout-scoped source graph; evidence may be incomplete.',history:[]}))});
 api.restore(ctx);await api.run(ctx);api.input({source:'interactive',text:'Implement the behavior and verify quality'});
 t.after(()=>{api.shutdown();fs.rmSync(dir,{recursive:true,force:true});});
 return {api,ctx,calls,sent,branch,tools,dir,tests:v=>tests=v,idle:v=>idle=v,queued:v=>queued=v,rejectDelivery:v=>rejectDelivery=v,
  state:()=>api.snapshot(),
  async mutate(file='src/value.js',text='export const value = 1;',isError=false){if(!isError){fs.mkdirSync(path.dirname(path.join(dir,file)),{recursive:true});fs.writeFileSync(path.join(dir,file),text);}api.observe(await projectTestFacts(dir),true);api.result({toolName:'write',input:{path:file},isError},ctx);},
  tool:params=>tools.quality_review.execute('test',params,undefined,undefined,ctx),
  settle:()=>api.settled({},ctx)};
}

test('routing includes text, CSS/HTML, technical stack, security and delivery without turning every project into a web audit',()=>{
 assert.deepEqual(reviewAspects(['README.md']).map(a=>a.id),['content']);
 assert.ok(reviewAspects(['styles.css','index.html']).some(a=>a.id==='interface'));
 assert.ok(reviewAspects(['a.wasm']).some(a=>a.id==='runtime'));
 assert.ok(reviewAspects(['a.py']).some(a=>a.id==='runtime'));
 assert.ok(reviewAspects(['a.php']).some(a=>a.id==='runtime'));
 assert.equal(reviewAspects(['auth.ts','a.py'])[0].id,'security');
 assert.ok(reviewAspects(['build.yml'],'Verify the production deployment').some(a=>a.id==='delivery'));
 const aspects=reviewAspects(['a.py','README.md'],'',Array.from({length:20},()=>({aspect:'content',outcome:'changes'})));
 assert.equal(aspects[0].id,'content');assert.equal(REVIEW_LIMITS.rounds,2);
});
test('malformed, empty and unsupported verdicts never pass; suggestions remain nonblocking',()=>{
 for(const text of ['','NO_USEFUL_FINDINGS','Looks fine','{}',JSON.stringify({outcome:'pass',evidence:[],findings:[]}),JSON.stringify({outcome:'pass',evidence:['source content reviewed'],findings:[{severity:'blocking',file:'a.js',detail:'A real failure boundary is broken here'}]})])assert.equal(parseReviewReport(text,'correctness').outcome,'unknown');
 const v={outcome:'pass',evidence:['README.md:1 contains the clarified sentence.'],findings:[{severity:'improvement',file:'README.md',detail:'Optional shortening would reduce repetition in this sentence.'}],gap:''};
 assert.equal(parseReviewReport(JSON.stringify(v),'content').outcome,'pass');
 v.findings[0].file='../secret';assert.equal(parseReviewReport(JSON.stringify(v),'content').outcome,'unknown');
});
test('automatic settled review runs once; parent assessment and current tests are required; edits invalidate acceptance',async t=>{
 const f=await fixture(t);await f.settle();assert.equal(f.calls.length,0);
 await f.mutate();await f.settle();assert.equal(f.calls.length,1);assert.equal(f.sent.length,1);assert.equal(f.state().status,'awaiting_assessment');
 await f.settle();assert.equal(f.calls.length,1);assert.equal(f.sent.length,1);
 assert.equal(f.calls[0][0].graph,'Checkout-scoped source graph; evidence may be incomplete.');
 f.tests({need:'failed'});await assert.rejects(f.tool({action:'assess',disposition:'accepted',reason:'Reviewed current source and the relevant behavior.'}),/test evidence/);
 f.tests({need:null});await f.tool({action:'assess',disposition:'accepted',reason:'Reviewed current source and relevant test results; no blocking defects.'});assert.equal(f.state().status,'accepted');
 await f.mutate('src/value.js','export const value=2;');assert.equal(f.state().status,'pending');await f.settle();assert.equal(f.calls.length,2);
 await f.mutate('src/value.js','export const value=3;');await f.settle();assert.equal(f.calls.length,2);assert.equal(f.state().status,'budget_exhausted');
 for(let i=0;i<5;i++){f.api.input({source:'extension',text:'continue'});await f.settle();}assert.ok(f.sent.length<=3);
 await f.tool({action:'assess',disposition:'blocked',reason:'The bounded review budget is exhausted; report the remaining source review gap.'});assert.equal(f.state().status,'blocked');
});
test('docs and native writes beyond scan limits trigger reviews; read-only and failed writes do not',async t=>{
 const f=await fixture(t);await f.mutate('README.md','No write',true);await f.settle();assert.equal(f.calls.length,0);
 await f.mutate('README.md','Public documentation update');await f.settle();assert.equal(f.calls[0][0].aspects[0].id,'content');
 await f.mutate('a/b/c/d/e/f/g/theme.css','body { color: black }');assert.ok(f.state().changed.includes('a/b/c/d/e/f/g/theme.css'));
 await assert.rejects(f.tool({action:'assess',disposition:'accepted',reason:'No independent source evidence for the latest changes yet.'}),/Current independent/);
});
test('deployment workflow edits are reviewed while credentials and hidden runtime state remain excluded',async t=>{
 const f=await fixture(t);await f.mutate('.github/workflows/deploy.yml','name: Deploy');await f.settle();assert.ok(f.calls[0][0].aspects.some(a=>a.id==='delivery'));
 const before=f.state().revision;await f.mutate('.env','TEST_PRIVATE_PLACEHOLDER');await f.mutate('auth.json','{}');assert.equal(f.state().revision,before);
 const facts=await projectTestFacts(f.dir);assert.ok(facts.reviewSources['.github/workflows/deploy.yml']);assert.equal(facts.reviewSources['.env'],undefined);
});
test('credential configuration is excluded across formats, native receipts, scans and restored scopes',async t=>{
 const f=await fixture(t);
 const files=['secrets.yaml','credentials.yml','config/secrets.json','auth.toml','config/settings.xml','models.yaml','production.credentials.json','api-key.txt','config/private_key.toml','config/tokens.yml','credentials/identity.json','.env','nested/secrets/test.json'];
 for(const file of files){assert.equal(isProjectReviewSource(file),false,file);assert.equal(isProjectReviewSource(file.replaceAll('/','\\')),false,file);await f.mutate(file,'TEST_PRIVATE_PLACEHOLDER');}
 await f.settle();assert.equal(f.calls.length,0);assert.equal(f.state().changed.length,0);
 const facts=await projectTestFacts(f.dir);for(const file of files)assert.equal(facts.reviewSources[file],undefined,file);
 f.branch.push({type:'custom',customType:'quality-review-v1',data:{root:f.dir,revision:0,changed:files}});f.api.restore(f.ctx);assert.equal(f.state().changed.length,0);
 for(const file of ['src/auth.ts','src/settings.py','src/models.rs','config/public.yaml'])assert.equal(isProjectReviewSource(file),true,file);
});
test('extensionless delivery files participate in both source discovery and native review dispatch',async t=>{
 const f=await fixture(t);
 const files=['Dockerfile','containers/Dockerfile.production','Containerfile','release.Containerfile','Makefile','GNUmakefile','Jenkinsfile','Procfile','Justfile'];
 for(const file of files){assert.equal(isProjectReviewSource(file),true,file);assert.ok(reviewAspects([file]).some(a=>a.id==='delivery'),file);await f.mutate(file,'FROM example.invalid/base');}
 const facts=await projectTestFacts(f.dir);for(const file of files)assert.ok(facts.reviewSources[file],file);
 await f.settle();assert.equal(f.calls.length,1);assert.deepEqual(new Set(f.calls[0][0].files),new Set(files));assert.ok(f.calls[0][0].aspects.some(a=>a.id==='delivery'));
});
test('real bounded discovery detects shell source edits and deletion without attributing unrelated idle changes',async t=>{
 const f=await fixture(t);fs.writeFileSync(path.join(f.dir,'external.md'),'peer work');f.api.observe(await projectTestFacts(f.dir),false);assert.equal(f.state().changed.length,0);
 fs.writeFileSync(path.join(f.dir,'external.md'),'shell mutation');f.api.observe(await projectTestFacts(f.dir),true);await f.settle();assert.equal(f.calls.length,1);
 fs.unlinkSync(path.join(f.dir,'external.md'));await f.tool({action:'inspect'});assert.equal(f.state().status,'pending');
});
test('missing reviewers, invalid responses and omitted aspects are explicit gaps; no repeated retry or false pass',async t=>{
 const f=await fixture(t,{runner:async()=>[]});await f.mutate();await f.settle();assert.equal(f.state().reports[0].outcome,'unknown');
 await assert.rejects(f.tool({action:'assess',disposition:'accepted',reason:'This should never accept a missing reviewer response.'}),/missing evidence/);
 await f.settle();await f.tool({action:'review'});assert.equal(f.calls.length,1);
 await f.tool({action:'assess',disposition:'blocked',reason:'No permitted reviewer is available; disclose the independent review gap.'});assert.equal(f.state().status,'blocked');
});
test('unavailable reviewers settle once with an actionable gap and no automatic acknowledgement turn',async t=>{
 const gap='No healthy permitted reviewer has the required tool/context/output capacity within the economy policy.';
 const f=await fixture(t,{runner:async req=>req.aspects.map(a=>({aspect:a.id,ok:false,text:'',gap}))});
 await f.mutate();await f.settle();
 assert.equal(f.state().status,'blocked');assert.equal(f.state().reports[0].gap,gap);
 assert.equal(f.sent.length,1);assert.equal(f.sent[0].m.customType,'quality-review-status');assert.equal(f.sent[0].o.triggerTurn,false);assert.equal(f.api.notice(),'');
 for(let i=0;i<4;i++){await f.settle();await f.tool({action:'review'});}
 assert.equal(f.calls.length,1);assert.equal(f.sent.length,1);
 await assert.rejects(f.tool({action:'assess',disposition:'accepted',reason:'Review capacity failure must never become a quality pass.'}),/missing evidence/);
});
test('concurrent settled hooks deliver one blocked status receipt',async t=>{
 const f=await fixture(t,{runner:async()=>[]});await f.mutate();
 await Promise.all([f.settle(),f.settle()]);
 assert.equal(f.calls.length,1);assert.equal(f.sent.length,1);
 assert.equal(f.sent[0].m.customType,'quality-review-status');
 assert.equal(f.sent[0].o.triggerTurn,false);
});
test('blocking findings require an explicit evidence-based dismissal or a repair and new review',async t=>{
 const f=await fixture(t,{runner:async req=>req.aspects.map(a=>({aspect:a.id,ok:true,text:JSON.stringify({outcome:'changes',evidence:['src/value.js:1 returns a wrong result for negative inputs.'],findings:[{severity:'blocking',file:'src/value.js',detail:'A negative input becomes positive, violating the documented result contract.'}],gap:''})}))});
 await f.mutate();await f.settle();
 await assert.rejects(f.tool({action:'assess',disposition:'accepted',reason:'All findings were considered and this looks good enough.'}),/correctness-1/);
 await f.tool({action:'assess',disposition:'accepted',reason:'The independent finding conflicts with the documented absolute-value contract.',dismissals:[{id:'correctness-1',reason:'The function contract explicitly returns an absolute value; the negative-input test confirms that behavior.'}]});assert.equal(f.state().status,'accepted');
});
test('late reviewer completion after edits cannot approve newer content',async t=>{
 let finish;const f=await fixture(t,{runner:req=>new Promise(resolve=>finish=()=>resolve(req.aspects.map(a=>pass(a.id))))});await f.mutate();
 const pending=f.settle();while(!finish)await new Promise(r=>setImmediate(r));await f.mutate('src/value.js','export const value=9;');finish();await pending;
 assert.notEqual(f.state().status,'accepted');assert.equal(f.state().reports.length,0);
});
test('a peer deadline preserves completed aspect evidence but rejects late results',async t=>{
 const original=REVIEW_LIMITS.deadlineMs;REVIEW_LIMITS.deadlineMs=40;
 t.after(()=>{REVIEW_LIMITS.deadlineMs=original;});
 let late;
 const f=await fixture(t,{runner:async req=>{
  req.onResult?.(pass('correctness'));
  late=new Promise(resolve=>setTimeout(()=>{req.onResult?.(pass('content'));resolve();},100));
  await late;return req.aspects.map(a=>pass(a.id));
 }});
 await f.mutate();await f.mutate('README.md','Explain the current behavior.');await f.settle();
 assert.equal(f.state().reports.find(r=>r.aspect==='correctness').outcome,'pass');
 assert.equal(f.state().reports.find(r=>r.aspect==='content').outcome,'unknown');
 await assert.rejects(f.tool({action:'assess',disposition:'accepted',reason:'A partial review cannot establish all required aspect evidence.'}),/missing evidence/);
 const snapshot=JSON.stringify(f.state());await late;assert.equal(JSON.stringify(f.state()),snapshot);
});
test('Stop cancels a noncooperative runner; late output and extension messages cannot resume it',async t=>{
 let started,finish;const f=await fixture(t,{runner:req=>{started=true;return new Promise(resolve=>finish=()=>resolve(req.aspects.map(a=>pass(a.id))));}});await f.mutate();
 const pending=f.settle();while(!started)await new Promise(r=>setImmediate(r));f.api.message({message:{role:'assistant',stopReason:'aborted'}});await pending;finish();
 f.api.message({message:{role:'assistant',stopReason:'stop'}});f.api.input({source:'extension',text:'resume'});await f.settle();assert.equal(f.sent.length,0);assert.equal(f.state().reports.length,0);
});
test('queued messages, failed delivery, reload and new user scopes retain bounded continuation semantics',async t=>{
 const f=await fixture(t);await f.mutate();f.queued(true);await f.settle();assert.equal(f.calls.length,0);f.queued(false);
 f.rejectDelivery(true);await f.settle();assert.equal(f.sent.length,0);f.rejectDelivery(false);await f.settle();assert.equal(f.sent.length,1);
 f.api.restore(f.ctx);await f.settle();assert.equal(f.sent.length,1);assert.equal(f.state().reports.length,0);
 f.api.input({source:'interactive',text:'Continue reviewing this change'});await f.settle();assert.equal(f.calls.length,2);
});
test('new user input can retry unavailable capacity or a blocked review without an artificial edit',async t=>{
 let capacity=false;
 const f=await fixture(t,{runner:async req=>capacity?req.aspects.map(a=>pass(a.id)):[]});
 await f.mutate();await f.settle();assert.equal(f.state().reports[0].outcome,'unknown');
 capacity=true;f.api.input({source:'interactive',text:'Retry the quality review'});await f.settle();assert.equal(f.calls.length,2);assert.equal(f.state().reports[0].outcome,'pass');
 await f.tool({action:'assess',disposition:'blocked',reason:'An environment check remains unavailable; report this limitation.'});
 f.api.input({source:'interactive',text:'Continue reviewing the changes'});await f.settle();assert.equal(f.calls.length,3);
});
test('file-count overflow remains explicit and cannot certify an omitted part of the change',async t=>{
 const f=await fixture(t);for(let i=0;i<140;i++){const file='file-'+i+'.md';fs.writeFileSync(path.join(f.dir,file),'Scoped content');f.api.result({toolName:'write',input:{path:file},isError:false},f.ctx);}
 await f.settle();assert.equal(f.state().changed.length,128);assert.equal(f.state().truncated,true);
 await assert.rejects(f.tool({action:'assess',disposition:'accepted',reason:'The reviewer returned passes for the bounded subset of files.'}),/incomplete/);
 f.api.restore(f.ctx);assert.equal(f.state().truncated,true);
});
test('history is checkout-scoped, excludes the current session, is bounded and preserves earlier discovered defects',{skip:!openStore},t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'review-history-')),db=openStore(path.join(dir,'project.sqlite'));
 t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
 if(typeof db.reviewHistory!=='function'){t.skip('Project intelligence is installed without the optional quality-history adapter.');return;}
 db.reviewHistory('checkout-a','session-a',[{aspect:'content',outcome:'changes',secret:'TEST_MUST_NOT_PERSIST'}]);
 db.reviewHistory('checkout-a','session-a',[{aspect:'content',outcome:'pass'}]);
 assert.equal(db.reviewHistory('checkout-a','session-a').length,0);
 const records=db.reviewHistory('checkout-a','session-b');assert.equal(records[0].outcome,'pass');assert.equal(records[0].hadChanges,true);assert.doesNotMatch(JSON.stringify(records),/secret|session-a/);
 assert.deepEqual(db.reviewHistory('checkout-b','session-b'),[]);
 for(let i=0;i<90;i++)db.reviewHistory('checkout-a','peer-'+i,[{aspect:'content',outcome:'unknown'}]);assert.equal(db.reviewHistory('checkout-a','last').length,20);
 assert.throws(()=>db.reviewHistory('checkout-a','session-a',[{aspect:'secret text',outcome:'pass'}]),/Invalid review/);
});
