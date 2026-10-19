/**
 * Dormant entry for project intelligence (graph worker, viewer, capsules).
 *
 * Retired by default under the lean harness policy. The implementation
 * (lib/project-intelligence-impl.ts) is only imported when
 * PI_LEAN_GATES=on, so a default boot does not pay its module graph for a
 * layer that then immediately returns.
 */
export default async function projectIntelligence(pi: any) {
	if (process.env.PI_LEAN_GATES !== "on") return;
	const impl = await import("./lib/project-intelligence-impl.ts");
	return impl.default(pi);
}
