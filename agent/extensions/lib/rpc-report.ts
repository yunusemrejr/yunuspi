/** Bounded human-facing RPC reports. They never enter model context or wake a turn. */
export function showRpcReport(pi: any, title: string, lines: readonly string[]): void {
	const clean = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
	const limit = 32_000;
	const rows = lines.length > 200 ? [...lines.slice(0, 120), `[${lines.length - 200} lines omitted]`, ...lines.slice(-80)] : lines;
	const text = rows.map(clean).join("\n");
	const truncated = lines.length > 200 || text.length > limit;
	const body = text.length > limit ? `${text.slice(0, 24_000)}\n[Middle omitted]\n${text.slice(-8_000)}` : text;
	pi.sendMessage({ customType: "rpc-report", content: `${clean(title).slice(0, 160)}\n\n${body}${truncated ? "\n[Report truncated; request a narrower view for more detail.]" : ""}`,
		display: true, excludeFromContext: true }, { triggerTurn: false });
}
