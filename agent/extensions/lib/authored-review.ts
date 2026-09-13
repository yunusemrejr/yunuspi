import {codeGuidanceSignals} from './code-guidance-signals.ts';
import {qualityReviewSignals} from './quality-review-signals.ts';
import {slopGuidanceSignals} from './slop-guidance-signals.ts';

/** Independent native replacements stay separate. Oversized batches abstain. */
export function authoredReviewSnippets(tool: string, input: any): string[] {
  const snippets: unknown[] = tool === 'edit' && Array.isArray(input?.edits)
    ? input.edits.length <= 64 ? input.edits.map((e: any)=>e?.newText) : []
    : [tool === 'write' ? input?.content : input?.newText];
  const valid = snippets.filter((v): v is string=>typeof v === 'string');
  return valid.reduce((n,s)=>n+s.length,0) <= 24000 ? valid : [];
}

export function authoredReviewSignals(file: string, snippets: string[]) {
  const signals = snippets.flatMap(text=>[...codeGuidanceSignals(file,text), ...slopGuidanceSignals(file,text), ...qualityReviewSignals(file,text)]);
  return [...new Map(signals.map(s=>[s.key,s])).values()].slice(0,12);
}
