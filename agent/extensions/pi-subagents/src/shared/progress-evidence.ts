import { createHash } from "node:crypto";

/** Observable progress, not a correctness or runaway-loop verdict. */
export interface ChildProgressEvidence {
	turns: number;
	toolResults: number;
	toolErrors: number;
	successfulWriteCalls: number;
	writeTargets: number;
	/** Distinct target tracking hit its cap; writeTargets is then a lower bound. */
	writeTargetsTruncated?: boolean;
	lastWriteTurn?: number;
	lastResultAt?: number;
}

const MAX_WRITE_TARGETS = 4096;

/** Public projections retain validated numeric evidence only, never arbitrary fields. */
export function parseProgressEvidence(value: unknown): ChildProgressEvidence | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	const output: Record<string, number | boolean> = {};
	for (const field of ['turns', 'toolResults', 'toolErrors', 'successfulWriteCalls', 'writeTargets', 'lastWriteTurn', 'lastResultAt']) {
		const count = input[field];
		if (count === undefined && (field === 'lastWriteTurn' || field === 'lastResultAt')) continue;
		if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return undefined;
		output[field] = count;
	}
	if (input.writeTargetsTruncated === true) output.writeTargetsTruncated = true;
	return output as unknown as ChildProgressEvidence;
}

export function createProgressEvidence() {
	const pending = new Map<string, { name: string; path?: string }>();
	const settled = new Set<string>();
	const paths = new Set<string>();
	const summary: ChildProgressEvidence = { turns: 0, toolResults: 0, toolErrors: 0, successfulWriteCalls: 0, writeTargets: 0 };
	return { pending, settled, paths, summary };
}

export function observeProgressEvidence(state: ReturnType<typeof createProgressEvidence>, event: any, now = Date.now()): ChildProgressEvidence {
	if (event.type === 'message_end' && event.message?.role === 'assistant') state.summary.turns++;
	const id = event.toolCallId ?? event.message?.toolCallId;
	if (typeof id === 'string' && event.type === 'tool_execution_start' && !state.settled.has(id)) {
		const name = event.toolName;
		const target = event.args?.path ?? event.args?.file_path;
		if (typeof name === 'string') state.pending.set(id, { name, ...(typeof target === 'string' && target ? { path: createHash('sha256').update(target).digest('hex') } : {}) });
	}
	if (typeof id === 'string' && ['tool_execution_end', 'tool_result_end'].includes(event.type) && !state.settled.has(id)) {
		const call = state.pending.get(id);
		const result = event.type === 'tool_result_end' ? event.message : event.result;
		// Missing result evidence is not a successful call. A later authoritative
		// result may still arrive after a bare execution-end notification.
		if (call && result && typeof result === 'object') {
			state.pending.delete(id); state.settled.add(id);
			state.summary.toolResults++; state.summary.lastResultAt = now;
			if (event.isError === true || result.isError === true || result.error) state.summary.toolErrors++;
			else if (['write', 'edit'].includes(call.name)) {
				state.summary.successfulWriteCalls++; state.summary.lastWriteTurn = state.summary.turns;
				if (call.path && !state.paths.has(call.path)) {
					if (state.paths.size < MAX_WRITE_TARGETS) state.paths.add(call.path);
					else state.summary.writeTargetsTruncated = true;
				}
				state.summary.writeTargets = state.paths.size;
			}
		}
	}
	// Bound transient bookkeeping. IDs older than this window cannot collide
	// with ordinary live notifications; snapshots retain numeric facts only.
	if (state.settled.size > 4096) state.settled.delete(state.settled.values().next().value!);
	if (state.pending.size > 512) state.pending.delete(state.pending.keys().next().value!);
	return { ...state.summary };
}

export function formatWriteProgressEvidence(value: ChildProgressEvidence): string {
	const writes = value.lastWriteTurn === undefined ? 'none observed' : `${Math.max(0, value.turns - value.lastWriteTurn)} turns since successful write`;
	return `${value.successfulWriteCalls} successful write calls / ${value.writeTargetsTruncated ? 'at least ' : ''}${value.writeTargets} targets; ${writes}`;
}

export function formatProgressEvidence(value?: ChildProgressEvidence): string {
	if (!value) return 'progress evidence unavailable';
	const writes = value.lastWriteTurn === undefined ? 'no successful write calls observed' : `${Math.max(0, value.turns - value.lastWriteTurn)} turns since successful write`;
	return `${value.toolResults} tool results (${value.toolErrors} failed), ${value.successfulWriteCalls} successful write calls / ${value.writeTargetsTruncated ? 'at least ' : ''}${value.writeTargets} targets; ${writes}`;
}
