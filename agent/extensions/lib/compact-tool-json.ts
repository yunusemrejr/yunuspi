/** Lossless JSON lexical compaction for known structured tools, at context assembly.
 * Does not reserialize numbers/keys/escapes or mutate persisted/displayed results. */
const STRUCTURED_TOOLS = new Set([
  'project_report', 'module_report', 'symbol_search', 'symbol_references',
  'session_self', 'checkpoint_read', 'todo', 'subagent', 'bg_status', 'bg_list',
  'memory_search', 'memory_read', 'web_probe', 'web_search',
  'context_score', 'handoff_capsule', 'evidence_cache', 'data_query',
  'math_check', 'artifact_check', 'value_convert', 'quality_review',
  'skill_review', 'session_audit', 'dependency_plan',
  'sqlite_probe', 'package_probe', 'openapi_probe', 'coverage_probe',
  'contract_diff', 'env_audit', 'net_probe', 'archive_probe',
  'http_request', 'sys_probe',
]);
export function compactJsonWhitespace(text: string, minimumSavings = 128): string {
  if (text.length < (minimumSavings === 0 ? 0 : 512) || text.length > 1_000_000 || !/^\s*[\[{]/.test(text)) return text;
  try { JSON.parse(text); } catch { return text; }
  let quoted = false, escaped = false, start = 0;
  const pieces: string[] = [];
  for (let i=0;i<text.length;i++) {
    const c=text[i];
    if (quoted) {
      if (escaped) escaped=false;
      else if(c==='\\') escaped=true;
      else if(c==='"') quoted=false;
    } else if(c==='"') quoted=true;
    else if(c===' ' || c==='\n' || c==='\r' || c==='\t') {
      if(start<i) pieces.push(text.slice(start,i));
      start=i+1;
    }
  }
  pieces.push(text.slice(start));
  const compact=pieces.join('');
  return text.length-compact.length>=minimumSavings ? compact : text;
}
export function createToolJsonCompactor() {
  // Text-keyed memoization avoids repeated parsing of growing history. Bounded,
  // in-memory only; cache eviction changes CPU work, never payload bytes.
  const cache=new Map<string,string>();
  let retained=0;
  const compact=(text:string)=>{
    const cached=cache.get(text); if(cached!==undefined)return cached;
    const result=compactJsonWhitespace(text);
    if(text.length<=1_000_000) {
      const size=text.length+result.length;
      while(cache.size && (retained+size>2_000_000 || cache.size>=64)) {
        const key=cache.keys().next().value!;
        retained-=key.length+cache.get(key)!.length; cache.delete(key);
      }
      cache.set(text,result); retained+=size;
    }
    return result;
  };
  return {
    reset(){cache.clear();retained=0;},
    transform(messages:any[]):any[] {
      if(process.env.PI_COMPACT_TOOL_JSON==='off')return messages;
      let changed=false;
      const result=messages.map(message=>{
        if(message.role!=='toolResult' || !STRUCTURED_TOOLS.has(message.toolName))return message;
        if(typeof message.content==='string') {
          const content=compact(message.content);
          if(content===message.content)return message;
          changed=true;return {...message,content};
        }
        if(!Array.isArray(message.content))return message;
        let changedContent=false;
        const content=message.content.map((part:any)=>{
          if(part?.type!=='text' || typeof part.text!=='string')return part;
          const text=compact(part.text);if(text===part.text)return part;
          changedContent=true;return {...part,text};
        });
        if(!changedContent)return message;
        changed=true;return {...message,content};
      });
      return changed?result:messages;
    },
  };
}
