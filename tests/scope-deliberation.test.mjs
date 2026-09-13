import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const release=path.resolve(import.meta.dirname,'..');
const agent=fs.existsSync(path.join(release,'agent'))?path.join(release,'agent'):path.resolve(release,'..');
const {shouldRunScopeCouncil,scopeRequest,createScopeDeliberation,SCOPE_GUIDANCE,SCOPE_LIMITS}=await import(pathToFileURL(path.join(agent,'extensions/lib/scope-deliberation.ts')));
const prompt='Please redesign the jumping character logic because it is distracting and low quality, then update production.';
const context=(id='current')=>({cwd:'/tmp/synthetic-project',sessionManager:{getSessionId:()=>id,getBranch:()=>[]},ui:{setStatus(){}}});
const history={evidence:[{id:'past:1',role:'user',at:'2026-01-01',text:'Preserve the serif typography and the blue palette.'},{id:'past:2',role:'assistant',at:'2026-02-01',text:'I added a jumping mascot to draw attention to the navigation.'}],incomplete:false,coverage:'Two relevant synthetic messages.'};
const result={status:'complete',proposals:[{role:'preservation',text:'Keep typography [past:1].'},{role:'change',text:'Reconsider the mascot behavior [past:2].'}],discussion:'Revise the motion substantially; preserve the explicit visual references. Verify reduced-motion and the rendered result.',gap:''};

test('open scope changes trigger automatically; exact edits, quotations and read-only tasks stay small',()=>{
  for(const p of [prompt,'Improve the checkout workflow.','Refactor the task scheduling architecture.','Please fix the animation; it looks cheap.','Can you rework the character behavior?',"Redesign the distracting mascot, but don't change the font or colors."])assert.equal(shouldRunScopeCouncil(p),true,p);
  for(const p of ['What is a good animation?','How would you redesign the website?','Only explain how to improve the UI.','Change animation-duration to 2s.','Fix the spelling of navigation.','Read-only review: redesign the layout?','> Please redesign the animation\nSummarize the quotation.','```text\nRedesign the UI\n```'])assert.equal(shouldRunScopeCouncil(p),false,p);
  const branch=[{type:'message',id:'request',message:{role:'user',content:prompt}}];
  assert.match(scopeRequest('Make it less distracting.',branch),/Earlier subject/);
  assert.equal(scopeRequest('What is the current time?',branch),undefined);
  assert.equal(shouldRunScopeCouncil('Please do not redesign the animation.'),false);
});

test('a relevant turn starts an independent council before inference with one bounded replaceable brief',async()=>{
  let calls=0;const receipts=[];
  const lifecycle=createScopeDeliberation({appendEntry:(type,data)=>receipts.push({type,data})},{history:async()=>history,runner:async(request)=>{calls++;assert.equal(request.task,prompt);assert.equal(request.history.evidence[1].role,'assistant');return result;}});
  const ctx=context();const event={prompt};
  await lifecycle.start(event,ctx,'graph');
  await lifecycle.start(event,ctx,'graph');
  assert.equal(calls,1);
  const brief=lifecycle.context(ctx);
  assert.match(brief,/serif typography/);assert.match(brief,/Advisory, not approval/);assert.match(brief,/Revise the motion substantially/);
  assert.ok(brief.length<=SCOPE_LIMITS.contextChars);
  assert.equal(lifecycle.context(context('other')),'');
  assert.doesNotMatch(JSON.stringify(receipts),/serif|mascot|production/);
  await lifecycle.start({prompt:'Automatic quality review completed; assess it.'},ctx,'graph');
  assert.equal(lifecycle.context(ctx),brief,'synthetic follow-up keeps the current brief without another council');
  lifecycle.input({source:'extension',text:'Rework the entire animation again.'});
  await lifecycle.start({prompt:'Rework the entire animation again.'},ctx,'graph');
  assert.equal(calls,1,'synthetic revision wording cannot grant another council budget');
  lifecycle.input({source:'interactive',text:'Keep the mascot, only revise its timing.'});
  assert.equal(lifecycle.context(ctx),'','new direction invalidates the old recommendation immediately');
});

test('new user input, session cancellation and active-agent stop discard late council results',async()=>{
  for(const mode of ['input','switch','signal']){
    let release,started;const began=new Promise(resolve=>started=resolve);const waiting=new Promise(resolve=>release=resolve);
    const lifecycle=createScopeDeliberation({},{history:async()=>history,runner:async()=>{started();await waiting;return result;}});
    const ctx=context(), controller=new AbortController();
    // Preflight has no signal; context receives the active agent signal later.
    const task=lifecycle.start({prompt},ctx,'graph');await began;
    ctx.signal=controller.signal;
    const settlement=lifecycle.settle(ctx);
    if(mode==='input')lifecycle.input({source:'interactive',text:'Keep the character.'});
    if(mode==='switch')lifecycle.cancel();
    if(mode==='signal')controller.abort();
    await settlement;await task;
    release();await Promise.resolve();
    assert.equal(lifecycle.context(ctx),'',mode);
  }
});

test('failed or hung councils preserve gaps, whole history and parent autonomy',async()=>{
  const ctx=context();
  const lifecycle=createScopeDeliberation({},{history:async()=>history,runner:()=>new Promise(()=>{}),deadlineMs:20});
  // Keep a test handle alive: AbortSignal.timeout is deliberately unref'd.
  const keeper=setTimeout(()=>{},200);
  try{await lifecycle.start({prompt},ctx,'graph');}finally{clearTimeout(keeper);}
  assert.match(lifecycle.context(ctx),/unavailable/);assert.match(lifecycle.context(ctx),/deadline/);assert.match(lifecycle.context(ctx),/serif typography/);
  assert.match(SCOPE_GUIDANCE,/absence.*proves neither origin nor approval/);
  assert.match(SCOPE_GUIDANCE,/Current user direction wins/);
  assert.match(SCOPE_GUIDANCE,/without routine questions/);
});

test('omitted newer statements never backfill an older preference, and empty output cannot claim consensus',async()=>{
  const long={evidence:[history.evidence[0],{id:'later',role:'user',at:'2026-03-01',text:'Change the earlier design. '+ 'Complete qualifying detail. '.repeat(100)}],incomplete:true,coverage:'Brief space exceeded.'};
  const lifecycle=createScopeDeliberation({},{history:async()=>long,runner:async()=>({status:'complete',proposals:[],discussion:''})});
  const ctx=context();await lifecycle.start({prompt},ctx,'graph');
  assert.doesNotMatch(lifecycle.context(ctx),/Preserve the serif/);
  assert.match(lifecycle.context(ctx),/Council status: unavailable/);
  assert.match(lifecycle.context(ctx),/omitted history remains unknown/);
});

test('explicit disable and child sessions never trigger a council',async()=>{
  for(const variable of ['PI_SCOPE_COUNCIL','PI_SUBAGENT_CHILD']){
    const prior=process.env[variable];process.env[variable]=variable==='PI_SCOPE_COUNCIL'?'off':'1';
    try{let calls=0;const lifecycle=createScopeDeliberation({},{history:async()=>{calls++;return history;},runner:async()=>result});await lifecycle.start({prompt},context(),'graph');assert.equal(calls,0);}
    finally{if(prior===undefined)delete process.env[variable];else process.env[variable]=prior;}
  }
});

test('a changed Git baseline or switched conversation branch discards pending proposals',async()=>{
  for(const mode of ['git','branch']) {
    let calls=0;
    const baseline={projectId:'project',checkoutId:'checkout',conversation:{sessionId:'current',branchHead:'old',latestUserEntry:'user'},projectGit:{head:'a'.repeat(40),branch:'main'}};
    const changed=structuredClone(baseline);
    if(mode==='git')changed.projectGit.head='b'.repeat(40);
    else changed.conversation.branchHead='other-branch';
    const lifecycle=createScopeDeliberation({},{history:async()=>history,workflow:async()=>++calls===1?baseline:changed,runner:async()=>result});
    const ctx=context();await lifecycle.start({prompt},ctx,'graph');
    assert.match(lifecycle.context(ctx),/Version baseline changed/);
    assert.doesNotMatch(lifecycle.context(ctx),/Revise the motion substantially|Preserve the serif/);
  }
});

test('ordinary append-only council receipts do not invalidate the active conversation ancestry',async()=>{
  let calls=0;
  const baseline={projectId:'project',checkoutId:'checkout',conversation:{sessionId:'current',branchHead:'old',latestUserEntry:'user'},projectGit:{head:'a'.repeat(40),branch:'main'}};
  const lifecycle=createScopeDeliberation({},{history:async()=>history,workflow:async()=>++calls===1?baseline:{...baseline,conversation:{...baseline.conversation,branchHead:'receipt'}},runner:async()=>result});
  const ctx=context();ctx.sessionManager.getBranch=()=>[{id:'old'},{id:'receipt'}];
  await lifecycle.start({prompt},ctx,'graph');
  assert.match(lifecycle.context(ctx),/Council status: complete/);
});

test('an internal wake cannot turn a previously unrelated user request into a council task',async()=>{
  let calls=0;
  const lifecycle=createScopeDeliberation({},{history:async()=>{calls++;return history;},runner:async()=>result});
  const ctx=context();
  lifecycle.input({source:'interactive',text:'Fix the spelling of navigation.'});
  await lifecycle.start({prompt:'Fix the spelling of navigation.'},ctx,'graph');
  lifecycle.input({source:'extension',text:prompt});
  await lifecycle.start({prompt},ctx,'graph');
  assert.equal(calls,0);
  lifecycle.input({source:'interactive',text:prompt});
  await lifecycle.start({prompt},ctx,'graph');
  assert.equal(calls,1,'a new actual user request gets a fresh routing decision');
});
