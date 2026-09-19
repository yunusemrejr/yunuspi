import {resolveOwnedCore} from '../lib/owned-core.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {createCompletionNotifier} from '../../extensions/pi-background-tasks/src/core/completion-wake.ts';
const core=resolveOwnedCore();
const owners=[core+'/dist/core/extensions/runner.js'];
for(const file of owners){
 const source=fs.readFileSync(file,'utf8');
 const method=source.slice(source.indexOf('async emitBeforeProviderRequest('),source.indexOf('async emitBeforeProviderHeaders('));
 const Class=vm.runInNewContext(`(class{${method}})`);
 for(const mode of ['before','during','throws','ordinary','success']){
  const controller=new AbortController();let later=0,errors=0;
  const host=new Class();host.createContext=()=>({signal:controller.signal});host.emitError=()=>errors++;
  host.extensions=[{path:'fixture',handlers:new Map([['before_provider_request',[
   async event=>{if(mode==='during'||mode==='throws'){controller.abort();if(mode==='throws')throw Error('hook cancelled');}if(mode==='ordinary')throw Error('ordinary');return {...event.payload,changed:true};},
   async()=>{later++;}
  ]]])}];
  if(mode==='before')controller.abort();
  if(['before','during','throws'].includes(mode)){
   await assert.rejects(host.emitBeforeProviderRequest({model:'mock'}));assert.equal(later,0);assert.equal(errors,0);
  }else{const result=await host.emitBeforeProviderRequest({model:'mock'});assert.equal(later,1);assert.equal(errors,mode==='ordinary'?1:0);assert.equal(result.changed,mode==='success'?true:undefined);}
 }
}
function fixture(){
 const handlers=new Map(),sent=[];let idle=false,fail=false;
 const ctx={isIdle:()=>idle,sessionManager:{getBranch:()=>[]}};
 const pi={on:(name,fn)=>handlers.set(name,fn),sendMessage:(m,o)=>{if(fail&&o.triggerTurn)throw Error('transient delivery');sent.push({m,o});}};
 const notify=createCompletionNotifier(pi,()=>ctx);
 const emit=(name,event={})=>handlers.get(name)?.(event,ctx);
 emit('session_start');
 return {notify,emit,sent,idle:()=>idle=true,fail:value=>fail=value};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
{
 const f=fixture();f.notify({content:'result'},{triggerTurn:true});f.emit('session_compact_failed');f.idle();f.emit('agent_settled');assert.equal(f.sent.length,1);
 f.emit('session_compact');await tick();assert.equal(f.sent.filter(x=>x.o.triggerTurn).length,1);f.emit('agent_settled');assert.equal(f.sent.length,2);
}
{
 const f=fixture();f.notify({content:'result'},{triggerTurn:true});f.emit('message_end',{message:{role:'assistant',stopReason:'aborted'}});f.idle();f.emit('session_compact');await tick();assert.equal(f.sent.length,1,'compaction cannot override Stop');
 f.emit('session_shutdown');f.notify({content:'late'},{triggerTurn:true});assert.equal(f.sent.length,1,'shutdown ignores late callbacks');
}
{
 const f=fixture();f.notify({content:'result'},{triggerTurn:true});f.idle();f.fail(true);f.emit('agent_settled');f.fail(false);f.emit('agent_settled');assert.equal(f.sent.filter(x=>x.o.triggerTurn).length,1,'failed delivery remains pending');
}
console.log('PASS SDK/CLI hook cancellation, payload chaining, ordinary-error isolation, completion/compaction handoff, Stop, shutdown, delivery retry');
