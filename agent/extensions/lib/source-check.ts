/** Bounded parse-only checks. No project commands, imports, installs, caches or
 * LLM calls. Native parsers receive a stable source snapshot on stdin. */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Type } from 'typebox';
import { readSourceFiles } from '../pi-lens/context-code.mjs';

type Outcome = {status:'passed'|'failed'|'unavailable'|'incomplete'; checker:string; diagnostics:string[]};
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
    } catch {}
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
    results.push({path:file.path,digest:file.digest,...outcome});
  }
  for(const error of data.errors) results.push({path:error.path,status:'unavailable' as const,checker:'file',diagnostics:[compact(error.error)]});
  const counts = {passed:0,failed:0,unavailable:0,incomplete:0};
  for(const result of results) counts[result.status]++;
  const output: any = {kind:'source_check',ok:counts.passed>0&&!counts.failed&&!counts.unavailable&&!counts.incomplete,
    counts,results,scope:'Syntax only, from the supplied file snapshots. No type checking, imports, runtime tests, formatting verdict or environment/schema validation. .js uses module syntax; .cjs uses script syntax.'};
  // Preserve every file/status/digest; shorten only diagnostic prose if needed.
  if(JSON.stringify(output).length>16000) for(const result of results) {result.diagnostics=result.diagnostics.map(d=>d.slice(0,180));output.truncated=true;}
  if(JSON.stringify(output).length>16000) return {kind:'source_check',ok:false,counts,incomplete:true,reason:'Result paths exceed output budget; use shorter workspace-relative paths or a smaller batch'};
  return output;
}

export default function registerSourceCheck(pi: any) {
  pi.registerTool({name:'source_check',label:'Source check',
    description:'Batch syntax checks for explicit JS/TS/JSX/TSX, Python, Bash, Ruby, PHP, Go, JSON, YAML and TOML files. Installed parsers only; never executes project code, installs tools or writes files. Reports missing parsers and incomplete checks. Syntax does not replace project types/tests or configuration schema validation.',
    parameters:Type.Object({paths:Type.Array(Type.String({minLength:1,maxLength:1024}),{minItems:1,maxItems:20})}),
    async execute(_id: any,params: any,signal: AbortSignal,_onUpdate: any,ctx: any) {
      try {
        const result=await sourceCheck({paths:params.paths,cwd:ctx.cwd,signal});
        return {isError:!result.ok,content:[{type:'text',text:JSON.stringify(result)}],details:result};
      } catch(error) {return {isError:true,content:[{type:'text',text:signal?.aborted?'Cancelled':compact((error as Error).message)}]};}
    },
  });
}
