import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';

const jiti=createJiti(import.meta.dirname);
const gs=await jiti.import('../agent/extensions/lib/goal-state.ts');
const {intentBundleTools}=await jiti.import('../agent/extensions/lib/tool-discovery.ts');
const {default:goalExtension}=await jiti.import('../agent/extensions/goal.ts');

const met=(goal,id,evidence='npm test: 12 passed, exit 0')=>{
 const out=gs.recordEvidence(goal,id,'met',evidence);
 assert.equal(out.error,undefined,out.error);
 return out.goal;
};
const settleAll=(goal)=>goal.criteria.reduce((g,c)=>met(g,c.id),goal);

test('a goal is seeded from the user words plus an end-to-end verification criterion',()=>{
 const goal=gs.createGoal('Make the parser handle nested quotes.\n- add regression tests\n- update the docs');
 const texts=goal.criteria.map(c=>c.text);
 assert.ok(goal.criteria.length>=4);
 assert.match(texts.join('\n'),/regression tests/);
 assert.equal(goal.criteria.at(-1).id,'V');
 assert.ok(goal.criteria.every(c=>c.status==='open'));
 assert.equal(gs.createGoal('x').criteria.length>=2,true,'even a terse goal keeps its own text plus verification');
});

test('argument grammar separates subcommands from goal text',()=>{
 assert.deepEqual(gs.parseGoalArgs(''),{kind:'status'});
 assert.deepEqual(gs.parseGoalArgs('pause'),{kind:'pause'});
 assert.deepEqual(gs.parseGoalArgs('stop'),{kind:'clear'});
 assert.deepEqual(gs.parseGoalArgs('retry'),{kind:'retry'});
 assert.deepEqual(gs.parseGoalArgs('criteria tests pass; docs updated'),{kind:'criteria',items:['tests pass','docs updated']});
 assert.deepEqual(gs.parseGoalArgs('clear the cache directory and rebuild'),{kind:'set',text:'clear the cache directory and rebuild'},'a goal that merely starts with a subcommand word stays a goal');
});

test('evidence must describe an observation; vague completion claims are refused',()=>{
 const goal=gs.createGoal('Fix the login redirect and add a test');
 assert.match(gs.recordEvidence(goal,'C1','met','done').error,/observed/);
 assert.match(gs.recordEvidence(goal,'C1','met','it works great now for sure').error,/observed/);
 assert.match(gs.recordEvidence(goal,'C9','met','npm test passed 3/3').error,/No criterion/);
 assert.equal(gs.recordEvidence(goal,'c1','met','npm test: 3 passed, exit 0').goal.criteria[0].status,'met');
 assert.equal(gs.recordEvidence(goal,'C1','waived','superseded by the existing redirect helper').error,undefined,'a waiver only needs a reason');
});

test('criteria replacement keeps settled records and always keeps verification',()=>{
 let goal=gs.createGoal('Ship the exporter');
 goal=met(goal,'C1');
 goal=gs.setCriteria(goal,['export CSV with header','export handles unicode']);
 assert.equal(goal.criteria[0].status,'met');
 assert.deepEqual(goal.criteria.filter(c=>c.status==='open').map(c=>c.text),['export CSV with header','export handles unicode',goal.criteria.at(-1).text]);
 assert.equal(goal.criteria.at(-1).id,'V');
 assert.equal(new Set(goal.criteria.map(c=>c.id)).size,goal.criteria.length,'ids stay unique');
});

test('a full criteria list still keeps the verification criterion',()=>{
 let goal=gs.createGoal('Ship the exporter');
 goal=met(goal,'C1');
 goal=gs.setCriteria(goal,Array.from({length:gs.MAX_CRITERIA-1},(_,i)=>`refined requirement ${i+1}`));
 assert.equal(goal.criteria.length,gs.MAX_CRITERIA);
 assert.equal(goal.criteria.at(-1).id,'V','verification survives a list that fills the cap');
 assert.equal(goal.criteria.filter(c=>c.status==='open').length,gs.MAX_CRITERIA-1);
 // Even when settled records alone overflow the cap, verification outranks them.
 const crowded={...goal,criteria:goal.criteria.map(c=>c.id==='V'?{...c,status:'open'}:{...c,status:'met',evidence:'npm test: 12 passed, exit 0'})};
 const trimmed=gs.setCriteria(crowded,['one more requirement']);
 assert.ok(trimmed.criteria.length<=gs.MAX_CRITERIA,`capped at ${gs.MAX_CRITERIA}, got ${trimmed.criteria.length}`);
 assert.equal(trimmed.criteria.at(-1).id,'V','verification outranks trimmed settled records');
 assert.equal(new Set(trimmed.criteria.map(c=>c.id)).size,trimmed.criteria.length,'ids stay unique when the list is trimmed');
});

test('completion is refused once for open criteria and unverified writes, then becomes a recorded waiver',()=>{
 const goal=gs.createGoal('Ship the exporter');
 const refused=new Set();
 const first=gs.goalCompletionGate(goal,{unverifiedWrites:0,refused});
 assert.equal(first.block,true);
 assert.match(first.reason,/C1 open/);
 refused.add(first.key);
 const second=gs.goalCompletionGate(goal,{unverifiedWrites:0,refused});
 assert.equal(second.block,false);assert.equal(second.waived,true);
 const done=settleAll(goal);
 assert.equal(gs.goalCompletionGate(done,{unverifiedWrites:0,refused:new Set()}).block,false);
 const stale=gs.goalCompletionGate(done,{unverifiedWrites:3,refused:new Set()});
 assert.equal(stale.block,true);assert.match(stale.reason,/3 file change/);
});

test('the stop gate continues only a clean stop, and never loops without new evidence',()=>{
 const goal=gs.createGoal('Ship the exporter');
 const idle={lastStop:'stop',hasPendingMessages:false};
 assert.equal(gs.stopGate(undefined,idle),undefined);
 assert.equal(gs.stopGate({...goal,status:'paused'},idle),undefined);
 assert.equal(gs.stopGate(goal,{...idle,hasPendingMessages:true}),undefined,'queued user input wins');
 assert.equal(gs.stopGate(goal,{lastStop:'error',hasPendingMessages:false}),undefined,'provider errors are recovered elsewhere, not nudged');
 const aborted=gs.stopGate(goal,{lastStop:'aborted',hasPendingMessages:false});
 assert.equal(aborted.goal.status,'paused');assert.equal(aborted.nudge,undefined,'an interrupt pauses instead of fighting the user');

 let state=goal,sent=0;
 for(let i=0;i<10&&state.status==='active';i++){
  const decision=gs.stopGate(state,idle);
  state=decision.goal;
  if(decision.nudge)sent++;
 }
 assert.equal(state.status,'blocked');
 assert.ok(sent<=gs.MAX_STALLS,`a session that records no evidence is stopped after ${gs.MAX_STALLS} continuations, sent ${sent}`);
 assert.match(state.note,/No new evidence/);
});

test('evidence between continuations keeps the goal running up to the budget, then hands back',()=>{
 let state=gs.createGoal('a\n- b\n- c\n- d\n- e\n- f\n- g');
 const idle={lastStop:'stop',hasPendingMessages:false};
 let continuations=0;
 for(const criterion of [...state.criteria]){
  const decision=gs.stopGate(state,idle);
  if(decision.nudge){continuations++;state=decision.goal;state=met(state,criterion.id);}
  else break;
 }
 assert.ok(continuations>=1);
 assert.ok(continuations<=gs.MAX_NUDGES);
 const final=gs.stopGate({...state,nudges:gs.MAX_NUDGES,progressMark:'x'},idle);
 assert.equal(final.goal.status,'blocked');assert.match(final.notice.text,/retry/);
 const closing=gs.stopGate(settleAll(gs.createGoal('Ship it')),idle);
 assert.match(closing.nudge,/goal\(\{action:"complete"/);
});

test('the anchor and kickoff are compact and the discovery marker stages the goal tool',()=>{
 const goal=gs.createGoal('Rebuild the pricing page so it loads in under a second');
 assert.equal(gs.goalAnchor({...goal,status:'paused'}),undefined);
 const anchor=gs.goalAnchor(goal);
 assert.match(anchor,/\[ \] C1/);assert.ok(anchor.length<1_200);
 assert.deepEqual(intentBundleTools(gs.goalKickoff(goal)),['goal']);
 assert.deepEqual(intentBundleTools('Please explain the goal of this module'),[],'ordinary prompts never stage it');
});

test('persisted snapshots restore the latest goal on a branch',()=>{
 const a=gs.createGoal('first');const b={...met(gs.createGoal('second'),'C1'),id:'gb'};
 const entries=[{type:'custom',customType:'goal-state-v1',data:a},{type:'message'},{type:'custom',customType:'goal-state-v1',data:b}];
 assert.equal(gs.restoreGoal(entries).id,'gb');
 assert.equal(gs.restoreGoal([{type:'custom',customType:'other',data:a}]),undefined);
});

function harness({failSend=false}={}){
 const handlers={},commands={},tools={},entries=[],sent=[],notes=[];
 const pi={
  on:(name,fn)=>{(handlers[name]??=[]).push(fn);},
  registerCommand:(name,options)=>{commands[name]=options;},
  registerTool:(tool)=>{tools[tool.name]=tool;},
  appendEntry:(customType,data)=>{entries.push({type:'custom',customType,data});},
  sendUserMessage:async(text)=>{if(failSend)throw new Error('input queue closed');sent.push(text);},
  getActiveTools:()=>['read'],setActiveTools:()=>{},
 };
 const ctx={ui:{notify:(text,level)=>notes.push({text,level}),setStatus:()=>{}},sessionManager:{getBranch:()=>entries},hasPendingMessages:()=>false};
 goalExtension(pi);
 const emit=async(name,event={})=>{for(const fn of handlers[name]??[])await fn(event,ctx);};
 const call=(params)=>tools.goal.execute('id',params,undefined,undefined,ctx).then(r=>r.content[0].text);
 return {commands,entries,sent,notes,emit,call,ctx};
}

test('/goal drives a session: kickoff, evidence-gated completion, and a bounded continuation',async()=>{
 const h=harness();
 await h.commands.goal.handler('Make the exporter handle unicode and add tests',h.ctx);
 assert.equal(h.sent.length,1);assert.match(h.sent[0],/^\[goal-tracked/);
 assert.match(await h.call({action:'complete'}),/refused/);
 // A finished answer with open criteria is continued, not accepted.
 await h.emit('message_end',{message:{role:'assistant',stopReason:'stop'}});
 await h.emit('agent_settled');
 assert.equal(h.sent.length,2);assert.match(h.sent[1],/continuation 1/);
 // Context carries the definition of done every turn, and only one copy.
 const first=(await h.emit('context',{messages:[]}),undefined);
 // Record evidence for everything; edits since verification block completion.
 const state=()=>h.entries.at(-1).data;
 for(const criterion of state().criteria)assert.match(await h.call({action:'met',id:criterion.id,evidence:'npm test: 9 passed, exit 0'}),/Recorded/);
 await h.emit('tool_result',{toolName:'edit',input:{path:'a.ts'}});
 assert.match(await h.call({action:'complete'}),/1 file change/);
 await h.emit('tool_result',{toolName:'bash',input:{command:'npm test'}});
 assert.match(await h.call({action:'complete'}),/Goal achieved/);
 assert.equal(state().status,'achieved');
 await h.emit('agent_settled');
 assert.equal(h.sent.length,2,'an achieved goal never continues');
});

test('an interrupt pauses the goal and blocked reports reach the user without another turn',async()=>{
 const h=harness();
 await h.commands.goal.handler('Ship the exporter',h.ctx);
 await h.emit('message_end',{message:{role:'assistant',stopReason:'aborted'}});
 await h.emit('agent_settled');
 assert.equal(h.entries.at(-1).data.status,'paused');
 assert.equal(h.sent.length,1);
 await h.commands.goal.handler('resume',h.ctx);
 assert.equal(h.sent.length,2);
 assert.match(await h.call({action:'blocked',reason:'need the production API key'}),/blocked/);
 await h.emit('message_end',{message:{role:'assistant',stopReason:'stop'}});
 await h.emit('agent_settled');
 assert.equal(h.sent.length,2,'a blocked goal waits for the user');
 assert.match(h.notes.at(-1).text,/Goal blocked/);
});

test('a background run settles its own debt: starting one verifies nothing, finishing green does',async()=>{
 // Each assertion needs its own goal: a refused completion keys the gate, and a
 // second identical call is a deliberate recorded waiver rather than a re-refusal.
 async function settled(command,details){
  const h=harness();
  await h.commands.goal.handler('Ship the exporter',h.ctx);
  for(const criterion of h.entries.at(-1).data.criteria)await h.call({action:'met',id:criterion.id,evidence:'npm test: 9 passed, exit 0'});
  await h.emit('tool_result',{toolName:'edit',input:{path:'a.ts'}});
  if(command!==null)await h.emit('tool_result',{toolName:'bg_run',input:{command}});
  if(details)await h.emit('message_end',{message:{role:'custom',customType:'background-task-notification',details}});
  return h.call({action:'complete'});
 }
 assert.match(await settled('pnpm test',null),/1 file change/,'a launched background run leaves the debt intact');
 assert.match(await settled('pnpm test',{status:'failed',exitCode:1,command:'pnpm test'}),/1 file change/,'a failed background run is not verification');
 assert.match(await settled('pnpm test',{status:'killed',command:'pnpm test'}),/1 file change/,'a killed background run is not verification');
 assert.match(await settled('pnpm test',{status:'completed',exitCode:0,command:'pnpm test'}),/Goal achieved/,'a green background check clears the debt');
 assert.match(await settled('npm install',{status:'completed',exitCode:0,command:'npm install'}),/1 file change/,'an unrelated green background job is not verification');
 assert.match(await settled('pnpm test',{status:'completed',exitCode:0,command:'pnpm test'}),/Goal achieved/);
});

test('a spent waiver does not carry over to a later, unrelated gap',async()=>{
 const h=harness();
 await h.commands.goal.handler('Ship the exporter',h.ctx);
 const state=()=>h.entries.at(-1).data;
 for(const criterion of state().criteria)await h.call({action:'met',id:criterion.id,evidence:'npm test: 9 passed, exit 0'});
 // One edit, refused, then deliberately waived: the documented "repeat the call" path.
 await h.emit('tool_result',{toolName:'edit',input:{path:'a.ts'}});
 assert.match(await h.call({action:'complete'}),/1 file change/);
 assert.match(await h.call({action:'complete'}),/recorded waiver/);
 assert.equal(state().status,'achieved');
 // A later goal in the same session must refuse a fresh unverified edit, not inherit it.
 await h.commands.goal.handler('Ship the importer',h.ctx);
 for(const criterion of state().criteria)await h.call({action:'met',id:criterion.id,evidence:'npm test: 9 passed, exit 0'});
 await h.emit('tool_result',{toolName:'edit',input:{path:'b.ts'}});
 assert.match(await h.call({action:'complete'}),/1 file change/,'a fresh unverified edit is refused, not waived by an older approval');
 // And within one goal, a second gap of the same shape after re-verification is also fresh.
 const h2=harness();
 await h2.commands.goal.handler('Ship the exporter',h2.ctx);
 for(const criterion of h2.entries.at(-1).data.criteria)await h2.call({action:'met',id:criterion.id,evidence:'npm test: 9 passed, exit 0'});
 await h2.emit('tool_result',{toolName:'edit',input:{path:'a.ts'}});
 assert.match(await h2.call({action:'complete'}),/1 file change/);
 assert.match(await h2.call({action:'complete'}),/recorded waiver/);
 // Resume re-arms the same goal; a fresh unverified edit must refuse again rather
 // than inherit the waiver that closed it.
 await h2.commands.goal.handler('resume',h2.ctx);
 await h2.emit('tool_result',{toolName:'bash',input:{command:'npm test'}});
 await h2.emit('tool_result',{toolName:'edit',input:{path:'a.ts'}});
 assert.match(await h2.call({action:'complete'}),/1 file change/,'the spent waiver does not re-open the gate');
});

test('a continuation that cannot be sent is reported, not swallowed',async()=>{
 const h=harness({failSend:true});
 await h.commands.goal.handler('Ship the exporter',h.ctx);
 assert.equal(h.sent.length,0,'the kickoff itself failed too, and reported it');
 assert.match(h.notes.at(-1).text,/Goal kickoff failed: input queue closed/);
 await h.emit('message_end',{message:{role:'assistant',stopReason:'stop'}});
 await h.emit('agent_settled');
 // The run settled with criteria open, so the harness claimed it was continuing.
 assert.ok(h.notes.some(n=>/continuing \(1\)/.test(n.text)),'the harness announced the continuation');
 // The claim must be followed by the truth: the nudge never left the harness.
 assert.match(h.notes.at(-1).text,/could not continue \(input queue closed\)/);
 assert.match(h.notes.at(-1).text,/criteria are still open; \/goal resume restarts it/);
 assert.equal(h.entries.at(-1).data.nudges,1,'the attempt is still counted, and the stall gate still bounds it');
});
