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

function harness(){
 const handlers={},commands={},tools={},entries=[],sent=[],notes=[];
 const pi={
  on:(name,fn)=>{(handlers[name]??=[]).push(fn);},
  registerCommand:(name,options)=>{commands[name]=options;},
  registerTool:(tool)=>{tools[tool.name]=tool;},
  appendEntry:(customType,data)=>{entries.push({type:'custom',customType,data});},
  sendUserMessage:async(text)=>{sent.push(text);},
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
