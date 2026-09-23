import path from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import { paginate } from './files.mjs';
import { referenceEvidence } from './local-reference.mjs';

const map = value => value && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(value);
const dynamic = value => typeof value === 'string' && /\$\{\{|\{\{|\$\(/.test(value);
const LIMIT = 4096;

/** Counts literal matrices; values and executable scripts are never returned. */
export function matrixSummary(matrix) {
  if (matrix === undefined) return { status: 'none', combinations: 1 };
  if (!map(matrix)) return { status: dynamic(matrix) ? 'unresolved' : 'invalid', reason: 'Matrix must be a literal mapping or a runtime expression' };
  const stack = [matrix]; let seen = 0;
  while (stack.length) {
    const value = stack.pop();
    if (++seen > 12000) return { status: 'limit', reason: 'Matrix node budget exceeded' };
    if (dynamic(value)) return { status: 'unresolved', reason: 'Matrix depends on runtime expressions' };
    if (value && typeof value === 'object') stack.push(...Object.values(value));
  }
  const axes = Object.entries(matrix).filter(([key]) => !['include', 'exclude'].includes(key));
  if (axes.length > 20 || axes.some(([key, values]) => !identifier(key) || !Array.isArray(values) || !values.length || values.length > 256)) return { status: 'invalid', reason: 'Matrix axes must be named nonempty bounded arrays' };
  const include = matrix.include === undefined ? [] : matrix.include, exclude = matrix.exclude === undefined ? [] : matrix.exclude;
  if (![include, exclude].every(rows => Array.isArray(rows) && rows.length <= 256 && rows.every(map))) return { status: 'invalid', reason: 'Matrix include/exclude must be bounded lists of mappings' };
  if (!axes.length && !include.length) return { status:'invalid', reason:'Matrix requires at least one axis or include entry' };
  const product = axes.reduce((n, [, values]) => n * values.length, 1);
  const summary = { axes: axes.map(([name, values]) => ({ name, values: values.length })), include: include.length, exclude: exclude.length };
  if (product > LIMIT) return { ...summary, status: 'limit', base_combinations: product, reason: 'Literal matrix expansion exceeds 4096 combinations' };
  // Structured matrix entries are legal but their partial-object matching semantics
  // are outside this inspector. Never guess a job count for them.
  if (axes.some(([,values]) => values.some(value => value && typeof value === 'object')) || [...include,...exclude].some(row => Object.values(row).some(value => value && typeof value === 'object'))) return { ...summary, status:'unresolved', base_combinations:product, reason:'Object-valued matrix matching requires GitHub evaluation' };
  const eq = (a,b) => Object.is(a,b) || a === b;
  let base = axes.length ? [{}] : [];
  for (const [key, values] of axes) base = base.flatMap(row => values.map(value => ({...row,[key]:value})));
  base = base.filter(row => !exclude.some(rule => Object.entries(rule).every(([key,value]) => Object.hasOwn(row,key) && eq(row[key],value))));
  const expanded = base.map(row => ({...row}));
  const additions = [];
  for (const extra of include) {
    let applied = false;
    base.forEach((row,index) => {
      if (Object.entries(extra).every(([key,value]) => !Object.hasOwn(row,key) || eq(row[key],value))) { Object.assign(expanded[index],extra); applied = true; }
    });
    if (!applied) additions.push(extra);
  }
  return {...summary,status:'literal',base_combinations:product,combinations:expanded.length+additions.length};
}

export function workflowProbe(files, args) {
  const text = files.read(args.path);
  if (Buffer.byteLength(text) > 512 * 1024) throw Error('Workflow exceeds 512 KiB');
  const project = files.resolve(args.project ?? '.', true), lines = new LineCounter();
  const doc = parseDocument(text, {version:'1.2',uniqueKeys:true,strict:true,lineCounter:lines,customTags:[]});
  const at = node => lines.linePos(node?.range?.[0] ?? 0).line;
  const findings = [];
  const finding = (code,line,job) => findings.push({code,line,...(job ? {job} : {})});
  if (doc.errors.length) return {path:args.path,parsed:false,findings:doc.errors.slice(0,20).map(error => ({code:'invalid-yaml',line:lines.linePos(error.pos?.[0] ?? 0).line})),scope:'YAML parsing only; parser text and source values are omitted'};
  let data;
  try { data = doc.toJS({maxAliasCount:30}); } catch { throw Error('Workflow YAML alias limit exceeded'); }
  if (!map(data) || !map(data.jobs)) return {path:args.path,parsed:true,findings:[{code:'jobs-mapping-required',line:1}],items:[],total:0};
  const entries = Object.entries(data.jobs);
  if (entries.length > 200) throw Error('Workflow exceeds 200 jobs');
  const validIds = new Set(entries.map(([id]) => id).filter(identifier));
  const triggers = typeof data.on === 'string' ? [data.on] : Array.isArray(data.on) ? data.on : map(data.on) ? Object.keys(data.on) : [];
  const rows = [];
  const uses = (value,node,job,reusable) => {
    const line = at(node);
    if (dynamic(value)) return {line,status:'unresolved',kind:'runtime-expression'};
    if (typeof value !== 'string' || value.length > 512 || /[\x00-\x20]/.test(value)) return {line,status:'invalid',kind:'uses'};
    if (value.startsWith('$/')) return {line,status:'unresolved',kind:'repository-relative',reason:'Repository-bound $/ references are not resolved against the workspace'};
    if (!value.startsWith('./')) return {line,status:'not-fetched',kind:value.startsWith('docker://')?'container':'remote'};
    let result;
    if (reusable) result = /^\.\/\.github\/workflows\/[^/]+\.ya?ml$/.test(value)
      ? referenceEvidence(files,project,value) : {status:'unsupported-workflow-location'};
    else {
      const directory = referenceEvidence(files,project,value,true);
      if (directory.status !== 'present' && directory.status !== 'case-mismatch') result = directory;
      else {
        const candidates = ['action.yml','action.yaml'].map(name => referenceEvidence(files,project,path.join(value,name)));
        result = candidates.find(row => row.status === 'present') ?? candidates.find(row => row.status === 'case-mismatch') ?? {status:'missing-action-definition'};
        if (directory.status === 'case-mismatch' && result.status === 'present') result = {...result,status:'case-mismatch'};
      }
    }
    if (!['present','case-mismatch'].includes(result.status)) finding('local-use-'+result.status,line,job);
    if (result.status === 'case-mismatch') finding('local-use-case-mismatch',line,job);
    return {line,kind:reusable?'local-workflow':'local-action',reference:value,...result};
  };
  for (const [id,job] of entries) {
    const node = doc.getIn(['jobs',id],true), line = at(node);
    if (!identifier(id)) { finding('invalid-job-id',line); continue; }
    if (!map(job)) { finding('job-mapping-required',line,id); continue; }
    const rawNeeds = job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];
    const needs = [];
    if (rawNeeds.length > 200) throw Error('Job exceeds 200 needs entries');
    for (const need of rawNeeds) {
      if (dynamic(need)) { finding('unresolved-needs',at(doc.getIn(['jobs',id,'needs'],true)),id); continue; }
      if (!identifier(need)) { finding('invalid-needs',line,id); continue; }
      needs.push(need);
      if (!validIds.has(need)) finding('unknown-needed-job',line,id);
    }
    const row = {id,line,needs:[...new Set(needs)],matrix:matrixSummary(job.strategy?.matrix),uses:[]};
    if (job.uses !== undefined) row.uses.push(uses(job.uses,doc.getIn(['jobs',id,'uses'],true),id,true));
    if (job.steps !== undefined && !Array.isArray(job.steps)) finding('steps-list-required',line,id);
    if (Array.isArray(job.steps)) {
      if (job.steps.length > 500) throw Error('Job exceeds 500 steps');
      job.steps.forEach((step,index) => { if (map(step) && step.uses !== undefined) row.uses.push(uses(step.uses,doc.getIn(['jobs',id,'steps',index,'uses'],true),id,false)); });
    }
    if (row.matrix.status === 'invalid') finding('invalid-matrix',at(doc.getIn(['jobs',id,'strategy','matrix'],true)),id);
    rows.push(row);
  }
  const byId = new Map(rows.map(row => [row.id,row])), colors = new Map(), order = [], cycles = [];
  const visit = (id,trail) => {
    if (colors.get(id) === 1) { cycles.push([...trail.slice(trail.indexOf(id)),id]); return; }
    if (colors.get(id) === 2 || !byId.has(id)) return;
    colors.set(id,1);
    for (const need of byId.get(id).needs) visit(need,[...trail,id]);
    colors.set(id,2);order.push(id);
  };
  for (const row of rows) visit(row.id,[]);
  for (const cycle of cycles.slice(0,20)) finding('needs-cycle',byId.get(cycle[0]).line,cycle[0]);
  return {path:args.path,parsed:true,triggers:triggers.filter(identifier).slice(0,50),...paginate(rows,args),findings:findings.slice(0,200),findings_truncated:findings.length>200,cycles:cycles.slice(0,20),topological_order:cycles.length?null:order,scope:'Static literal structure only. Conditions, permissions, runtime expressions, remote actions and workflow execution are not evaluated. Local references are workspace observations, not checkout guarantees.'};
}
