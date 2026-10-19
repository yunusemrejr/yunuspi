/**
 * Dormant entry for adaptive workflows (task pipelines, councils).
 *
 * Retired by default under the lean harness policy. The implementation
 * (lib/adaptive-workflows-impl.ts) is only imported when PI_LEAN_GATES=on,
 * so a default boot does not pay its module graph for a layer that then
 * immediately returns.
 */
export default async function adaptiveWorkflows(pi: any) {
	if (process.env.PI_LEAN_GATES !== "on") return;
	const impl = await import("./lib/adaptive-workflows-impl.ts");
	return impl.default(pi);
}
