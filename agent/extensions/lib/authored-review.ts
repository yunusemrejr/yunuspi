import {codeGuidanceSignals, type CodeSignal} from './code-guidance-signals.ts';
import {qualityReviewSignals} from './quality-review-signals.ts';
import {slopGuidanceSignals, UI_POLICY_KEYS} from './slop-guidance-signals.ts';
import {auditSource} from './code-audit.ts';

/** Independent replacements stay separate; large files use bounded overlapping
 * windows so a stylesheet does not silently lose all checks at 24K. */
export function authoredReviewSnippets(tool: string, input: any): string[] {
  const snippets: unknown[] = tool === 'edit' && Array.isArray(input?.edits)
    ? input.edits.length <= 64 ? input.edits.map((e: any)=>e?.newText) : []
    : [tool === 'write' ? input?.content : input?.newText];
  const valid = snippets.filter((v): v is string=>typeof v === 'string');
  if (valid.reduce((n,s)=>n+s.length,0) > 256000) return [];
  return valid.flatMap(text => {
    if (text.length <= 24000) return [text];
    // Strip comments before windowing; a window must not expose the middle of
    // a large comment as authored presentation.
    text = text.replace(/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//g, '');
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 22000) chunks.push(text.slice(i, i + 24000));
    return chunks;
  });
}

/** Security and runtime cues from the static audit, one signal per review aspect. */
function auditSignals(file: string, text: string): CodeSignal[] {
  if (text.length > 24000) return [];
  const found = auditSource(file,text,{domains:['security','backend','efficiency'],minSeverity:'medium'});
  const named = (security: boolean) => [...new Set(found.filter(f=>(f.domain==='security')===security).map(f=>f.rule))].slice(0,3).join(', ');
  const out: CodeSignal[] = [];
  const sec = named(true), run = named(false);
  if (sec) out.push({key:'audit-security',skill:'web-security',check:`The static audit flagged ${sec} in this edit. Trace the value from its untrusted source to the sink; fix the boundary (parameterize, allowlist, encode) or record why the input is trusted. code_audit({changed:true}) lists locations.`});
  if (run) out.push({key:'audit-runtime',skill:'behavioral-contracts',check:`The static audit flagged ${run} in this edit. Check the failure path under load (timeouts, batching, blocking calls, error exposure) and confirm with a measurement or a test, not by inspection alone.`});
  return out;
}

export function authoredReviewSignals(file: string, snippets: string[]) {
  const signals = snippets.flatMap(text=>[...codeGuidanceSignals(file,text), ...slopGuidanceSignals(file,text,12), ...qualityReviewSignals(file,text), ...auditSignals(file,text)]);
  return [...new Map(signals.map(s=>[s.key,s])).values()].sort((a,b)=>Number(UI_POLICY_KEYS.has(b.key))-Number(UI_POLICY_KEYS.has(a.key))).slice(0,12);
}
