import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
export const wrapper=fs.readFileSync(new URL('./hook-metrics-wrapper.js',import.meta.url),'utf8').trim();
// The previous payload is retained solely for an exact, fail-closed V1 upgrade.
// Never accept an arbitrary marker: edited or partially installed code is drift.
export const legacyWrapper=String.raw`function instrumentHook(handler, hook, extensionPath) {
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
const registration=(body,bundled,version)=>bundled?`list2.push((${body})(handler,event,extension.path)),extension.handlers.set(event,list2)/* PI_HOOK_METRICS_V${version} */`:`list.push((${body})(handler,event,extension.path));\n            extension.handlers.set(event, list); /* PI_HOOK_METRICS_V${version} */`;
export function transform(source,bundled=false){
 const old=bundled?'list2.push(handler),extension.handlers.set(event,list2)':'list.push(handler);\n            extension.handlers.set(event, list);';
 const next=registration(wrapper,bundled,2);
 if(source.includes('PI_HOOK_METRICS_V2')){if(source.split(next).length!==2||source.includes('PI_HOOK_METRICS_V1'))throw Error('hook metrics postcondition drift');return source;}
 if(source.includes('PI_HOOK_METRICS_V1')){
  const previous=registration(legacyWrapper,bundled,1);
  if(source.split(previous).length!==2)throw Error('hook metrics V1 migration drift');
  return source.replace(previous,()=>next);
 }
 if(source.split(old).length!==2)throw Error('hook metrics registration anchor drift');
 return source.replace(old,()=>next);
}
export function targets(){
 const core=process.env.PI_HARNESS_PATCH_TEST_CORE??path.join(execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'@earendil-works/pi-coding-agent');
 const chunks=path.join(core,'dist/bundle/chunks');
 const owners=fs.readdirSync(chunks).filter(n=>n.endsWith('.js')).map(n=>path.join(chunks,n)).filter(p=>fs.readFileSync(p,'utf8').includes('extension.handlers.get(event)'));
 if(owners.length!==1)throw Error('hook metrics requires one CLI owner');
 const defs=[[path.join(core,'dist/core/extensions/loader.js'),false],[owners[0],true]];
 return defs.map(([file,bundled])=>({name:`hook metrics: ${path.relative(core,file)}`,file,exists:()=>fs.existsSync(file),isApplied(){const s=fs.readFileSync(file,'utf8');return s.includes('PI_HOOK_METRICS_V2')&&transform(s,bundled)===s;},apply(){for(const [p,b]of defs)transform(fs.readFileSync(p,'utf8'),b);const s=fs.readFileSync(file,'utf8'),n=transform(s,bundled);if(n!==s)fs.writeFileSync(file,n);}}));
}
