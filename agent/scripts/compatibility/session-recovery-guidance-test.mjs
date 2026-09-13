import assert from 'node:assert/strict';
import register, {buildCompletionDetails,formatSingleCompletion} from '../../extensions/pi-subagents/src/runs/background/notify.ts';
import {formatSubagentExtensionConflictError} from '../../extensions/pi-subagents/src/runs/shared/subagent-startup-retry.ts';
import {createRelevantGuidance} from '../../extensions/lib/relevant-guidance.ts';
import {register as registerLoader} from 'node:module';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const core=execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim()+'/@earendil-works/pi-coding-agent';
const aliases=Object.fromEntries(['pi-coding-agent','pi-agent-core','pi-ai','pi-tui'].map(name=>['@earendil-works/'+name,pathToFileURL(name==='pi-coding-agent'?core+'/dist/index.js':core+'/node_modules/@earendil-works/'+name+'/dist/index.js').href]));
aliases['@earendil-works/pi-ai/compat']=pathToFileURL(core+'/node_modules/@earendil-works/pi-ai/dist/compat.js').href;
registerLoader('data:text/javascript,'+encodeURIComponent(`export function resolve(n,c,next){const aliases=${JSON.stringify(aliases)};return aliases[n]?{url:aliases[n],shortCircuit:true}:next(n,c);}`),import.meta.url);
const {createSubagentExecutor}=await import('../../extensions/pi-subagents/src/runs/foreground/subagent-executor.ts');
const failure={id:'workflow',runId:'workflow',agent:'workflow',mode:'workflow',success:true,state:'complete',sessionId:'session',completionOwnerId:'owner',summary:'Script returned normally',results:[{runId:'good',success:true,output:'Useful report'},{runId:'bad',success:false,error:'Model "fixture" not found',output:''}]};
const details=buildCompletionDetails(failure);
assert.equal(details.status,'failed');
const text=formatSingleCompletion(details);assert.match(text,/Model "fixture" not found/);assert.match(text,/Preserve successful outputs/);assert.match(text,/Useful report/);
assert.equal(buildCompletionDetails({...failure,results:[failure.results[0]]}).status,'completed');
assert.equal(buildCompletionDetails({...failure,stopped:true}).status,'stopped');
assert.doesNotMatch(buildCompletionDetails({...failure,stopped:true}).resultPreview,/Child recovery needed/);
const messages=[];
const notifier=register({events:{on:()=>()=>{}},sendMessage:(message,options)=>messages.push({message,options})},{currentSessionId:'session',completionOwnerId:'owner'});
try {
 assert.equal(await notifier.deliver(failure),true);
 assert.equal(messages.length,1);assert.equal(messages[0].message.display,true);assert.equal(messages[0].options.triggerTurn,true);
 await notifier.deliver(failure);assert.equal(messages.length,1,'same completion does not create a retry loop');
 assert.equal(await notifier.deliver({...failure,id:'other',runId:'other',sessionId:'different'}),false);
}finally{notifier.dispose();}
const conflict=formatSubagentExtensionConflictError('Failed to load extension "a": Tool "dependency_plan" conflicts with b',{agent:'reviewer',ambientExtensionsEnabled:true});
assert.match(conflict,/Do not disable ambient discovery/);assert.doesNotMatch(conflict,/"extensions":\[\]/);
// Keep the bounded two-hint fixture focused on the delegation contract; the
// renderer priority has its own coverage in relevant-guidance-test.mjs.
const g=createRelevantGuidance({getActiveTools:()=>['read','subagent']});
const ctx={cwd:'/tmp',sessionManager:{getEntries:()=>[]}};g.restore(ctx);
g.start({prompt:'Use subagents to refine aesthetics of the landing page, like animations',systemPrompt:'<available_skills><skill><name>product-ui-verification</name><description>UI verification</description><location>/skills/ui/SKILL.md</location></skill></available_skills>'},ctx);
assert.ok(g.candidates().some(h=>h.skill==='/skills/ui/SKILL.md'));
assert.ok(g.candidates().some(h=>h.key==='delegation-contract'));
const request={prompt:'Refine the landing page',systemPrompt:'<available_skills><skill><name>product-ui-verification</name><description>UI verification</description><location>/skills/ui/SKILL.md</location></skill></available_skills>'};
g.commit(g.candidates());g.start(request,ctx);assert.ok(!g.candidates().some(h=>h.skill),'background continuation stays deduplicated');
g.userInput();g.start(request,ctx);assert.ok(g.candidates().some(h=>h.skill),'new user request can remind an unread skill');
g.record({toolName:'read',input:{path:'/skills/ui/SKILL.md'},isError:false});g.userInput();g.start(request,ctx);assert.ok(!g.candidates().some(h=>h.skill),'actual skill reads remain deduplicated');

// Real executor boundary: invalid code must return an error before discovery,
// mutation, job creation or launch; access to other dependencies fails the test.
const executor=createSubagentExecutor({state:{},config:{},pi:{},discoverAgents:()=>{throw Error('must not discover or launch');}});
for(const async of [true,false]) {
 const result=await executor.execute('invalid',{async,workflowScript:'const broken = `oops'},new AbortController().signal,undefined,{cwd:'/tmp'});
 assert.equal(result.isError,true);assert.match(result.content[0].text,/before child launch; no children launched/);
}
console.log('PASS partial-failure wake/diagnostics/dedup/ownership/Stop, safe startup repair advice, UI delegation guidance, prelaunch workflow validation');
