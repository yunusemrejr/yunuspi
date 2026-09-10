/** Bounded, stateless calculations over supplied facts. No inference or I/O. */
export type Task = {id:string; after?:string[]};
function list(value:unknown, name:string, max:number, min=0): asserts value is any[] {
  if(!Array.isArray(value)||value.length<min||value.length>max)throw Error(`${name}: expected ${min}..${max} items`);
}
function id(value:unknown): asserts value is string {
  if(typeof value!=='string'||!value.length||value.length>64||/[\x00-\x1f]/.test(value))throw Error('IDs must be 1..64 printable characters');
}
function unique(values:string[],label:string) {const set=new Set(values);if(set.size!==values.length)throw Error(`${label}: duplicate IDs`);return set;}
export function dependencyPlan(tasks:Task[]) {
  list(tasks,'tasks',64,1);for(const t of tasks){if(!t||typeof t!=='object')throw Error('Invalid task');id(t.id);list(t.after??[],'after',16);for(const a of t.after??[])id(a);}
  const ids=unique(tasks.map(t=>t.id),'tasks');
  const after=new Map(tasks.map(t=>[t.id,new Set(t.after??[])]));
  const children=new Map(tasks.map(t=>[t.id,[] as string[]]));
  for(const [node,deps] of after)for(const dep of deps){if(!ids.has(dep))throw Error(`Unknown dependency ${dep}`);children.get(dep)!.push(node);}
  const degree=new Map([...after].map(([k,v])=>[k,v.size]));
  let ready=[...degree].filter(([,n])=>n===0).map(([k])=>k).sort();const layers:string[][]=[];
  while(ready.length){layers.push(ready);const next:string[]=[];for(const k of ready)for(const c of children.get(k)!){degree.set(c,degree.get(c)!-1);if(degree.get(c)===0)next.push(c);}ready=next.sort();}
  const blocked=[...degree].filter(([,n])=>n>0).map(([k])=>k).sort();
  // At most 64 nodes: a concrete cycle witness, not an accusation that all
  // blocked descendants themselves belong to a cycle.
  const visiting=new Set<string>(),done=new Set<string>(),stack:string[]=[];let cycle:string[]=[];
  function visit(k:string):boolean{if(visiting.has(k)){cycle=stack.slice(stack.indexOf(k)).concat(k);return true;}if(done.has(k))return false;visiting.add(k);stack.push(k);for(const d of after.get(k)!)if(visit(d))return true;stack.pop();visiting.delete(k);done.add(k);return false;}
  for(const k of blocked)if(visit(k))break;
  return {layers,blocked,...cycle.length?{cycle}:{},basis:'Declared dependencies only; a layer is not proof of resource-safe parallelism.'};
}
export type Criterion={id:string; goal:'min'|'max'};
export function decisionFrontier(criteria:Criterion[],options:{id:string;values:number[]}[]) {
  list(criteria,'criteria',8,1);list(options,'options',32,1);
  for(const c of criteria){if(!c||typeof c!=='object')throw Error('Invalid criterion');id(c.id);if(c.goal!=='min'&&c.goal!=='max')throw Error('goal must be min or max');}unique(criteria.map(c=>c.id),'criteria');
  for(const o of options){if(!o||typeof o!=='object')throw Error('Invalid option');id(o.id);list(o.values,'values',criteria.length,criteria.length);if(o.values.some(v=>typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>1e12))throw Error('values must be finite numbers within ±1e12; unknown is not zero');}unique(options.map(o=>o.id),'options');
  const dominated:{id:string;by:string}[]=[],frontier:string[]=[];
  for(const a of options){const winner=options.find(b=>b!==a && criteria.every((c,i)=>c.goal==='min'?b.values[i]<=a.values[i]:b.values[i]>=a.values[i]) && criteria.some((c,i)=>c.goal==='min'?b.values[i]<a.values[i]:b.values[i]>a.values[i]));if(winner)dominated.push({id:a.id,by:winner.id});else frontier.push(a.id);}
  return {frontier,dominated,basis:'Pareto comparison of supplied numbers; no hidden weights or winner among tradeoffs. Equal options remain on the frontier.'};
}
export type CoverageCandidate={id:string;covers:string[];cost?:number};
export function coverageSelect(requirements:string[],candidates:CoverageCandidate[]) {
  list(requirements,'requirements',64,1);requirements.forEach(id);const wanted=unique(requirements,'requirements');list(candidates,'candidates',64);
  for(const c of candidates){if(!c||typeof c!=='object')throw Error('Invalid candidate');id(c.id);list(c.covers,'covers',64);c.covers.forEach(id);for(const r of c.covers)if(!wanted.has(r))throw Error(`Unknown requirement ${r}`);if(c.cost!==undefined&&(typeof c.cost!=='number'||!Number.isFinite(c.cost)||c.cost<1e-9||c.cost>1e9))throw Error('cost must be positive, finite and within 1e-9..1e9');}unique(candidates.map(c=>c.id),'candidates');
  const pool=candidates.map(c=>({...c,cost:c.cost??1,covers:[...new Set(c.covers)]}));
  const remaining=new Set(requirements),selected:typeof pool=[];
  while(remaining.size){let best:typeof pool[number]|undefined,gain=0,ratio=0;
    for(const c of pool){const g=c.covers.filter(r=>remaining.has(r)).length,score=g/c.cost;if(g>0&&(!best||score>ratio||score===ratio&&(g>gain||g===gain&&c.id<best.id))){best=c;gain=g;ratio=score;}}
    if(!best)break;selected.push(best);for(const r of best.covers)remaining.delete(r);
  }
  // Remove redundant choices without sacrificing claimed coverage.
  for(let i=selected.length-1;i>=0;i--){const other=new Set(selected.filter((_,j)=>j!==i).flatMap(c=>c.covers));if(selected[i].covers.every(r=>other.has(r)))selected.splice(i,1);}
  return {selected:selected.map(c=>c.id),totalCost:selected.reduce((s,c)=>s+c.cost,0),uncovered:[...remaining],basis:'Greedy coverage/cost heuristic, not guaranteed optimal. Claimed coverage is not test execution or proof; preserve mandatory checks.'};
}
