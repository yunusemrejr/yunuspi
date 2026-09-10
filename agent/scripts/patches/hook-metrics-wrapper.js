function instrumentHook(handler, hook, extensionPath) {
 // Count decision/check boundaries, not every streamed token, UI notification,
 // lifecycle observer or the telemetry observer itself. Keep this list aligned
 // with session-metrics.ts so pre-V2 history is interpreted by the same contract.
 if(!['input','before_agent_start','context','before_provider_request','tool_call','tool_result','session_before_switch','session_before_fork','session_before_compact','session_before_tree'].includes(hook))return handler;
 const parts=String(extensionPath).replace(/\\/g,'/').split('/');
 let owner=parts.at(-1);
 if(owner==='index.ts'||owner==='index.js'){
  parts.pop();while(['dist','build','lib','src'].includes(parts.at(-1)))parts.pop();owner=parts.at(-1)||'unknown';
 }
 if(owner==='health-log.ts'||owner==='session-telemetry.ts')return handler;
 const size=value=>{
  let total=0,nodes=0;const stack=[value],seen=new Set();
  while(stack.length){const x=stack.pop();if(++nodes>100000)return undefined;if(typeof x==='string')total+=x.length;else if(x&&typeof x==='object'&&!seen.has(x)){seen.add(x);const values=Array.isArray(x)?x:Object.values(x);if(values.length+stack.length+nodes>100000)return undefined;for(const v of values)stack.push(v);}}
  return total;
 };
 return async function(...args){
  const sink=globalThis[Symbol.for('yunus-pi.metrics.v1')];
  if(typeof sink!=='function')return handler.apply(this,args);
  const started=performance.now(),event=args[0];
  const input=hook==='context'?event?.messages:hook==='before_provider_request'?event?.payload:undefined;
  let before;try{if(input!==undefined)before=size(input);}catch{}
  let result,error=false;
  try{result=await handler.apply(this,args);return result;}catch(e){error=true;throw e;}finally{
   try{
    const after=before===undefined?undefined:size(hook==='context'?(result?.messages??input):(result??input));
    sink('hook',{owner,hook,ms:performance.now()-started,error,changed:result!==undefined,removedChars:before!==undefined&&after!==undefined?Math.max(0,before-after):0,addedChars:before!==undefined&&after!==undefined?Math.max(0,after-before):0});
   }catch{}
  }
 };
}
