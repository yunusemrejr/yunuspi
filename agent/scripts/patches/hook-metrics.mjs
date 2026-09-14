import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
export const wrapper=fs.readFileSync(new URL('./hook-metrics-wrapper.js',import.meta.url),'utf8').trim();
// Retained payloads are for exact, fail-closed upgrades only (V1->V2->V3).
// Never accept an arbitrary marker: edited or partially installed code is
// drift. Installed copies are byte-frozen at apply time, so legacy payloads
// stay verbatim (never reformatted).
export const legacyWrapperV1=String.raw`function instrumentHook(handler, hook, extensionPath) {
 const parts=String(extensionPath).replace(/\\/g,'/').split('/');
 const owner=parts.at(-1)==='index.ts'||parts.at(-1)==='index.js'?parts.at(-2):parts.at(-1);
 const size=value=>{
  let total=0,nodes=0;const stack=[value],seen=new Set();
  while(stack.length){const x=stack.pop();if(++nodes>100000)return undefined;if(typeof x==='string')total+=x.length;else if(x&&typeof x==='object'&&!seen.has(x)){seen.add(x);if(Array.isArray(x))stack.push(...x);else for(const v of Object.values(x))stack.push(v);}}
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
}`;
export const legacyWrapperV2=String.raw`function instrumentHook(handler, hook, extensionPath) {
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
}`;
export const legacyWrapperV3=String.raw`function instrumentHook(handler, hook, extensionPath) {
 // Count decision/check boundaries, not every streamed token, UI notification,
 // lifecycle observer or the telemetry observer itself. Keep this list aligned
 // with session-metrics.ts so pre-V2 history is interpreted by the same contract.
 if (
  ![
   "input",
   "before_agent_start",
   "context",
   "before_provider_request",
   "tool_call",
   "tool_result",
   "session_before_switch",
   "session_before_fork",
   "session_before_compact",
   "session_before_tree",
  ].includes(hook)
 )
  return handler;
 const parts = String(extensionPath).replace(/\\/g, "/").split("/");
 let owner = parts.at(-1);
 if (owner === "index.ts" || owner === "index.js") {
  parts.pop();
  while (["dist", "build", "lib", "src"].includes(parts.at(-1))) parts.pop();
  owner = parts.at(-1) || "unknown";
 }
 if (owner === "health-log.ts" || owner === "session-telemetry.ts")
  return handler;
 const size = (value) => {
  let total = 0,
   nodes = 0;
  const stack = [value],
   seen = new Set();
  while (stack.length) {
   const x = stack.pop();
   if (++nodes > 100000) return undefined;
   if (typeof x === "string") total += x.length;
   else if (x && typeof x === "object" && !seen.has(x)) {
    seen.add(x);
    const values = Array.isArray(x) ? x : Object.values(x);
    if (values.length + stack.length + nodes > 100000) return undefined;
    for (const v of values) stack.push(v);
   }
  }
  return total;
 };
 return async function (...args) {
  const sink = globalThis[Symbol.for("yunus-pi.metrics.v1")];
  if (typeof sink !== "function") return handler.apply(this, args);
  const started = performance.now(),
   event = args[0];
  // Stable per-dispatch event id. The runner creates ONE ctx per dispatch and
  // passes it to every handler, so ctx identity is a true dispatch handle; a
  // WeakMap on a globalThis Symbol survives /reload and keeps loader + bundle
  // copies in agreement. toolCallId wins where present (stable across
  // processes), which is what makes 2x/3x execution detectable later.
  let eventId, seq;
  try {
   const reg =
    globalThis[Symbol.for("yunus-pi.dispatch.v1")] ||
    (globalThis[Symbol.for("yunus-pi.dispatch.v1")] = {
     seq: 0,
     ctxs: new WeakMap(),
    });
   const key =
    args[1] && typeof args[1] === "object"
     ? args[1]
     : event && typeof event === "object"
       ? event
       : reg;
   let cursor = reg.ctxs.get(key);
   if (cursor === undefined) {
    cursor = { id: ++reg.seq, n: 0 };
    reg.ctxs.set(key, cursor);
   }
   seq = ++cursor.n;
   const toolCallId = event?.toolCallId;
   eventId =
    typeof toolCallId === "string" && toolCallId ? toolCallId : "#" + cursor.id;
  } catch {}
  const input =
   hook === "context"
    ? event?.messages
    : hook === "before_provider_request"
      ? event?.payload
      : undefined;
  let before;
  try {
   if (input !== undefined) before = size(input);
  } catch {}
  let result,
   error = false;
  try {
   result = await handler.apply(this, args);
   return result;
  } catch (e) {
   error = true;
   throw e;
  } finally {
   try {
    const after =
     before === undefined
      ? undefined
      : size(
         hook === "context" ? (result?.messages ?? input) : (result ?? input),
        );
    sink("hook", {
     owner,
     hook,
     eventId,
     seq,
     ms: performance.now() - started,
     error,
     changed: result !== undefined,
     blocked: result?.block === true,
     removedChars:
      before !== undefined && after !== undefined
       ? Math.max(0, before - after)
       : 0,
     addedChars:
      before !== undefined && after !== undefined
       ? Math.max(0, after - before)
       : 0,
    });
   } catch {}
  }
 };
}`;
const registration=(body,bundled,version)=>bundled?`list2.push((${body})(handler,event,extension.path)),extension.handlers.set(event,list2)/* PI_HOOK_METRICS_V${version} */`:`list.push((${body})(handler,event,extension.path));\n            extension.handlers.set(event, list); /* PI_HOOK_METRICS_V${version} */`;
export function transform(source,bundled=false){
 const next=registration(wrapper,bundled,3);
 const prev=registration(legacyWrapperV3,bundled,3);
 const v2=registration(legacyWrapperV2,bundled,2);
 const v1=registration(legacyWrapperV1,bundled,1);
 const anchor=bundled?'list2.push(handler),extension.handlers.set(event,list2)':'list.push(handler);\n            extension.handlers.set(event, list);'
 if(source.includes('PI_HOOK_METRICS_V3')){
  // V3 payload upgrade (safe fingerprints added): exact previous V3 migrates;
  // anything else under a V3 marker is drift, never silently overwritten.
  if(source.split(next).length===2&&!source.includes('PI_HOOK_METRICS_V2')&&!source.includes('PI_HOOK_METRICS_V1'))return source;
  if(source.split(prev).length===2&&!source.includes('PI_HOOK_METRICS_V2')&&!source.includes('PI_HOOK_METRICS_V1')){
   source=source.replace(prev,()=>next);
   if(source.split(next).length!==2)throw Error('hook metrics postcondition drift');
   return source;
  }
  throw Error('hook metrics postcondition drift');
 }
 if(source.includes('PI_HOOK_METRICS_V1')){
  if(source.split(v1).length!==2||source.includes('PI_HOOK_METRICS_V2'))throw Error('hook metrics V1 migration drift');
  source=source.replace(v1,()=>v2);
 }
 if(source.includes('PI_HOOK_METRICS_V2')){
  if(source.split(v2).length!==2)throw Error('hook metrics V2 migration drift');
  source=source.replace(v2,()=>next);
 }else{
  if(source.split(anchor).length!==2)throw Error('hook metrics registration anchor drift');
  source=source.replace(anchor,()=>next);
 }
 if(source.split(next).length!==2)throw Error('hook metrics postcondition drift');
 return source;
}export function targets(){
 const core=process.env.PI_HARNESS_PATCH_TEST_CORE??path.join(execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'@earendil-works/pi-coding-agent');
 const chunks=path.join(core,'dist/bundle/chunks');
 const owners=fs.readdirSync(chunks).filter(n=>n.endsWith('.js')).map(n=>path.join(chunks,n)).filter(p=>fs.readFileSync(p,'utf8').includes('extension.handlers.get(event)'));
 if(owners.length!==1)throw Error('hook metrics requires one CLI owner');
 const defs=[[path.join(core,'dist/core/extensions/loader.js'),false],[owners[0],true]];
 return defs.map(([file,bundled])=>({name:`hook metrics: ${path.relative(core,file)}`,file,exists:()=>fs.existsSync(file),isApplied(){const s=fs.readFileSync(file,'utf8');return s.includes('PI_HOOK_METRICS_V3')&&transform(s,bundled)===s;},apply(){for(const [p,b]of defs)transform(fs.readFileSync(p,'utf8'),b);const s=fs.readFileSync(file,'utf8'),n=transform(s,bundled);if(n!==s)fs.writeFileSync(file,n);}}));
}
