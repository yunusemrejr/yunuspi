import { settleSharedQualityReview } from '../../../lib/quality-review-owner.ts';
import type { WatchdogReviewFunction } from './runtime.ts';

/** Default watchdogs supply local diagnostics and join the parent review's
 * existing budget/delivery owner. A configured model requests standalone review.
 * Children have no local quality owner: their diagnostics travel in the normal
 * child result and the parent reviews integrated source, without nested reviewers. */
export function createCoordinatedWatchdogReview(
  context: () => any,
  independent: WatchdogReviewFunction,
): WatchdogReviewFunction {
  return async request => {
    if (request.config.main.model) return independent(request);
    const ctx = context();
    if (ctx && !request.signal?.aborted && !ctx.signal?.aborted) {
      // The shared owner's longer deadline and native cancellation stay its
      // own. A watchdog finishing/timing out must not cancel a 90s quality run.
      void settleSharedQualityReview(ctx).catch(() => {});
    }
    return {stopReason:request.signal?.aborted ? 'aborted' : 'stop',warnings:[]};
  };
}
