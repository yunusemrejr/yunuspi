/** Bounded source diagnostics, not a renderer, sanitizer or XML validator. */
import {createHash} from 'node:crypto';

export async function inspectSvg(source: string) {
  if (typeof source !== 'string' || source.length>65536 || Buffer.byteLength(source)>65536) throw Error('SVG text must be a string of at most 64 KiB');
  const {Parser}=await import('htmlparser2');
  const findings=new Map<string,{key:string;severity:string;message:string;count:number;offsets:number[]}>();
  const note=(key:string,message:string,offset:number,severity='review')=>{
    const item=findings.get(key)??{key,severity,message,count:0,offsets:[]};
    item.count++;if(item.offsets.length<4)item.offsets.push(offset);findings.set(key,item);
  };
  const ids=new Set<string>(), refs:{id:string;offset:number}[]=[];
  const counts={elements:0,paths:0,pathCommandLetters:0,filters:0,filterPrimitives:0,masks:0,gradients:0,animations:0,images:0};
  let depth=0,roots=0,attributes=new Set<string>(),root:Record<string,string>={},rootName='',titles=0,viewBox:number[]|null=null;
  const reference=(value:string,offset:number)=>{
    const trimmed=value.trim();
    if(trimmed.startsWith('#')) {
      let id=trimmed.slice(1);try{id=decodeURIComponent(id);}catch{}
      refs.push({id,offset});
    } else if(trimmed) note('external-reference','Non-fragment reference: review resource availability and trust in the intended embedding context.',offset);
  };
  const urls=(value:string,offset:number)=>{
    // ponytail: literal CSS url() only; escaped URLs and the cascade need browser review.
    for(const match of value.matchAll(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi))reference(match[2],offset);
  };
  const stack:string[]=[];
  const parser=new Parser({
    onopentagname(){
      attributes=new Set();
      if(++counts.elements>4096 || depth>=64)throw Error('SVG exceeds 4096 elements or 64 nesting levels');
    },
    onattribute(name,_value,quote){
      if(attributes.has(name))note('duplicate-attribute','Repeated XML attribute requires repair.',parser.startIndex,'error');
      attributes.add(name);
      if(quote==null)note('unquoted-attribute','XML attributes require quoted values.',parser.startIndex,'error');
    },
    onopentag(name,attrs){
      const offset=parser.startIndex;
      if(depth++===0){roots++;if(roots===1){root=attrs;rootName=name;}}
      stack.push(name);
      if(attrs.id){if(ids.has(attrs.id))note('duplicate-id','Duplicate IDs can resolve gradients, masks or accessible names to the wrong element.',offset,'error');ids.add(attrs.id);}
      if(name==='path'){counts.paths++;counts.pathCommandLetters+=(attrs.d?.match(/[AaCcHhLlMmQqSsTtVvZz]/g)??[]).length;}
      if(name==='filter')counts.filters++;
      if(/^fe[A-Z]/.test(name))counts.filterPrimitives++;
      if(name==='mask')counts.masks++;
      if(name==='linearGradient'||name==='radialGradient')counts.gradients++;
      if(['animate','animateMotion','animateTransform','set'].includes(name))counts.animations++;
      if(name==='image')counts.images++;
      if(name==='title')titles++;
      if(['script','foreignObject'].includes(name))note('active-content','Script or foreignObject needs an explicit trust and embedding review; this tool does not sanitize it.',offset);
      for(const [key,value]of Object.entries(attrs)){
        if(/^on/i.test(key))note('event-handler','Event-handler attribute can execute code in active SVG contexts.',offset);
        if(key==='href'||key==='xlink:href')reference(value,offset);
        if(key==='aria-labelledby'||key==='aria-describedby')for(const id of value.trim().split(/\s+/).filter(Boolean))refs.push({id,offset});
        urls(value,offset);
      }
    },
    onclosetag(_name,implied){
      if(implied && !/\/\s*>$/.test(source.slice(parser.startIndex,parser.endIndex+1)))note('xml-recovery','Parser recovered missing or misnested closing tags; repair source before rendering.',parser.startIndex,'error');
      depth--;stack.pop();
    },
    ontext(text){
      if(depth===0 && text.trim())note('outside-root','Text outside the root element requires XML review.',parser.startIndex,'error');
      if(stack.at(-1)==='style'){
        urls(text,parser.startIndex);
        if(/@import\b/i.test(text))note('external-reference','CSS import may load another resource; inspect it in the intended embedding context.',parser.startIndex);
        note('stylesheet','Embedded CSS needs browser review for the cascade, animation, contrast and reduced-motion behavior.',parser.startIndex);
      }
    },
    onprocessinginstruction(name){if(/^!(?:doctype|entity)$/i.test(name))throw Error('SVG document types and entities are not supported');},
  },{xmlMode:true,decodeEntities:true});
  parser.end(source);
  if(roots!==1 || rootName!=='svg')note('svg-root','Expected exactly one unprefixed SVG root element.',0,'error');
  if(root.viewBox!==undefined){
    const value=root.viewBox.trim();
    const scalar='[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?';
    const valid=new RegExp(`^${scalar}(?:(?:\\s*,\\s*|\\s+)${scalar}){3}$`).test(value);
    const parts=value.split(/[\s,]+/).map(Number);
    if(valid&&parts.every(Number.isFinite)&&parts[2]>0&&parts[3]>0)viewBox=parts;
    else note('invalid-viewbox','viewBox needs four finite numbers with positive width and height.',0,'error');
  }else note('missing-viewbox','No viewBox: verify responsive sizing and the intended coordinate space.',0);
  for(const {id,offset}of refs)if(!ids.has(id))note('missing-reference','A local fragment or accessible-name reference has no matching ID in this document.',offset,'error');
  if(root['aria-hidden']!=='true'&&!root['aria-label']?.trim()&&!root['aria-labelledby']?.trim()&&!titles)note('accessible-name','No local accessible-name cue: verify informative versus decorative use, including host markup.',0);
  if(counts.filters||counts.masks)note('compositing-cost','Filters or masks may add raster/compositing work; measure at target size and during animation before reducing detail.',0);
  if(counts.animations)note('motion','Verify animation timing, pause behavior and reduced-motion handling in a rendered browser.',0);
  return {operation:'svg',status:[...findings.values()].some(x=>x.severity==='error')?'issues':'inspected',sourceHash:createHash('sha256').update(source).digest('hex'),utf8Bytes:Buffer.byteLength(source),viewBox,counts,findings:[...findings.values()],positionUnit:'zero-based UTF-16 offset',scope:'Source cues only. XML validity, geometry, CSS escapes/cascade, security, visual quality, accessibility and runtime performance are not certified. No resources are fetched or executed; no findings does not establish correctness.'};
}
