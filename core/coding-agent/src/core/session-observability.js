import { AsyncLocalStorage } from "node:async_hooks";

// Extension modules may be loaded more than once by jiti. Share the context
// carrier, never a session's values, across copies of the owned core.
const key = Symbol.for("yunus-pi.observability-context.v1");
const state = globalThis[key] ??= { storage: new AsyncLocalStorage(), owners: new WeakMap() };

/** Existing optional telemetry taps, partitioned by runtime and session. */
export function sessionObservability() {
    return state.storage.getStore()?.values ?? globalThis;
}

/** Capture identity before asynchronous work; late completions retain that
 * identity even if the same SessionManager subsequently switches sessions. */
export function withSessionObservability(ctx, callback) {
    let manager, id;
    try { manager = ctx?.sessionManager; id = manager?.getSessionId?.(); } catch { /* stale context */ }
    if (!manager || typeof manager !== "object" || typeof id !== "string" || !id) return callback();
    let scope = state.owners.get(manager);
    if (!scope || scope.id !== id) {
        scope = { id, values: Object.create(null) };
        state.owners.set(manager, scope);
    }
    return state.storage.run(scope, callback);
}
