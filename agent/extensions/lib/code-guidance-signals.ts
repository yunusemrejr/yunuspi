import { codeLexicalMask } from "./code-lexical-mask.ts";
/** Bounded hints from agent-authored edits only. Heuristics, never diagnostics.
 * No repository scans, tool-output instructions, dependencies or inferred tool calls. */
export type CodeSignal = { key: string; skill: string; check: string };
export function codeGuidanceSignals(file: string, value: unknown): CodeSignal[] {
  if (typeof value !== 'string' || !/\.(?:[cm]?[jt]sx?|py|rs|go|java|c|cpp|h|php|vue|svelte)$/i.test(file)) return [];
  if (/(?:^|\/)(?:node_modules|vendor|dist|build|fixtures?|__fixtures__)\/|\.(?:min|generated)\./i.test(file)) return [];
  // Skip oversized edits instead of drawing conclusions from a severed expression.
  if (value.length > 24000) return [];
  const result: CodeSignal[] = [];
  const add = (key: string, skill: string, check: string) => result.push({key,skill,check});
  const js = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(file);
  const masked = js ? codeLexicalMask(value) : {code:value,directives:false};
  value = masked.code;
  if (js && /\.forEach\s*\(\s*async\b/.test(value))
    add('async-foreach','behavioral-contracts','An async forEach pattern was observed. Check whether the caller must await completion and propagate failures; choose sequential or bounded concurrent execution to match the intended contract.');
  if (js && /new\s+Promise\s*\(\s*async\b/.test(value))
    add('async-executor','behavioral-contracts','An async Promise executor was observed. Verify rejection propagation and completion; an async function or a synchronous executor may express the intended lifecycle more reliably.');
  if (/\bcatch\s*(?:\([^)]{0,160}\))?\s*\{\s*\}/.test(value))
    add('empty-catch','coding-practices','An empty catch was observed. Check whether ignoring this failure is intentional and preserves the contract; otherwise propagate or handle it at the existing error owner.');
  if (/\.(?:ts|tsx|mts|cts)$/.test(file) && (masked.directives || /\bas\s+any\b/.test(value)))
    add('type-bypass','type-driven-design','A type-check bypass was observed. Check the actual boundary contract before widening types; if the escape hatch is required, keep it narrow and verify the unchecked behavior.');
  if (/\.py$/i.test(file) && /\b(?:np|numpy)\.linalg\.inv\s*\(/.test(value) && /@|\b(?:dot|matmul)\s*\(/.test(value))
    add('inverse-product','numerical-computing','An explicit matrix inverse and matrix product were observed. If solving a system, consider a direct solve and check residuals and conditioning; do not rewrite a genuinely required inverse blindly.');
  return result.slice(0,3);
}
