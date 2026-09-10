/** Tiny sparse nearest-prototype classifier. Curated examples, not learned user data.
 * Scores are cosine similarities, not calibrated probabilities. No I/O or dependencies. */
const examples = [
 ['web-component-patterns','keyboard focus tab order screen reader accessible dialog modal navigation'],
 ['linux-host-defense','server intrusion firewall ssh hardening exposed ports untrusted host'],
 ['classical-ml-modeling','tabular classifier validation leakage train split features baseline prediction'],
 ['ui-antipattern-review','visual hierarchy spacing typography contrast clutter generic interface'],
 ['llm-systems-engineering','tokenizer attention quantization inference transformer memory kernels'],
 ['natural-editorial-writing','prose paragraphs wording editorial voice repetitive filler clarity'],
] as const;
const stop=new Set('a an the and or for of to in on with this that it is be please can could would my our your implement build make improve review fix inspect check'.split(' '));
function terms(text:string) {
 const counts=new Map<string,number>();
 for(const raw of text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g)??[]) {
  if(stop.has(raw)) continue;
  const t=raw.length>5&&raw.endsWith('s')?raw.slice(0,-1):raw;
  counts.set(t,1); // binary features prevent keyword repetition from amplifying confidence
 }
 return counts;
}
const prototypes=examples.map(([name,text])=>({name,features:terms(text)}));
export function localIntent(prompt:string): {name:string;similarity:number;overlap:number}|undefined {
 if(typeof prompt!=='string') return;
 const features=terms(prompt.slice(0,8192));
 if(features.size<3) return;
 const ranked=prototypes.map(p=>{
  let overlap=0;for(const t of p.features.keys())if(features.has(t))overlap++;
  return {name:p.name,overlap,similarity:overlap/Math.sqrt(features.size*p.features.size)};
 }).sort((a,b)=>b.similarity-a.similarity);
 const best=ranked[0];
 if(best.overlap<3 || best.similarity<0.30 || best.similarity-ranked[1].similarity<0.12)return;
 try { (globalThis as any)[Symbol.for("yunus-pi.health.v1")]?.("ml.intent",{route:best.name,similarity:best.similarity,overlap:best.overlap}); } catch {}
 return best;
}

const parallel=terms('independent perspectives alternatives compare tradeoffs crosscheck competing approaches separate investigations');
const narrow=terms('single cosmetic typo rename formatting spelling trivial small localized');
/** Only sizes an already-authorized bounded advisory group; cannot launch or price routes. */
export function localReviewBreadth(prompt:string): 1|2 {
 const input=terms(prompt.slice(0,8192));
 let positive=0,negative=0;
 for(const t of input.keys()){if(parallel.has(t))positive++;if(narrow.has(t))negative++;}
 const similarity=positive/Math.sqrt(Math.max(1,input.size)*parallel.size);
 return positive>=3 && negative===0 && similarity>=0.25 ? 2 : 1;
}
