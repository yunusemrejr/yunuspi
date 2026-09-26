import { registerContinuationSource } from '../../../lib/continuation-notice.ts';
import type { SubagentState } from '../shared/types.ts';

/** Observe the native job owner; do not launch, wait, or schedule another wake. */
export function registerSubagentContinuation(state: Pick<SubagentState, 'currentSessionId' | 'asyncJobs'>, session: object): () => void {
  const activeCount = () => state.currentSessionId ? [...state.asyncJobs.values()].filter(job =>
    job.sessionId === state.currentSessionId && (job.status === 'queued' || job.status === 'running')).length : 0;
  const verificationText = (): { count: number; text: string } | undefined => {
    const count = activeCount();
    return count ? { count, text: `${count} delegated ${count === 1 ? 'run has' : 'runs have'} not finished. Pending results cannot support a completed or verified claim.` } : undefined;
  };
  return registerContinuationSource({
    name: 'subagents', session,
    pending: () => { const count = activeCount(); return count ? [`${count} delegated ${count === 1 ? 'run is' : 'runs are'} still active; native completion notifications will report their results.`] : []; },
    verification: () => { const item = verificationText(); return item ? [item.text] : []; },
    verificationReceipts: () => { const item = verificationText(); return item ? [{ source: 'subagents', id: 'active-runs', state: 'pending', count: item.count, line: `subagents: ${item.text}` }] : []; },
  });
}
