/** Bounded, fresh structural context. Reuses Pi Lens's installed Tree-sitter parser;
 * no index, execution, network, learned relevance claims, or binding resolution. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync=promisify(execFile);
import { parserFor } from './semantic-radar/extract.mjs';
const MAX_FILE = 262144, MAX_TOTAL = 1048576;
const kinds = new Set(['variable_declarator','function_signature','function_declaration','generator_function_declaration','function_expression','arrow_function','method_definition','function_definition','class_declaration','class_definition','interface_declaration','type_alias_declaration']);
const branches = new Set(['if_statement','switch_statement','switch_case','conditional_expression','for_statement','for_in_statement','while_statement','try_statement','except_clause']);
const imports = new Set(['import_statement','import_from_statement','import_declaration']);
const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 24);
const bounds = (value, fallback, min, max) => Number.isInteger(value) ? Math.max(min, Math.min(max,value)) : fallback;
const words = value => [...new Set(String(value).replace(/([a-z])([A-Z])/g,'$1 $2').replace(/_/g,' ').toLowerCase().match(/[a-z_$][a-z0-9_$]{1,}/g) ?? [])].slice(0,64);
const publicSymbol = ({ name, kind, startLine, endLine, signature, digest, nameLine, nameCharacter, omittedCalls, omittedReferences }) => ({name,kind,startLine,endLine,signature,digest,nameLine,nameCharacter,...(omittedCalls?{omittedCalls}:{}),...(omittedReferences?{omittedReferences}:{})});
function walk(root, visit, budget={remaining:250000}) {
  const queue = [root]; let count=0;
  while(queue.length) { const node=queue.pop(); if(++count>100000||--budget.remaining<0) throw new Error('AST node budget exceeded'); visit(node); for(let i=node.namedChildCount-1;i>=0;i--) queue.push(node.namedChild(i)); }
}
function nameOf(node) {
  const named=node.childForFieldName('name'); if(named) return named.text;
  if(node.parent?.type==='variable_declarator') return node.parent.childForFieldName('name')?.text;
  if(node.parent?.type==='pair') return node.parent.childForFieldName('key')?.text;
  return `<anonymous@${node.startPosition.row+1}:${node.startPosition.column+1}>`;
}
function ownerName(node) {
  const names=[]; let parent=node.parent;
  while(parent) { if(kinds.has(parent.type)&&parent.type!=='variable_declarator') names.unshift(nameOf(parent)); parent=parent.parent; }
  return names.filter(Boolean).join('.');
}
export async function inspectSource(filename, source) {
  if(typeof source!=='string' || Buffer.byteLength(source)>MAX_FILE) throw new Error('Source exceeds 256 KiB limit');
  const base={path:filename,digest:hash(source),bytes:Buffer.byteLength(source),source,symbols:[],imports:[],parseErrors:false,supported:false};
  const parser=await parserFor(path.extname(filename).toLowerCase());
  if(!parser) return {...base,reason:'No installed Pi Lens grammar for this extension'};
  const tree=parser.parse(source);
  try {
    base.supported=true; base.parseErrors=tree.rootNode.hasError;
    const budget={remaining:250000}; let retainedChars=0;
    walk(tree.rootNode,node=>{
      if(imports.has(node.type)) base.imports.push({startLine:node.startPosition.row+1,endLine:node.endPosition.row+1,source:node.text});
      if(!kinds.has(node.type)) return;
      if(node.type==='variable_declarator') {
        const value=node.childForFieldName('value');
        if(value&&kinds.has(value.type))return;
        let parent=node.parent;
        while(parent) {if(kinds.has(parent.type))return;parent=parent.parent;}
      }
      if(base.symbols.length>=512) throw new Error('Symbol budget exceeded; narrow source');
      retainedChars+=node.endIndex-node.startIndex;
      if(retainedChars>MAX_TOTAL)throw new Error('Nested symbol source budget exceeded; narrow source');
      const shortName=nameOf(node), owner=ownerName(node), body=node.childForFieldName('body');
      const nameNode=node.childForFieldName('name')??(node.parent?.type==='variable_declarator'?node.parent.childForFieldName('name'):null)??node;
      const calls=[], refs=new Set(), branchShapes=[];
      walk(node, child=>{
        if(child.type==='call_expression'||child.type==='call') {
          const callee=child.childForFieldName('function');
          if(callee) calls.push({name:callee.text.slice(0,160),line:child.startPosition.row+1});
        }
        if(child.type==='identifier'||child.type==='type_identifier') refs.add(child.text);
        if(branches.has(child.type)) branchShapes.push({kind:child.type,line:child.startPosition.row+1,digest:hash(child.text)});
      }, budget);
      base.symbols.push({name:owner?`${owner}.${shortName}`:shortName,shortName,kind:node.type,startLine:node.startPosition.row+1,endLine:node.endPosition.row+1,
        signature:source.slice(node.startIndex,body?.startIndex??Math.min(node.endIndex,node.startIndex+400)).trim().slice(0,800),
        nameLine:nameNode.startPosition.row+1,nameCharacter:nameNode.startPosition.column+1,
        parameters:node.childForFieldName('parameters')?.namedChildren.map(p=>p.text.slice(0,160))??[],
        digest:hash(node.text),source:node.text,calls:calls.slice(0,256),omittedCalls:Math.max(0,calls.length-256),references:[...refs].slice(0,512),omittedReferences:Math.max(0,refs.size-512),branches:branchShapes.slice(0,256),branchCount:branchShapes.length,branchDigest:hash(JSON.stringify(branchShapes.map(branch=>branch.digest)))});
    }, budget);
    return base;
  } finally { tree.delete(); }
}
export async function loadSources(cwd, paths, signal) {
  if(!Array.isArray(paths)||!paths.length||paths.length>20) throw new Error('Provide 1–20 explicit source file paths');
  const root=await fs.realpath(cwd); const files=[], errors=[]; let bytes=0;
  for(const supplied of [...new Set(paths)]) {
    if(signal?.aborted) throw new Error('Cancelled');
    try {
      if(typeof supplied!=='string'||supplied.length>4096) throw new Error('Invalid source path');
      const resolved=await fs.realpath(path.resolve(root,supplied));
      const relative=path.relative(root,resolved);
      if(relative.startsWith('..'+path.sep)||relative==='..'||path.isAbsolute(relative)) throw new Error('Path escapes workspace');
      if(!/\.(?:[cm]?[jt]sx?|py|cpp|cc|c|h|hpp|rs|go|java|css|html|sql|sh)$/i.test(resolved)||/(?:^|[/\\])(?:node_modules|\.git|vendor)(?:[/\\]|$)/.test(relative)) throw new Error('Only project source files are accepted');
      const handle=await fs.open(resolved,constants.O_RDONLY|(constants.O_NONBLOCK??0)|(constants.O_NOFOLLOW??0)); let source;
      try {
        const stat=await handle.stat();
        if(process.platform==='linux') {
          const opened=await fs.realpath(`/proc/self/fd/${handle.fd}`), rel=path.relative(root,opened);
          if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw new Error('Opened file escapes workspace');
        }
        if(!stat.isFile()||stat.size>MAX_FILE||bytes+stat.size>MAX_TOTAL) throw new Error('Source file or aggregate byte budget exceeded');
        const buffer=Buffer.alloc(MAX_FILE+1); let length=0;
        while(length<buffer.length) {
          if(signal?.aborted)throw new Error('Cancelled');
          const read=await handle.read(buffer,length,buffer.length-length,length);
          if(!read.bytesRead)break;
          length+=read.bytesRead;
        }
        if(length>MAX_FILE||bytes+length>MAX_TOTAL) throw new Error('Source grew beyond byte budget');
        const after=await handle.stat();
        if(length!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw new Error('Source changed while reading; retry');
        source=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length)); bytes+=length;
        if(source.includes('\0')) throw new Error('Binary source refused');
      } finally {await handle.close();}
      files.push(await inspectSource(relative,source));
    } catch(error) { if(signal?.aborted)throw new Error('Cancelled');errors.push({path:typeof supplied==='string'?supplied.slice(0,4096):'<invalid>',error:error.message}); }
  }
  return {files,errors,bytes};
}
// The budget applies to the entire serialized result, not only source bodies.
export function boundResult(result,maxChars=12000) {
  const cap=bounds(maxChars,12000,1200,32000);
  let text=JSON.stringify(result);
  const list=result.slices??result.nodes??result.changes;
  while(text.length>cap&&list?.length) {list.pop(); result.omittedByBudget=(result.omittedByBudget??0)+1;result.incomplete=true;text=JSON.stringify(result);}
  // Metadata can also be large (long paths/imports/errors). Preserve explicit accounting.
  while(text.length>cap&&result.edges?.length) {result.edges.pop();result.omittedEdges=(result.omittedEdges??0)+1;result.incomplete=true;text=JSON.stringify(result);}
  if(text.length>cap) return {kind:result.kind,incomplete:true,reason:'Metadata exceeds output budget; narrow explicit paths or increase maxChars',omittedItems:list?.length??0};
  return result;
}
export async function contextSlice({cwd,paths,task,maxChars,signal}) {
  if(typeof task!=='string'||!task.trim()||task.length>8192) throw new Error('Task must contain 1–8192 characters');
  const data=await loadSources(cwd,paths,signal), terms=words(task);
  if(signal?.aborted)throw new Error('Cancelled');
  const candidates=data.files.flatMap(file=>file.symbols.map(symbol=>{
    const names=words(symbol.name), signature=words(symbol.signature), content=words(symbol.source.slice(0,16000));
    const score=terms.reduce((sum,t)=>sum+(names.includes(t)?6:signature.includes(t)?3:content.includes(t)?1:0),0);
    return {file,symbol,score};
  })).filter(c=>c.score>0).sort((a,b)=>b.score-a.score||a.file.path.localeCompare(b.file.path)||a.symbol.startLine-b.symbol.startLine);
  const chosen=[];
  for(const item of candidates) {
    if(chosen.some(c=>c.file.path===item.file.path&&c.symbol.startLine<=item.symbol.startLine&&c.symbol.endLine>=item.symbol.endLine))continue;
    chosen.push(item); if(chosen.length===20)break;
  }
  return boundResult({kind:'context_slice',method:'AST ranges ranked by task identifier overlap; not semantic binding',readCoverage:'Use read_symbol/read before editing; this tool does not register edit-guard coverage',
    files:data.files.map(f=>({path:f.path,digest:f.digest,bytes:f.bytes,supported:f.supported,parseErrors:f.parseErrors,symbols:f.symbols.length,reason:f.reason})),errors:data.errors,
    candidateCount:candidates.length,slices:chosen.map(({file,symbol,score})=>({path:file.path,score,...publicSymbol(symbol),imports:file.imports.slice(0,12),omittedImports:Math.max(0,file.imports.length-12),source:symbol.source.slice(0,4000),sourceComplete:symbol.source.length<=4000,omittedSourceChars:Math.max(0,symbol.source.length-4000)})),
    omittedCandidates:Math.max(0,candidates.length-chosen.length)},maxChars);
}
export async function symbolExpand({cwd,paths,symbol,maxHops,maxNodes,maxChars,signal}) {
  if(typeof symbol!=='string'||!symbol.trim()||symbol.length>256) throw new Error('Provide a symbol name of 1–256 characters');
  const data=await loadSources(cwd,paths,signal);
  if(signal?.aborted)throw new Error('Cancelled');
  const all=data.files.flatMap(file=>file.symbols.map(item=>({file,...item,id:`${file.path}:${item.startLine}:${item.name}`})));
  const roots=all.filter(n=>n.name===symbol||n.shortName===symbol), nodes=[],edges=[],seen=new Set();
  let omittedEdges=0,queueTruncated=false;
  const queue=roots.map(node=>({node,hop:0})); const hops=bounds(maxHops,1,0,3), cap=bounds(maxNodes,12,1,40);
  while(queue.length&&nodes.length<cap) {
    const {node,hop}=queue.shift(); if(seen.has(node.id))continue;seen.add(node.id);
    nodes.push({id:node.id,path:node.file.path,hop,...publicSymbol(node),source:node.source.slice(0,4000),sourceComplete:node.source.length<=4000,omittedSourceChars:Math.max(0,node.source.length-4000)});
    if(hop>=hops)continue;
    for(const other of all) {
      if(node.id===other.id)continue;
      const outgoing=node.calls.some(c=>c.name===other.shortName||c.name===other.name);
      const incoming=other.calls.some(c=>c.name===node.shortName||c.name===node.name);
      const typeRef=node.references.includes(other.shortName)&&/class|interface|type_alias/.test(other.kind);
      if(!outgoing&&!incoming&&!typeRef)continue;
      const addEdge=(from,to,kind)=>{if(edges.length<160)edges.push({from,to,kind,resolution:'name-match; may be shadowed or unrelated'});else omittedEdges++;};
      if(incoming)addEdge(other.id,node.id,'possible-caller');
      if(outgoing)addEdge(node.id,other.id,'possible-callee');
      if(typeRef)addEdge(node.id,other.id,'syntactic-type-reference');
      if(queue.length<200)queue.push({node:other,hop:hop+1});else queueTruncated=true;
    }
  }
  const truncatedEvidence={calls:all.reduce((n,item)=>n+item.omittedCalls,0),references:all.reduce((n,item)=>n+item.omittedReferences,0)};
  return boundResult({kind:'symbol_expand',scope:'Only explicit files; syntactic candidates, no resolved bindings',roots:roots.map(r=>r.id).slice(0,40),ambiguous:roots.length>1,
    lsp:{used:false,next:'Use existing lsp_navigation operations references/definition at the source position for exact language-server resolution'},
    files:data.files.map(f=>({path:f.path,digest:f.digest,supported:f.supported,parseErrors:f.parseErrors})),errors:data.errors,nodes,edges,omittedEdges,queueTruncated,truncatedEvidence,incomplete:queue.length>0||queueTruncated||omittedEdges>0||truncatedEvidence.calls>0||truncatedEvidence.references>0},maxChars);
}
export async function astDiff({cwd,path:filename,before,after,base,maxChars,signal}) {
  if(signal?.aborted)throw new Error('Cancelled');
  let provenance;
  if(base!==undefined) {
    if(before!==undefined||after!==undefined)throw new Error('Use either base Git mode or supplied before/after, not both');
    if(typeof base!=='string'||base.length>128||!(/^(?:HEAD(?:[~^]\d{1,3})?|[a-f0-9]{7,64}|[A-Za-z][A-Za-z0-9_./-]*)$/.test(base))||base.includes('..')||base.includes('//'))throw new Error('Invalid Git base ref');
    const loaded=await loadSources(cwd,[filename],signal);
    if(loaded.errors.length||!loaded.files.length)throw new Error(loaded.errors[0]?.error??'Current file unavailable');
    const current=loaded.files[0];
    const git=async args=>(await execFileAsync('git',['--no-pager','-c','core.hooksPath=/dev/null',...args],{cwd,encoding:'utf8',timeout:1500,maxBuffer:MAX_FILE+1,signal,env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'}})).stdout;
    let repository;
    try {
      repository=(await git(['rev-parse','--show-toplevel'])).trim();
      const relative=path.relative(repository,path.resolve(cwd,current.path)).split(path.sep).join('/');
      if(relative.startsWith('../'))throw new Error('File outside Git work tree');
      const resolvedBase=(await git(['rev-parse','--verify',base+'^{commit}'])).trim();
      before=await git(['show',resolvedBase+':'+relative]);
      after=current.source;
      provenance={mode:'git',base:resolvedBase,path:relative,workingDigest:current.digest};
    } catch(error) {throw new Error('Cannot read Git base blob: '+String(error.message).slice(0,400));}
  }

  if(typeof filename!=='string'||filename.length>4096)throw new Error('Provide a source path/extension');
  const left=await inspectSource(filename,before),right=await inspectSource(filename,after);
  if(signal?.aborted)throw new Error('Cancelled');
  if(!left.supported||!right.supported||left.parseErrors||right.parseErrors) return {kind:'ast_diff',available:false,reason:'Unsupported grammar or syntax errors; use raw diff/diagnostics',beforeDigest:left.digest,afterDigest:right.digest};
  const keys=items=> {const seen=new Map();return new Map(items.map(s=>{const base=`${s.kind}:${s.name}`,ordinal=seen.get(base)??0;seen.set(base,ordinal+1);return [`${base}#${ordinal}`,s];}));};
  const a=keys(left.symbols),b=keys(right.symbols),changes=[];
  for(const [key,s]of a) {
    const t=b.get(key);
    if(!t){changes.push({change:'removed',before:publicSymbol(s)});continue;}
    if(s.digest===t.digest)continue;
    const delta=(x,y)=>({added:y.filter(v=>!x.includes(v)),removed:x.filter(v=>!y.includes(v))});
    changes.push({change:'modified',before:publicSymbol(s),after:publicSymbol(t),signatureChanged:s.signature!==t.signature,
      parameters:delta(s.parameters,t.parameters),calls:{...delta([...new Set(s.calls.map(c=>c.name))],[...new Set(t.calls.map(c=>c.name))]),incomplete:s.omittedCalls>0||t.omittedCalls>0},
      branches:{before:s.branchCount,after:t.branchCount,changed:s.branchDigest!==t.branchDigest}});
  }
  for(const[key,t]of b)if(!a.has(key))changes.push({change:'added',after:publicSymbol(t)});
  const importDelta={added:right.imports.map(x=>x.source).filter(x=>!left.imports.some(y=>y.source===x)),removed:left.imports.map(x=>x.source).filter(x=>!right.imports.some(y=>y.source===x))};
  return boundResult({kind:'ast_diff',available:true,provenance,method:'Structural summary; no equivalence or call-site binding proof; duplicate declarations paired by occurrence',beforeDigest:left.digest,afterDigest:right.digest,
    imports:importDelta,changes,totalChanges:changes.length,nonSymbolChangesPossible:left.digest!==right.digest},maxChars);
}
