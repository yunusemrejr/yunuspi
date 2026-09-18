// A renewable resource window, independent of the logical task lifetime.
// The runner owns the expiry timer; a fake clock exercises boundary behavior.
export function createBrowserLease(now = Date.now) {
  const durationMs = 10 * 60_000, actionLimit = 200;
  let expiresAt = now() + durationMs, actions = 0, generation = 1;
  const assertLive = () => {
    if (now() >= expiresAt) throw Error("Browser session lease expired; open a new session and reconcile pending work");
  };
  return {
    durationMs,
    consume(action) {
      if (action === "close") return;
      assertLive();
      // Recovery reads and renewal remain possible when the action budget is spent.
      if (["renew", "snapshot", "inspect", "verify", "logs", "network", "screenshot", "markers", "observe", "html"].includes(action)) return;
      if (actions >= actionLimit) throw Error("Browser session action limit reached; inspect current state and renew before continuing");
      actions++;
    },
    renew() {
      assertLive();
      expiresAt = now() + durationMs;
      actions = 0;
      generation++;
    },
    receipt() {
      return { generation, expiresAt: new Date(expiresAt).toISOString(), remainingMs: Math.max(0, expiresAt - now()), actionsRemaining: actionLimit - actions };
    },
  };
}
