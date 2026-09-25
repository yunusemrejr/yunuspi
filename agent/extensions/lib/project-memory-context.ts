/** Session-scoped access to the existing vector-memory extension. No second
 * store, embedder or retrieval implementation lives in consumers. */
import { sessionObservability } from './session-observability.ts';
import { wantsNoObserver } from './session-observer.ts';
import { promptRequestFocus } from './prompt-interpretation.ts';
import type { RetrievalRole } from './project-memory-retrieve.ts';

export const PROJECT_MEMORY_RECALL = Symbol.for('yunus-pi.project-memory-recall.v1');
export type ProjectMemoryRecall = (cwd: string, query: string, role: RetrievalRole, signal: AbortSignal) => Promise<string>;

export async function recallProjectContext(cwd: string, request: string, role: RetrievalRole, signal?: AbortSignal): Promise<string> {
  const recall = sessionObservability()[PROJECT_MEMORY_RECALL] as ProjectMemoryRecall | undefined;
  const query = promptRequestFocus(request).replace(/\s+/g, ' ').trim().slice(0, 512);
  if (!recall || query.length < 16 || signal?.aborted || wantsNoObserver(request)) return '';
  const deadline = AbortSignal.timeout(1200);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let abort: (() => void) | undefined;
  try {
    // Optional recall never holds a foreground request behind a stuck helper.
    return await Promise.race([recall(cwd, query, role, bounded), new Promise<string>(resolve => {
      abort = () => resolve(''); bounded.addEventListener('abort', abort, { once: true });
    })]);
  } catch { return ''; }
  finally { if (abort) bounded.removeEventListener('abort', abort); }
}
