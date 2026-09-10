/** Small explicit local checks. No subprocesses, installs, network, or writes. */
import {Type} from 'typebox';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {numericCheck} from './numeric-checks.ts';
import {inspectText, inspectImage, convertValue} from './artifact-checks.ts';

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
  const root = await fs.realpath(cwd), resolved = await fs.realpath(path.resolve(root,file));
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
    const after=await handle.stat();
    if (after.size!==stat.size || after.mtimeMs!==stat.mtimeMs || size!==buffer.length) throw Error('Artifact changed while being inspected; retry against a stable file');
    return {bytes:buffer.subarray(0,size),fileBytes:stat.size,headerOnly:stat.size>size};
  } finally { await handle.close(); }
}

export default function registerSmallTools(pi: any) {
  if (disabled() && process.env.PI_SUBAGENT_CHILD !== '1') return;
  function register(name: string, description: string, parameters: any, run: (p: any, ctx: any, signal: any) => unknown) {
    pi.registerTool({name,label:name.replaceAll('_',' '),description,parameters,
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
    'Compute bounded numeric summaries, regression/classification metrics, vector comparisons or exact-ID train/validation/test overlap. Use supplied observations, not guesses. No model inference or significance claims; null marks undefined metrics.',
    object({
      operation:Type.Union(['summarize','compare','classify','vectors','split_overlap'].map(operation)),
      values:Type.Optional(numbers()),actual:Type.Optional(Type.Union([numbers(),list(str())])),predicted:Type.Optional(Type.Union([numbers(),list(str())])),
      labels:Type.Optional(Type.Array(str(),{maxItems:32})),a:Type.Optional(numbers()),b:Type.Optional(numbers()),
      train:Type.Optional(list(str())),validation:Type.Optional(list(str())),test:Type.Optional(list(str())),
    }),p=>numericCheck(p));
  register('artifact_check',
    'Inspect Unicode controls, normalization and line endings (text), or PNG/JPEG/GIF/WebP header dimensions (image). File paths stay within cwd. Header metadata does not verify full image decoding; Unicode analysis does not prove font/glyph rendering.',
    object({operation:Type.Union(['text','image'].map(operation)),text:Type.Optional(str(TEXT_LIMIT)),path:Type.Optional(Type.String({minLength:1,maxLength:1024}))}),async (p,ctx,signal) => {
      if (!p || typeof p !== 'object' || Array.isArray(p) || !['text','image'].includes(p.operation)) throw Error('Unsupported artifact operation');
      const keys=Object.keys(p);
      if (keys.some(k=>!['operation','text','path'].includes(k)) || ('text' in p) === ('path' in p) || 'text' in p && typeof p.text !== 'string' || 'path' in p && typeof p.path !== 'string') throw Error('Supply exactly one of text or path');
      if (p.operation==='text' && typeof p.text==='string') return inspectText(p.text);
      if (p.operation==='image' && 'text' in p) throw Error('Image inspection requires a path');
      const data=await readArtifact(p.path,ctx?.cwd,p.operation==='image'?IMAGE_LIMIT:TEXT_LIMIT,p.operation==='image',signal);
      if(p.operation==='image') return {...inspectImage(data.bytes),fileBytes:data.fileBytes,headerPrefixOnly:data.headerOnly};
      let text: string;
      try { text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data.bytes); }
      catch { throw Error('Text file is not valid UTF-8'); }
      return inspectText(text);
    });
  register('value_convert',
    'Convert supplied text: strict UTF-8 Base64, URI component encoding, or JSON format/compact. Returns bounded converted text; never evaluates code or writes a file. Use when exact encoding or formatting is needed.',
    object({operation:Type.Union(['json_format','json_compact','base64_encode','base64_decode','url_encode','url_decode'].map(operation)),text:str(TEXT_LIMIT)}),p=>convertValue(p));
}
