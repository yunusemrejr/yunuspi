/**
 * Dormant entry for the session observer (and Mr. Watchmaker).
 *
 * Retired by default under the lean harness policy; goal self-verification
 * replaces it. The implementation (lib/session-observer-impl.ts) is only
 * imported when PI_LEAN_GATES=on, so a default boot does not pay its module
 * graph (observer book, journal, subagent model routing) for a layer that
 * then immediately returns.
 */
export default async function sessionObserver(pi: any, testing: any = {}) {
	if (process.env.PI_LEAN_GATES !== "on") return;
	const impl = await import("./lib/session-observer-impl.ts");
	return impl.default(pi, testing);
}
