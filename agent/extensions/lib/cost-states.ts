/**
 * First-class cost states.
 *
 * Unknown cost is never rendered as $0. These states stay distinct everywhere:
 *   unknown            no cost evidence at all
 *   estimated          computed from priced usage, not provider-reported
 *   provider-reported  the provider stated this cost
 *   subscription       covered by subscription, not metered
 *   free-evidence      proven zero by free-route evidence
 *   pending            accounting incomplete (children still running)
 *   verified-zero      observed activity with a confirmed zero total
 *
 * `$0.000000` means verified zero — never missing evidence. Dependency-free.
 */

export type CostState =
	| "unknown"
	| "estimated"
	| "provider-reported"
	| "subscription"
	| "free-evidence"
	| "pending"
	| "verified-zero";

export interface CostStateInput {
	reported?: number;
	estimated?: number;
	unknown?: boolean;
	subscription?: boolean;
	seen?: boolean;
	estimatedUsage?: boolean;
	pending?: number;
	freeProven?: boolean;
}

const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Classify aggregated cost evidence into one first-class state. */
export function classifyCostState(input: CostStateInput): CostState {
	const reported = valid(input.reported) ? input.reported : 0;
	const estimated = valid(input.estimated) ? input.estimated : 0;
	const total = reported + estimated;
	if (input.subscription === true && input.seen !== true && total === 0) return "subscription";
	if (input.freeProven === true && total === 0) return "free-evidence";
	if (input.seen !== true) return "unknown";
	if ((input.pending ?? 0) > 0 || input.unknown === true) {
		// Partial evidence with outstanding accounting: pending dominates.
		if (total === 0) return "pending";
		return "pending";
	}
	if (total === 0) return "verified-zero";
	if (reported > 0 && estimated === 0 && input.estimatedUsage !== true) return "provider-reported";
	return "estimated";
}

/**
 * Format a cost total under its state. Unknown/pending never render as $0;
 * verified zero renders $0.000 with an explicit marker so it cannot be
 * confused with missing evidence.
 */
export function formatCost(total: number, state: CostState): string {
	const amount = !(typeof total === "number" && Number.isFinite(total) && total >= 0)
		? "?"
		: total > 0 && total < 0.000001 ? total.toExponential(3) : total > 0 && total < 1 ? total.toFixed(6) : total.toFixed(3);
	switch (state) {
		case "unknown": return "$?";
		case "pending": return total > 0 ? `$~${amount}+?` : "$+?";
		case "subscription": return total > 0 ? `$${amount} (sub)` : "sub";
		case "free-evidence": return "$0.000 (free)";
		case "verified-zero": return "$0.000 (verified)";
		case "provider-reported": return `$${amount}`;
		case "estimated": return `$~${amount}`;
	}
}

/** One-line ledger row: route, state, amount. Aggregate first, detail second. */
export function formatCostRow(route: string, total: number, state: CostState): string {
	return `${route}: ${formatCost(total, state)} [${state}]`;
}
