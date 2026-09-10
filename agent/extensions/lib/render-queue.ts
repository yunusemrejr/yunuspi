/** Bounded FIFO per extension instance. Stop removes queued work immediately. */
export function createRenderQueue(maxWaiting=4) {
 let active=false;
 const waiting:{resolve:(release:()=>void)=>void;reject:(error:Error)=>void;signal?:AbortSignal;abort:()=>void;timer:ReturnType<typeof setTimeout>}[]=[];
 function release(){
  const next=waiting.shift();
  if(!next){active=false;return;}
  clearTimeout(next.timer);next.signal?.removeEventListener('abort',next.abort);
  let done=false;next.resolve(()=>{if(!done){done=true;release();}});
 }
 return async(signal?:AbortSignal):Promise<()=>void>=>{
  signal?.throwIfAborted();
  if(!active){active=true;let done=false;return ()=>{if(!done){done=true;release();}};}
  if(waiting.length>=maxWaiting)throw Error('Render queue full; finish existing render requests before adding more.');
  return new Promise((resolve,reject)=>{
   const item:any={resolve,reject,signal};
   item.abort=()=>{const i=waiting.indexOf(item);if(i<0)return;waiting.splice(i,1);clearTimeout(item.timer);signal?.removeEventListener('abort',item.abort);reject(signal?.aborted?new Error('Render cancelled while queued'):new Error('Render queue wait exceeded 120 seconds'));};
   item.timer=setTimeout(item.abort,120000);item.timer.unref?.();waiting.push(item);signal?.addEventListener('abort',item.abort,{once:true});
  });
 };
}
