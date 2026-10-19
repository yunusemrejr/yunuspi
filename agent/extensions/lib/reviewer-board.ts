import { randomUUID } from 'node:crypto';

/** Everything that puts a note on the board: Guardian and the observer. */
export type ReviewerSource = 'guardian' | 'observer';
const REVIEWER_LABELS: Record<ReviewerSource, string> = { guardian: 'Guardian', observer: 'Observer' };
export const reviewerLabel = (reviewer: string): string => REVIEWER_LABELS[reviewer as ReviewerSource] ?? 'A peer';

/** Shared note board for one session. Each source publishes its latest delivered note; the others see it as
 * evidence and suppress a restatement, so the agent is not told the same thing
 * twice or pulled in opposite directions by sources blind to each other.
 * In-process and bounded; nothing persists. */
const PEER_NOTES = Symbol.for('yunus-pi.reviewer-peer-notes.v1');
const PEER_OWNERS = Symbol.for('yunus-pi.reviewer-peer-owners.v1');
/** Two runtimes can reopen the same transcript. Share advice only between
 * reviewers attached to the same live manager, including its current branch identity. */
export function reviewerSessionKey(context: any): string {
  const manager = context?.sessionManager;
  if (!manager || typeof manager !== 'object') return '';
  const owners: WeakMap<object, string> = ((globalThis as any)[PEER_OWNERS] ??= new WeakMap());
  let owner = owners.get(manager);
  if (!owner) { owner = randomUUID(); owners.set(manager, owner); }
  return JSON.stringify([owner, context.cwd ?? '', manager.getSessionId?.() ?? '', manager.getSessionFile?.() ?? '']);
}

const boardText = (value: string, limit: number) => value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '').slice(-limit);
export interface ReviewerPeerNote { reviewer: string; note: string; picks: string[]; at: number }
const peerBoard = (): Map<string, Map<string, ReviewerPeerNote>> => ((globalThis as any)[PEER_NOTES] ??= new Map());
export function publishReviewerNote(session: string, reviewer: string, note: string, picks: string[] = [], at = Date.now()) {
  if (!session || !note) return;
  const board = peerBoard();
  const notes = board.get(session) ?? new Map<string, ReviewerPeerNote>();
  notes.set(reviewer, { reviewer, note: boardText(note, 1200), picks: picks.slice(0, 6), at });
  board.delete(session); board.set(session, notes);
  while (board.size > 16) board.delete(board.keys().next().value!);
}
/** Other reviewers' notes for this session, newest first, within maxAgeMs. */
export function peerReviewerNotes(session: string, reviewer: string, now = Date.now(), maxAgeMs = 600_000): ReviewerPeerNote[] {
  return [...(peerBoard().get(session)?.values() ?? [])].filter(row => row.reviewer !== reviewer && now - row.at <= maxAgeMs).sort((a, b) => b.at - a.at);
}

