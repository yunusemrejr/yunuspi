/** Bounded parse-only checks. No project commands, imports, installs, caches or
 * LLM calls. Native parsers receive a stable source snapshot on stdin. */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Type } from 'typebox';
import { readSourceFiles } from '../pi-lens/context-code.mjs';
import {codeNoiseSupported, inspectCodeNoise} from './code-noise.mjs';
import {codeSlop, familyOf, findDuplicates, neighborSources} from './code-quality.ts';
import {sessionObservability} from './session-observability.ts';

type Outcome = {status:'passed'|'failed'|'unavailable'|'incomplete'; checker:string; diagnostics:string[]};
// Patterns precise enough to mention after an edit without being asked.
const AUTOMATIC_SLOP = new Set(['placeholder-elision','placeholder-implementation','debug-leftover','swallowed-error','bare-except','commented-out-code','redundant-boolean']);
const PYTHON = `import sys,json
source=sys.stdin.buffer.read()
try:
 compile(source,'<source>','exec',dont_inherit=True)
except (SyntaxError,ValueError) as e:
 print(json.dumps({'line':getattr(e,'lineno',None),'column':getattr(e,'offset',None),'message':getattr(e,'msg',str(e))}));sys.exit(1)
`;
const TOML = `import sys,json
try:
 import tomllib
except ImportError:
 print('Python 3.11+ tomllib is unavailable');sys.exit(3)
try:
 tomllib.loads(sys.stdin.read())
except (ValueError,RecursionError) as e:
 print(str(e));sys.exit(1)
`;
const specs: Record<string,{command:string;args:string[]}> = {
  '.py':{command:'python3',args:['-I','-S','-c',PYTHON]},
  '.pyi':{command:'python3',args:['-I','-S','-c',PYTHON]},
  '.toml':{command:'python3',args:['-I','-S','-c',TOML]},
  '.sh':{command:'bash',args:['--noprofile','--norc','-n']},
  '.bash':{command:'bash',args:['--noprofile','--norc','-n']},
  '.rb':{command:'ruby',args:['--disable=gems','-c']},
  '.php':{command:'php',args:['-n','-l']},
  '.go':{command:'gofmt',args:['-e','-l']},
};
export const sourceCheckSupported = (file: string) => /\.(?:[cm]?[jt]sx?|pyi?|sh|bash|rb|php|go|json|ya?ml|toml)$/i.test(file);
const cancelled = (signal?: AbortSignal) => {if(signal?.aborted) throw Error('Cancelled');};
const compact = (value: unknown) => {
  const text = String(value).replace(/\x1b\[[0-9;]*[A-Za-z]/g,'');
  return text.length>900 ? text.slice(0,875)+'… [diagnostic truncated]' : text;
};
function noiseActivity(noise: any) {
  if (noise?.runtime !== 'tree-sitter-wasm') return;
  try {sessionObservability()[Symbol.for('yunus-pi.health.v1')]?.('ml.wasm.completed',{
    helper:'source-check',runtime:noise.runtime,count:1,findings:noise.findings.length,durationMs:noise.durationMs,decision:noise.status,
  });} catch { /* Activity visibility must not change the source-check outcome. */ }
}

/** Ignore relative/project PATH entries and interpreter startup variables.
 * Never resolve an executable from the workspace or its dependencies. */
async function executable(command: string, cwd: string) {
  const root = await fs.realpath(cwd);
  for (const directory of [...new Set((process.env.PATH ?? '/usr/bin:/bin').split(path.delimiter))]) {
    if (!path.isAbsolute(directory)) continue;
    try {
      const candidate = await fs.realpath(path.join(directory,command));
      const relative = path.relative(root,candidate);
      if (relative === '' || relative !== '..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative)) continue;
      if (!(await fs.stat(candidate)).isFile()) continue;
      await fs.access(candidate,1);
      return candidate;
    } catch { /* A missing or inaccessible PATH candidate does not rule out later trusted directories. */ }
  }
  return undefined;
}

async function nativeCheck(ext: string, source: string, cwd: string, timeout: number, signal?: AbortSignal): Promise<Outcome> {
  const spec = specs[ext];
  const command = await executable(spec.command,cwd);
  cancelled(signal);
  if (!command) return {status:'unavailable',checker:spec.command,diagnostics:[`${spec.command} is not installed outside the workspace`]};
  return new Promise((resolve,reject) => {
    let output = '', stopped = false, finished = false;
    const child = spawn(command,spec.args,{cwd:os.tmpdir(),env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8'},stdio:['pipe','pipe','pipe']});
    const timer = setTimeout(() => {stopped=true;child.kill('SIGKILL');},timeout);
    const abort = () => {stopped=true;child.kill('SIGKILL');};
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted) abort();
    const finish = (status: Outcome['status'], diagnostics: string[]) => {
      if(finished) return; finished=true; clearTimeout(timer); signal?.removeEventListener('abort',abort);
      if(signal?.aborted) reject(Error('Cancelled'));
      else resolve({status,checker:spec.command,diagnostics});
    };
    const collect = (chunk: Buffer) => {
      if(output.length < 32768) output += chunk.toString('utf8').slice(0,32768-output.length);
      else {stopped=true;child.kill('SIGKILL');}
    };
    child.stdout.on('data',collect); child.stderr.on('data',collect);
    child.stdin.on('error',() => {}); // Early parser exits can close stdin.
    child.on('error',() => finish('unavailable',['Parser could not start']));
    child.on('close',(code,termination) => {
      if(stopped || termination) return finish('incomplete',['Parser time/output budget exceeded or execution interrupted']);
      if(code === 0) return finish('passed',[]);
      finish(code === 1 || code === 2 || code === 255 ? 'failed' : 'unavailable', [compact(output.trim() || `Parser exited with status ${code}`)]);
    });
    child.stdin.end(source);
  });
}

export async function checkSourceText(filename: string, source: string, cwd: string, signal?: AbortSignal, timeout = 3000): Promise<Outcome> {
  cancelled(signal);
  if (typeof source !== 'string' || Buffer.byteLength(source)>262144) return {status:'incomplete',checker:'none',diagnostics:['Source exceeds 256 KiB limit']};
  const ext = path.extname(filename).toLowerCase();
  if (specs[ext]) return nativeCheck(ext,source,cwd,timeout,signal);
  if (ext === '.json') {
    try {JSON.parse(source);return {status:'passed',checker:'JSON.parse',diagnostics:[]};}
    catch(error) {return {status:'failed',checker:'JSON.parse',diagnostics:[compact((error as Error).message)]};}
  }
  if (ext === '.yaml' || ext === '.yml') {
    try {
      const {parseAllDocuments} = await import('yaml');
      const documents = parseAllDocuments(source,{prettyErrors:false,strict:true,uniqueKeys:true});
      const errors = documents.flatMap(doc => doc.errors);
      return {status:errors.length?'failed':'passed',checker:'yaml',diagnostics:errors.slice(0,3).map(e => compact(e.message))};
    } catch {return {status:'unavailable',checker:'yaml',diagnostics:['YAML parser unavailable']};}
  }
  if (/^\.[cm]?js$/.test(ext)) {
    try {
      const {parse} = await import('acorn');
      try {
        // .js module mode is intentionally explicit: project package resolution
        // is outside this syntax-only tool. CJS wrappers allow top-level return.
        parse(source,{ecmaVersion:'latest',sourceType:ext === '.cjs'?'script':'module',allowReturnOutsideFunction:ext === '.cjs'});
        return {status:'passed',checker:'acorn',diagnostics:[]};
      } catch(error) {return {status:'failed',checker:'acorn',diagnostics:[compact((error as Error).message)]};}
    } catch {return {status:'unavailable',checker:'acorn',diagnostics:['JavaScript parser unavailable']};}
  }
  if (/^\.(?:[cm]?ts|tsx|jsx)$/.test(ext)) {
    try {
      const {parserFor} = await import('../pi-lens/semantic-radar/extract.mjs');
      const parser = await parserFor(ext);
      if (!parser) throw Error('No grammar');
      cancelled(signal);
      const tree = parser.parse(source);
      if (!tree) return {status:'incomplete',checker:'tree-sitter',diagnostics:['Parser did not complete']};
      try {
        const diagnostics: string[] = [], nodes = [tree.rootNode]; let visited = 0;
        while(nodes.length && diagnostics.length < 3 && ++visited <= 100000) {
          const node = nodes.pop()!;
          if (node.type === 'ERROR' || node.isMissing) {
            diagnostics.push(`${node.startPosition.row+1}:${node.startPosition.column+1}: ${node.isMissing?'Missing '+node.type:'Syntax error'}`);
            continue;
          }
          if(node.hasError) for(let i=node.childCount-1;i>=0;i--) nodes.push(node.child(i)!);
        }
        return {status:tree.rootNode.hasError?'failed':'passed',checker:'tree-sitter',diagnostics:diagnostics.length?diagnostics:tree.rootNode.hasError?['Syntax errors; narrow source for locations']:[]};
      } finally {tree.delete();}
    } catch {cancelled(signal);return {status:'unavailable',checker:'tree-sitter',diagnostics:['Installed Pi Lens grammar/parser unavailable']};}
  }
  return {status:'unavailable',checker:'none',diagnostics:['Unsupported extension']};
}

export async function sourceCheck({paths,cwd,signal}: {paths:string[];cwd:string;signal?:AbortSignal}) {
  const started = Date.now();
  const data = await readSourceFiles(cwd,paths,signal,sourceCheckSupported);
  const results = [];
  for(const file of data.files) {
    cancelled(signal);
    const remaining = 10000-(Date.now()-started);
    const outcome: Outcome = remaining <= 0 ? {status:'incomplete',checker:'none',diagnostics:['Batch time budget exceeded']}
      : await checkSourceText(file.path,file.source,cwd,signal,Math.min(3000,remaining));
    const noise = codeNoiseSupported(file.path) && outcome.status === 'passed'
      ? await inspectCodeNoise(file.path,file.source) : undefined;
    noiseActivity(noise);
    // Keep clean-file receipts small; detailed bounds accompany findings.
    const noiseReceipt = noise?.findings.length ? noise : noise ? {status:noise.status,truncated:noise.truncated} : undefined;
    results.push({path:file.path,digest:file.digest,...outcome,...(noiseReceipt ? {noise:noiseReceipt} : {})});
  }
  for(const error of data.errors) results.push({path:error.path,status:'unavailable' as const,checker:'file',diagnostics:[compact(error.error)]});
  const counts = {passed:0,failed:0,unavailable:0,incomplete:0};
  for(const result of results) counts[result.status]++;
  const output: any = {kind:'syntax_check',ok:counts.passed>0&&!counts.failed&&!counts.unavailable&&!counts.incomplete,
    counts,results,scope:'Syntax only, from the supplied file snapshots. No type checking, imports, runtime tests, formatting verdict or environment/schema validation. .js uses module syntax; .cjs uses script syntax.'};
  // Preserve every file/status/digest; shorten only diagnostic prose if needed.
  if(JSON.stringify(output).length>16000) for(const result of results) {result.diagnostics=result.diagnostics.map(d=>d.slice(0,180));output.truncated=true;}
  if(JSON.stringify(output).length>16000) return {kind:'syntax_check',ok:false,counts,incomplete:true,reason:'Result paths exceed output budget; use shorter workspace-relative paths or a smaller batch'};
  return output;
}

export default function registerSourceCheck(pi: any) {
  if (process.env.PI_REASONING_AIDS === 'off') return;
  // Successful edits get a small advisory receipt on their existing result,
  // never a steering message or mandatory repair loop. State belongs to this
  // extension/session and is fenced across session changes and async reads.
  let generation = 0, checks = 0;
  const seen = new Set<string>();
  // Files written this session: a new block is compared with them and with
  // its directory neighbours, which is where copy-paste usually comes from.
  const edited: string[] = [];
  const reset = () => {generation++; checks = 0; seen.clear(); edited.length = 0;};
  for (const event of ['session_start','session_switch','session_tree','session_shutdown']) pi.on(event,reset);
  pi.on('before_agent_start',() => {checks = 0;});
  pi.on('tool_result',async (event: any,ctx: any) => {
    if (process.env.PI_REASONING_AIDS === 'off' || event.isError || !['write','edit'].includes(event.toolName) || checks >= 6 || seen.size >= 512) return;
    const filename = event.input?.path;
    if (typeof filename !== 'string' || (!codeNoiseSupported(filename) && !familyOf(filename))) return;
    const owner = generation;
    checks++;
    try {
      const data = await readSourceFiles(ctx.cwd,[filename],undefined,(file: string) => codeNoiseSupported(file) || !!familyOf(file));
      const file = data.files[0];
      if (owner !== generation || !file || Buffer.byteLength(file.source) > 65536) return;
      let changedLines: [number,number] | undefined;
      if (event.toolName === 'edit') {
        const replacement = event.input?.newText;
        // Only diagnose the changed region. An ambiguous repeated replacement
        // cannot establish which existing code belongs to this edit.
        if (typeof replacement !== 'string' || !replacement) return;
        const offset = file.source.indexOf(replacement);
        if (offset < 0 || file.source.indexOf(replacement,offset + 1) !== -1) return;
        const start = file.source.slice(0,offset).split('\n').length;
        changedLines = [start,start + replacement.replace(/\n$/,'').split('\n').length - 1];
      }
      const key = `${ctx.sessionManager?.getSessionId?.() ?? 'current'}:${ctx.cwd}:${file.path}:${file.digest}`;
      if (seen.has(key)) return;
      seen.add(key);
      const noise: any = codeNoiseSupported(file.path) ? await inspectCodeNoise(file.path,file.source) : {status:'unsupported',findings:[],scope:''};
      if (owner !== generation) return;
      if (changedLines) {
        noise.findings = noise.findings.filter((f: any) => f.line >= changedLines[0] && f.line <= changedLines[1]);
        noise.scope += ' Automatic edit findings are restricted to the unambiguous replacement span.';
      }
      noiseActivity(noise);
      const span: [number,number] = changedLines ?? [1,file.source.split('\n').length];
      // High-precision patterns only; the code_quality tool reports the rest.
      const noisy = new Set(noise.findings.map((f: any) => f.line));
      const slop = codeSlop(file.path,file.source,span).filter(f => AUTOMATIC_SLOP.has(f.rule) && !(f.rule === 'swallowed-error' && noisy.has(f.line))).slice(0,3);
      let clones: any[] = [];
      try {
        const others = await neighborSources(ctx.cwd,file.path,edited.slice(-20));
        if (owner !== generation) return;
        const report = findDuplicates([{path:file.path,source:file.source},...others],{minTokens:45,minLines:5,focus:new Set([file.path]),focusLines:new Map([[file.path,span]]),limit:2});
        clones = report.clones.slice(0,2);
      } catch { /* Duplicate hints are optional evidence. */ }
      if (!edited.includes(file.path)) edited.push(file.path);
      if (edited.length > 40) edited.shift();
      if (!noise.findings.length && !slop.length && !clones.length) return;
      const parts = [
        ...noise.findings.map((f: any) => `L${f.line} ${f.kind}`),
        ...slop.map(f => `L${f.line} ${f.rule}: ${f.message}`),
        ...clones.map(c => { const mine = c.a.path === file.path && c.a.start >= span[0] - 2 && c.a.start <= span[1] ? c.a : c.b, other = mine === c.a ? c.b : c.a;
          return `L${mine.start}-${mine.end} repeats ${other.path === file.path ? '' : other.path + ':'}${other.start}-${other.end} (${c.lines} lines, ${c.kind}${c.renamed.length ? `; differs in ${c.renamed.slice(0,3).join(', ')}` : ''}): reuse or extract it if the copies must change together`; }),
      ];
      return {content:[...event.content,{type:'text',text:`Code review (advisory): ${parts.join('; ')}. Keep intentional behavior; no automatic retry is required.`}],
        details:{...event.details,codeNoise:{path:file.path,digest:file.digest,...noise},...(slop.length||clones.length?{codeQuality:{slop,clones}}:{})}};
    } catch { /* Advisory inspection must not turn a successful edit into a failed tool. */ }
  });
  pi.registerTool({name:'syntax_check',label:'Syntax check',
    description:'Batch syntax checks for explicit JS/TS/JSX/TSX, Python, Bash, Ruby, PHP, Go, JSON, YAML and TOML files. Installed parsers only; never executes project code, installs tools or writes files. Includes bounded advisory AST checks for comments restating returns and undocumented empty catches in JS/TS/Python. Noise findings do not fail syntax checks. Reports missing parsers and incomplete checks. Syntax does not replace project types/tests or configuration schema validation.',
    parameters:Type.Object({paths:Type.Array(Type.String({minLength:1,maxLength:1024}),{minItems:1,maxItems:20})}),
    async execute(_id: any,params: any,signal: AbortSignal,_onUpdate: any,ctx: any) {
      try {
        if (process.env.PI_REASONING_AIDS === 'off') throw new Error('Reasoning aids disabled');
        const result=await sourceCheck({paths:params.paths,cwd:ctx.cwd,signal});
        return {isError:!result.ok,content:[{type:'text',text:JSON.stringify(result)}],details:result};
      } catch(error) {return {isError:true,content:[{type:'text',text:signal?.aborted?'Cancelled':compact((error as Error).message)}]};}
    },
  });
}
