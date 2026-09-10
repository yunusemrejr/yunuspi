function instrumentHook(handler, hook, extensionPath) {
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
}
