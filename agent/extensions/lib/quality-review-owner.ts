import path from 'node:path';

// A lightweight process-local rendezvous. Child watchdogs must not import the
// project scanner, source review lifecycle or provider runner to check ownership.
const OWNERS = Symbol.for('yunus-pi.quality-review-owners.v1');
type Owner = { owner: object; available(): boolean; settle(ctx: any, signal?: AbortSignal): Promise<void>; snapshot(): any };
const owners = (): Map<string, Owner> => (globalThis as any)[OWNERS] ??= new Map();
const scope = (ctx: any): string | undefined => {
  try {
    const session = ctx?.sessionManager?.getSessionId?.() ?? ctx?.sessionManager?.getSessionFile?.();
    return typeof session === 'string' && session && typeof ctx?.cwd === 'string' ? JSON.stringify([path.resolve(ctx.cwd),session]) : undefined;
  } catch { return undefined; }
};

export function registerSharedQualityReview(ctx: any, entry: Owner): () => void {
  const key = scope(ctx);
  if (!key) return () => {};
  owners().set(key,entry);
  return () => { if (owners().get(key) === entry) owners().delete(key); };
}

/** Join the existing owner's tests, budgets, cancellation and delivery rules;
 * return no owner when a session was replaced, disabled or shut down. */
export async function settleSharedQualityReview(ctx: any, signal?: AbortSignal): Promise<any | undefined> {
  const key = scope(ctx), entry = key ? owners().get(key) : undefined;
  if (!entry?.available() || signal?.aborted || ctx.signal?.aborted) return undefined;
  await entry.settle(ctx, signal);
  return scope(ctx) === key && owners().get(key!) === entry && entry.available() && !signal?.aborted && !ctx.signal?.aborted ? entry.snapshot() : undefined;
}

// When the last decisive review round completed, per session scope. Feeds the
// review-coordinator recent-run suppression so a stuck-signal suggestion does
// not fire right after independent review already ran. Timestamps only.
const COMPLETED = Symbol.for('yunus-pi.quality-review-completed.v1');
const completed = (): Map<string, number> => (globalThis as any)[COMPLETED] ??= new Map();

export function noteQualityReviewCompleted(ctx: any, at = Date.now()): void {
  const key = scope(ctx);
  if (key) completed().set(key, at);
}

export function lastQualityReviewCompletedAt(ctx: any): number | undefined {
  const key = scope(ctx);
  return key ? completed().get(key) : undefined;
}
