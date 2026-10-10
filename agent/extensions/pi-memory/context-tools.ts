import { Type } from '@yunuspi/ai';
import { makeCapsule, type ContextItem } from './context-salience.ts';
export function registerContextTools(pi: any, directory: () => string) {
  if (process.env.PI_CONTEXT_MEMORY === 'off') return;
  const output = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });
  const state = Type.String({ description: 'JSON array of {id,text,kind?,source?,timestamp?,unresolved?}. Kinds: goal,constraint,finding,decision,file,failure,next_action. <=1024 items.' });
  const parse = (s: string): ContextItem[] => { if (typeof s !== 'string' || s.length > 262144) throw Error('Items JSON exceeds 256 KiB.'); return JSON.parse(s); };
  pi.registerTool({ name: 'handoff_capsule', label: 'Handoff capsule', description: 'Build an extractive goal/findings/decisions/files/failures/next_action capsule for a fresh subagent task. Include user constraints and unresolved items explicitly. Default 2200 character budget (~500 tokens for English only; not tokenizer guaranteed). Critical overflow rejects; originals remain authoritative. Pass capsule in subagent task rather than forking full history.', parameters: Type.Object({ goal: Type.String(), items: state, maxChars: Type.Optional(Type.Number()) }), async execute(_id: string, args: any, signal?: AbortSignal) { signal?.throwIfAborted(); return output(makeCapsule(parse(args.items), args.goal, args.maxChars ?? 2200)); } });
}
