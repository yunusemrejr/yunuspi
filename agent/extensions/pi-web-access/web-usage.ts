import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@yunuspi/coding-agent";

type TerminalStatus = "completed" | "failed" | "cancelled" | "timeout";
interface WebUsageReceipt {
	id: string;
	provider: string;
	model: string;
	status: "pending" | TerminalStatus;
	usage?: unknown;
}

export type WebUsageSink = (receipt: WebUsageReceipt) => void;
export interface WebUsageOptions {
	onUsage?: WebUsageSink;
}

const routePart = (part: string, fallback: string) =>
	/^[\w][\w./:@-]{0,127}$/.test(part) && !part.includes("://") ? part : fallback;

/** Start at the billable submission boundary. All outcomes of this physical
 * request keep the same identity, including failure after the provider billed. */
export function startWebUsage(options: WebUsageOptions, provider: string, model: string) {
	const write = options.onUsage;
	if (!write) return () => {};
	const identity = { id: randomUUID(), provider: routePart(provider, "web-provider"), model: routePart(model, "unknown-model") };
	const note = (status: WebUsageReceipt["status"], usage?: unknown) => {
		try { write({ ...identity, status, ...(usage === undefined ? {} : { usage }) }); }
		catch { /* Accounting must not discard provider work. */ }
	};
	let settled = false;
	note("pending");
	return (status: TerminalStatus, usage?: unknown) => {
		if (settled) return;
		settled = true;
		note(status, usage);
	};
}

/** Capture the original owner before work can outlive a curator or turn. */
export function bindWebUsage(pi: Pick<ExtensionAPI, "appendEntry" | "bindAuxiliaryUsage">, ctx: Pick<ExtensionContext, "sessionManager">, owner: string): WebUsageSink | undefined {
	if (pi.bindAuxiliaryUsage) {
		try {
			const append = pi.bindAuxiliaryUsage();
			return receipt => { append({ ...receipt, owner }); };
		} catch { return undefined; }
	}
	const manager = ctx.sessionManager;
	const session = manager?.getSessionId?.();
	if (!session) return undefined;
	return receipt => {
		if (ctx.sessionManager === manager && manager.getSessionId() === session) {
			pi.appendEntry("auxiliary-model-usage-v1", { ...receipt, owner });
		}
	};
}
