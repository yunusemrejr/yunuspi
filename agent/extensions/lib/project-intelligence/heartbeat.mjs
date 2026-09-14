/**
 * Pure heartbeat policy for project intelligence.
 *
 * The session heartbeat still reports activity on every beat, but a full graph
 * refresh is warranted only when the session has pending changes. An idle
 * sweep keeps externally edited files visible at a lower frequency so a long
 * session no longer re-scans the whole tree every 30 seconds.
 */
export const IDLE_REFRESH_EVERY = 4;

/**
 * @param {{ idleBeats: number, pendingChanges: number, idleRefreshEvery?: number }} options
 * @returns {{ refresh: boolean, nextIdleBeats: number }}
 */
export function heartbeatPlan(options) {
  const every = Math.max(
    1,
    Math.floor(options.idleRefreshEvery ?? IDLE_REFRESH_EVERY),
  );
  const pending = options.pendingChanges > 0;
  const beat =
    (Number.isFinite(options.idleBeats)
      ? Math.max(0, Math.floor(options.idleBeats))
      : 0) + 1;
  const refresh = pending || beat >= every;
  return { refresh, nextIdleBeats: refresh ? 0 : beat };
}
