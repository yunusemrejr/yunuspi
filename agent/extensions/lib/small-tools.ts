/** Small explicit local checks. No subprocesses, installs, network, or writes. */
import {Type} from 'typebox';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {numericCheck} from './numeric-checks.ts';
import {inspectText, inspectImage, convertValue} from './artifact-checks.ts';
import {inspectSvg} from './svg-check.ts';
import {inspectUiSource} from './slop-guidance-signals.ts';
import {parseData, executeDataQuery} from './data-query.ts';

const disabled = () => process.env.PI_SMALL_TOOLS === 'off' || process.env.PI_REASONING_AIDS === 'off';
const TEXT_LIMIT = 65536, IMAGE_LIMIT = 1048576;
const str = (maxLength = 128) => Type.String({maxLength});
const list = (items: any) => Type.Array(items,{maxItems:2048});
const numbers = () => list(Type.Number({minimum:-1e100,maximum:1e100}));
const object = (properties: any) => Type.Object(properties,{additionalProperties:false});
const operation = (value: string) => Type.Literal(value);
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
    }catch{
      // An unavailable/oversize/unstable file is not a successful check. Keep
      // original mutation success intact and never echo filesystem diagnostics.
      svgCheck={status:'unavailable',path:file,scope:'source-only',reason:'Complete stable SVG source could not be inspected within the workspace and parser limits.'};
    }
    return {content:annotation?[...(Array.isArray(event.content)?event.content:[]),{type:'text',text:annotation}]:event.content,details:{...event.details,svgCheck}};
  });
  function register(name: string, description: string, parameters: any, run: (p: any, ctx: any, signal: any) => unknown, guidelines?: string[]) {
    pi.registerTool({name,label:name.replaceAll('_',' '),description,parameters,
      ...(guidelines && guidelines.length ? {promptGuidelines: guidelines} : {}),
      async execute(_id: any, p: any, signal: any, _onUpdate: any, ctx: any) {
        try {
          if (disabled()) throw Error('Small tools are disabled');
          cancelled(signal);
          const result = await run(p,ctx,signal);
          cancelled(signal);
          return {content:[{type:'text',text:JSON.stringify(result)}],details:result};
        } catch (e) {
          // File-system errors can include private absolute paths; do not echo them.
          const message = e && typeof e === 'object' && 'code' in e ? 'Artifact could not be opened safely' : e instanceof Error ? e.message : 'Invalid input';
          return {isError:true,content:[{type:'text',text:message}],details:{available:false}};
        }
      },
    });
  }
  register('math_check',
    'Compute bounded numeric summaries, regression/classification metrics, vectors, split-ID overlap, measured frame-time percentiles (frame_budget, values in ms), or render attachment memory (render_budget). Use supplied observations, not guesses; estimates do not establish runtime performance.',
    object({
      operation:Type.Union(['summarize','compare','classify','vectors','split_overlap','frame_budget','render_budget'].map(operation)),
      values:Type.Optional(numbers()),actual:Type.Optional(Type.Union([numbers(),list(str())])),predicted:Type.Optional(Type.Union([numbers(),list(str())])),
      labels:Type.Optional(Type.Array(str(),{maxItems:32})),a:Type.Optional(numbers()),b:Type.Optional(numbers()),
      train:Type.Optional(list(str())),validation:Type.Optional(list(str())),test:Type.Optional(list(str())),
      target_fps:Type.Optional(Type.Number({minimum:1,maximum:1000})),
      width:Type.Optional(Type.Integer({minimum:1,maximum:65536})),height:Type.Optional(Type.Integer({minimum:1,maximum:65536})),
      pixel_ratio:Type.Optional(Type.Number({minimum:.125,maximum:8})),bytes_per_pixel:Type.Optional(Type.Integer({minimum:1,maximum:64})),
      samples:Type.Optional(Type.Integer({minimum:1,maximum:16})),buffers:Type.Optional(Type.Integer({minimum:1,maximum:8})),
    }),p=>numericCheck(p),
    ['Use math_check for numeric summaries, metrics, vectors, split overlap, measured frame times and render attachment budgets. Compare evidence under the same scene/device/settings before reducing visual detail.']);
  register('artifact_check',
    'Inspect Unicode metadata (text), image header dimensions (image), SVG IDs/references/viewBox and resource/motion cues (svg), or UI source cues (ui). SVG accepts text or workspace path up to 64 KiB; ui requires a path and <=24000 characters. Source checks return advisory cues and a hash; no rendering, sanitization or design certification.',
    object({operation:Type.Union(['text','image','ui','svg'].map(operation)),text:Type.Optional(str(TEXT_LIMIT)),path:Type.Optional(Type.String({minLength:1,maxLength:1024}))}),async (p,ctx,signal) => {
      if (!p || typeof p !== 'object' || Array.isArray(p) || !['text','image','ui','svg'].includes(p.operation)) throw Error('Unsupported artifact operation');
      const keys=Object.keys(p);
      if (keys.some(k=>!['operation','text','path'].includes(k)) || ('text' in p) === ('path' in p) || 'text' in p && typeof p.text !== 'string' || 'path' in p && typeof p.path !== 'string') throw Error('Supply exactly one of text or path');
      if (p.operation==='text' && typeof p.text==='string') return inspectText(p.text);
      if (p.operation==='svg' && typeof p.text==='string') return inspectSvg(p.text);
      if (p.operation==='image' && 'text' in p) throw Error('Image inspection requires a path');
      if (p.operation==='ui' && 'text' in p) throw Error('UI inspection requires a path');
      const data=await readArtifact(p.path,ctx?.cwd,p.operation==='image'?IMAGE_LIMIT:TEXT_LIMIT,p.operation==='image',signal);
      if(p.operation==='image') return {...inspectImage(data.bytes),fileBytes:data.fileBytes,headerPrefixOnly:data.headerOnly};
      let text: string;
      try { text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data.bytes); }
      catch { throw Error('Text file is not valid UTF-8'); }
      return p.operation==='svg' ? inspectSvg(text) : p.operation==='ui' ? inspectUiSource(p.path,text) : inspectText(text);
    },
    ['Use artifact_check for text/image metadata, operation:"svg" for standalone SVG source, or operation:"ui" on a changed component. Source cues locate review work; verify artwork/UI with rendered and interaction evidence.']);
  register('value_convert',
    'Convert supplied text: strict UTF-8 Base64, URI component encoding, or JSON format/compact. Returns bounded converted text; never evaluates code or writes a file. Use when exact encoding or formatting is needed.',
    object({operation:Type.Union(['json_format','json_compact','base64_encode','base64_decode','url_encode','url_decode'].map(operation)),text:str(TEXT_LIMIT)}),p=>convertValue(p),
    ['Use value_convert for exact base64, URL-component or JSON encoding and formatting instead of shell one-liners.']);
  register('data_query',
    'Read and query JSON or YAML from a workspace file or supplied text. Use this INSTEAD of bash `jq`, `yq` or `python -c` for reads: get a path, list keys, count, filter an array by field, or convert JSON/YAML/CSV. Bounded output; never evaluates code or writes a file.',
    object({
      op:Type.Union(['get','keys','count','filter','convert'].map(operation)),
      file:Type.Optional(Type.String({minLength:1,maxLength:1024})),
      text:Type.Optional(str(TEXT_LIMIT)),
      path:Type.Optional(str(1024)),
      field:Type.Optional(str(256)),
      equals:Type.Optional(Type.Union([Type.String({maxLength:512}),Type.Number({}),Type.Boolean({})])),
      format:Type.Optional(Type.Union(['json','yaml','csv'].map(operation))),
      limit:Type.Optional(Type.Integer({minimum:1,maximum:200})),
    }),async (p,ctx,signal) => {
      if (!p || typeof p !== 'object' || Array.isArray(p)) throw Error('Invalid input');
      if (('file' in p) === ('text' in p)) throw Error('Supply exactly one of file or text');
      if (!['get','keys','count','filter','convert'].includes(p.op)) throw Error(`Unsupported data operation: ${String(p.op)}`);
      let data: unknown;
      if (typeof p.file === 'string') {
        const artifact = await readArtifact(p.file, ctx?.cwd, 2*1024*1024, false, signal);
        let text: string;
        try { text = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(artifact.bytes); }
        catch { throw Error('File is not valid UTF-8 text'); }
        data = parseData(text, p.file);
      } else {
        if (typeof p.text !== 'string') throw Error('Text must be a string');
        data = parseData(p.text);
      }
      return executeDataQuery({op:p.op,data,path:p.path,field:p.field,equals:p.equals,format:p.format,limit:p.limit});
    },
    ['Use data_query to read or reshape JSON/YAML values instead of jq, yq or python -c.']);
}
