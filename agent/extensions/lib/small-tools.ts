/** Post-edit SVG source check for saved .svg files. No subprocesses, installs, network, or writes. */
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {inspectSvg} from './svg-check.ts';
import {reviewSvg} from './svg-analysis.ts';

const disabled = () => process.env.PI_SMALL_TOOLS === 'off' || process.env.PI_REASONING_AIDS === 'off';
const TEXT_LIMIT = 65536, UI_LIMIT = 196608, IMAGE_LIMIT = 1048576;
const cancelled = (signal: any) => { if (signal?.aborted) throw Error('Cancelled'); };

async function readArtifact(file: unknown, cwd: unknown, limit: number, prefix: boolean, signal: any) {
  if (typeof file !== 'string' || !file || file.length > 1024 || typeof cwd !== 'string' || !cwd) throw Error('A workspace file path and cwd are required');
  cancelled(signal);
  const requested=path.resolve(cwd,file);
  const root = await fs.realpath(cwd), resolved = await fs.realpath(requested);
  const relative = path.relative(root,resolved);
  if (relative === '..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative)) throw Error('File must remain inside the current workspace');
  // Nonblocking open prevents special files from hanging before the regular-file check.
  const handle = await fs.open(resolved,constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const opened = await fs.realpath(process.platform==='linux' ? `/proc/self/fd/${handle.fd}` : resolved);
    const openedRelative=path.relative(root,opened);
    if (openedRelative==='..' || openedRelative.startsWith('..'+path.sep) || path.isAbsolute(openedRelative)) throw Error('File must remain inside the current workspace');
    const stat = await handle.stat();
    if (!stat.isFile()) throw Error('Only regular files can be inspected');
    if (!prefix && stat.size > limit) throw Error(`Text file exceeds ${limit} bytes`);
    const buffer = Buffer.alloc(Math.min(stat.size,limit));
    let size = 0;
    while (size < buffer.length) {
      cancelled(signal);
      const {bytesRead} = await handle.read(buffer,size,buffer.length-size,size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    cancelled(signal);
    const after=await handle.stat(),current=await fs.lstat(resolved);
    const sameSnapshot=[after,current].every(s=>s.isFile()&&s.dev===stat.dev&&s.ino===stat.ino&&s.size===stat.size&&s.mtimeMs===stat.mtimeMs&&s.ctimeMs===stat.ctimeMs);
    // Preserve the original request identity across leaf/ancestor/cwd symlink changes.
    const sameTarget=await fs.realpath(requested)===resolved && await fs.realpath(cwd)===root;
    if (!sameSnapshot || !sameTarget || size!==buffer.length) throw Error('Artifact changed while being inspected; retry against a stable file');
    return {bytes:buffer.subarray(0,size),fileBytes:stat.size,headerOnly:stat.size>size};
  } finally { await handle.close(); }
}

export default function registerSmallTools(pi: any) {
  if (disabled() && process.env.PI_SUBAGENT_CHILD !== '1') return;
  pi.on?.('tool_result',async (event:any,ctx:any)=>{
    const file=event.input?.path;
    if(disabled() || event.isError || !['write','edit'].includes(event.toolName) || typeof file!=='string' || file.length>1024 || !/\.svg$/i.test(file) || /(?:^|[\\/])(?:node_modules|vendor|dist|build|coverage|fixtures?|generated|backups|\.git)(?:[\\/]|$)/i.test(file))return;
    let svgCheck:Record<string,unknown>,annotation='';
    try {
      const data=await readArtifact(file,ctx?.cwd,TEXT_LIMIT,false,undefined);
      const source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data.bytes);
      const result=await inspectSvg(source),errors=result.findings.filter(f=>f.severity==='error');
      svgCheck={status:result.status,path:file,sourceHash:result.sourceHash,counts:result.counts,errorCount:errors.reduce((n,f)=>n+f.count,0),findingKeys:errors.slice(0,3).map(f=>f.key),scope:'source-only'};
      if(errors.length)annotation=('[svg-check] Saved SVG source needs review: '+errors.slice(0,3).map(f=>`${f.key}: ${f.message}`).join(' ')+' Inspect the complete file; rendered appearance remains unverified.').slice(0,600);
      // Review findings (clipped art, missing viewBox, hard-coded icon colour, bloat, active content) share the
      // receipt's 600-character budget: they fill what the structural note leaves, and never add noise beyond it.
      const quality=reviewSvg(source,{name:file}).findings.filter(f=>f.severity!=='low'&&!errors.some(e=>e.key===f.rule)).slice(0,2);
      const room=600-annotation.length-(annotation?1:0);
      if(quality.length&&room>=140){
        const review='[svg-review] '+quality.map(f=>`${f.rule}: ${f.message} ${f.fix}`).join(' ');
        const hint=' svg_inspect({action:"review"}) has the full report.';
        annotation=(annotation+(annotation?' ':'')+(review.length+hint.length<=room?review+hint:review.slice(0,Math.max(0,room-hint.length-1)).trimEnd()+'…'+hint)).slice(0,600);
      }
    }catch{
      // An unavailable/oversize/unstable file is not a successful check. Keep
      // original mutation success intact and never echo filesystem diagnostics.
      svgCheck={status:'unavailable',path:file,scope:'source-only',reason:'Complete stable SVG source could not be inspected within the workspace and parser limits.'};
    }
    return {content:annotation?[...(Array.isArray(event.content)?event.content:[]),{type:'text',text:annotation}]:event.content,details:{...event.details,svgCheck}};
  });
}
