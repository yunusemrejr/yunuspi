// Native read must share edit/write's existing per-file queue: fs.writeFile
// truncates before filling, so otherwise parallel reads can observe empty bytes.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const MARKER='PI_NATIVE_READ_MUTATION_QUEUE';
const IMPORT='import { withFileMutationQueue } from "./file-mutation-queue.js";\n';
const queueName=source=> /function createEditToolDefinition\([\s\S]{0,5000}?return (withFileMutationQueue\d*)\(absolutePath,/.exec(source)?.[1] ?? 'withFileMutationQueue';
const opening=source=>'await '+queueName(source)+'(absolutePath, async () => { /* '+MARKER+' */';
const CLOSE='}); /* PI_NATIVE_READ_QUEUE_END */';
function region(source){
 const begin=source.indexOf('function createReadToolDefinition(');
 const rest=source.slice(begin+1).search(/(?:export )?function createReadTool\d*\(/);
 if(begin<0 || rest<0 || source.indexOf('function createReadToolDefinition(',begin+1)>=0)throw Error('Native read owner drift');
 return {begin,end:begin+1+rest};
}
export function isAppliedSource(source){
 try {
  const {begin,end}=region(source),body=source.slice(begin,end);
  return body.split(opening(source)).length===2 && body.split(CLOSE).length===2
   && source.split(MARKER).length===2 && source.split('PI_NATIVE_READ_QUEUE_END').length===2
   && /(?:function withFileMutationQueue\d*\(|import \{ withFileMutationQueue \})/.test(source);
 }catch{return false;}
}
export function patchSource(source){
 if(isAppliedSource(source))return source;
 if(source.includes(MARKER)||source.includes('PI_NATIVE_READ_QUEUE_END'))throw Error('Native read queue patch partial/drifted');
 const {begin,end}=region(source);let body=source.slice(begin,end);
 const start=/(const|let) absolutePath\s*=\s*await resolveReadPathAsync\([^;]+;/;
 const finish=/(resolve\d*\(\{\s*content,\s*details\s*\}\);?)/;
 if([...body.matchAll(new RegExp(start,'g'))].length!==1 || [...body.matchAll(new RegExp(finish,'g'))].length!==1)throw Error('Native read queue execution anchor drift');
 body=body.replace(start,match=>match+opening(source)).replace(finish,match=>match+CLOSE);
 let next=source.slice(0,begin)+body+source.slice(end);
 if(!new RegExp('function '+queueName(source)+'\\(').test(next)){
  if(next.includes('./file-mutation-queue.js'))throw Error('Native read queue import drift');
  next=IMPORT+next;
 }
 if(!isAppliedSource(next))throw Error('Native read queue postcondition failed');
 return next;
}
export function targets(){
 const core=process.env.PI_HARNESS_PATCH_TEST_CORE??path.join(execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'@earendil-works/pi-coding-agent');
 const bundle=path.join(core,'dist/bundle');
 const owners=fs.readdirSync(bundle,{recursive:true}).filter(file=>file.endsWith('.js')).map(file=>path.join(bundle,file)).filter(file=>fs.readFileSync(file,'utf8').includes('function createReadToolDefinition('));
 if(owners.length!==1)throw Error('Expected one bundled native read owner');
 return [path.join(core,'dist/core/tools/read.js'),...owners].map(file=>({name:'native read/mutation queue '+path.relative(core,file),exists:()=>fs.existsSync(file),isApplied:()=>isAppliedSource(fs.readFileSync(file,'utf8')),apply(){const old=fs.readFileSync(file,'utf8'),next=patchSource(old);if(old===next)return;execFileSync(process.execPath,['--input-type=module','--check'],{input:next,stdio:['pipe','pipe','pipe']});fs.writeFileSync(file,next);}}));
}
