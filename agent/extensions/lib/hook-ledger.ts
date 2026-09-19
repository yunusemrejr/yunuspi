/**
 * Hook invocation ledger — expected vs actual execution accounting.
 *
 * The core runner creates ONE context object per dispatch and passes it to
 * every handler of that dispatch (see `emitContext` / `emit*` in
 * pi/dist/core/extensions/runner.js). That context identity is the only
 * stable per-dispatch handle available to an extension, so it is the basis
 * for event ids here:
 *
 *   - tool_call / tool_result carry `toolCallId` → use it verbatim (stable
 *     across processes, which is what makes 2x/3x replay detectable).
 *   - everything else gets `#<process-seq>` from a WeakMap keyed on the
 *     dispatch context. Reload-safe: the registry lives on globalThis under
 *     a Symbol, so loader and bundle copies agree and a /reload does not
 *     rename in-flight events.
 *
 * The ledger itself is pure: no pi imports, no I/O, no timers. It records
 * per (extension, event, eventId) multiplicity so that duplicate dispatch,
 * missing paired execution, reload duplication and first-prefix-mutator
 * ordering are answerable with bounded memory.
 *
 * Records arrive from the metrics wrapper (scripts/compatibility/legacy-transforms/hook-metrics-wrapper.js)
 * through extensions/lib/session-telemetry.ts. Nothing here is model-visible.
 */

/** Reload-safe registry shared by the metrics wrapper and extension guards. */
const DISPATCH_REGISTRY = Symbol.for("yunus-pi.dispatch.v1");

export type DispatchCursor = {
	id: number;
	n: number;
};

export type DispatchRegistry = {
	seq: number;
	cursors: WeakMap<object, DispatchCursor>;
};

function dispatchRegistry(): DispatchRegistry {
	const g = globalThis as Record<symbol, unknown>;
	let registry = g[DISPATCH_REGISTRY] as DispatchRegistry | undefined;
	if (!registry || typeof registry !== "object") {
		registry = { seq: 0, cursors: new WeakMap() };
		g[DISPATCH_REGISTRY] = registry;
	}
	return registry;
}

/**
 * Identity of the current dispatch as observed by one handler invocation.
 * `seq` is the 1-based handler order within the dispatch, which is what makes
 * "which hook changed the prefix first" answerable without wall-clock ties.
 */
export function dispatchIdentity(
	event: unknown,
	ctx: unknown,
): { eventId: string; seq: number } {
	const registry = dispatchRegistry();
	const key =
		ctx !== null && typeof ctx === "object"
			? (ctx as object)
			: event !== null && typeof event === "object"
				? (event as object)
				: registry; // never reached for real dispatches; keeps the map total
	let cursor = registry.cursors.get(key);
	if (!cursor) {
		cursor = { id: ++registry.seq, n: 0 };
		registry.cursors.set(key, cursor);
	}
	const seq = ++cursor.n;
	const toolCallId = (event as { toolCallId?: unknown } | null)?.toolCallId;
	const eventId =
		typeof toolCallId === "string" && toolCallId
			? toolCallId
			: `#${cursor.id}`;
	return { eventId, seq };
}

export type HookRecord = {
	owner: string;
	hook: string;
	eventId: string;
	seq?: number;
	/** Handler returned a value: mutation or decision, not proof of usefulness. */
	changed?: boolean;
	/** tool_call handler returned {block:true}; the pair never executed. */
	blocked?: boolean;
	error?: boolean;
	addedChars?: number;
	removedChars?: number;
};

export type DispatchRow = {
	owner: string;
	seq: number;
	changed: boolean;
	blocked: boolean;
	error: boolean;
	added: number;
	removed: number;
};

export type LedgerSnapshot = {
	records: number;
	dispatches: number;
	expectedPairs: number;
	/** Histogram of (owner,hook,eventId) execution counts, bucketed. */
	multiplicity: { once: number; twice: number; thrice: number };
	/** Same (owner,hook,eventId) executed more than once. */
	duplicated: Array<{
		owner: string;
		hook: string;
		eventId: string;
		count: number;
	}>;
	/** Owner handled tool_call for an id but not the paired tool_result. */
	missingResults: Array<{ toolCallId: string; owners: string[] }>;
	/** Owner executed 2x+ across many distinct dispatches → reload/stale listener suspect. */
	suspectedStale: Array<{
		owner: string;
		hook: string;
		events: number;
		maxCount: number;
	}>;
	/** Who changed each dispatch first, aggregated per (hook, owner). */
	firstMutators: Array<{ hook: string; owner: string; dispatches: number }>;
};

export type HookLedger = {
	record(record: HookRecord): void;
	snapshot(): LedgerSnapshot;
	reset(): void;
};

const KEY_SEP = "\u0000";

/**
 * Bounded accounting of hook invocations. Memory is capped by
 * `maxDispatches` dispatch entries and `maxRows` rows per dispatch; old
 * entries are evicted FIFO, so a long session degrades to a recent window
 * rather than unbounded growth.
 */
export function createHookLedger(
	limits: { maxDispatches?: number; maxRows?: number } = {},
): HookLedger {
	const maxDispatches = limits.maxDispatches ?? 1024;
	const maxRows = limits.maxRows ?? 40;

	const dispatches = new Map<
		string,
		{ hook: string; eventId: string; rows: DispatchRow[]; firstMutator?: string }
	>();
	const counts = new Map<string, number>();
	const toolCallOwners = new Map<string, Set<string>>();
	const toolCallBlocked = new Map<string, Set<string>>();
	const toolResultOwners = new Map<string, Set<string>>();
	let records = 0;

	const dispatchKey = (hook: string, eventId: string) =>
		`${hook}${KEY_SEP}${eventId}`;

	const evict = () => {
		while (dispatches.size > maxDispatches) {
			const oldest = dispatches.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			dispatches.delete(oldest);
		}
	};

	const record = (record: HookRecord): void => {
		if (!record || typeof record.owner !== "string" || typeof record.hook !== "string")
			return;
		const eventId = typeof record.eventId === "string" && record.eventId
			? record.eventId
			: "(none)";
		records++;
		const dKey = dispatchKey(record.hook, eventId);
		let entry = dispatches.get(dKey);
		if (!entry) {
			entry = { hook: record.hook, eventId, rows: [] };
			dispatches.set(dKey, entry);
			evict();
		}
		if (entry.rows.length >= maxRows) entry.rows.shift();
		entry.rows.push({
			owner: record.owner,
			seq: Number.isSafeInteger(record.seq) ? (record.seq as number) : 0,
			changed: record.changed === true,
			blocked: record.blocked === true,
			error: record.error === true,
			added: Number.isFinite(record.addedChars) ? Math.max(0, record.addedChars as number) : 0,
			removed: Number.isFinite(record.removedChars)
				? Math.max(0, record.removedChars as number)
				: 0,
		});
		if (
			!entry.firstMutator &&
			(record.changed === true ||
				(Number.isFinite(record.addedChars) && (record.addedChars as number) > 0) ||
				(Number.isFinite(record.removedChars) && (record.removedChars as number) > 0))
		)
			entry.firstMutator = record.owner;

		const cKey = `${record.owner}${KEY_SEP}${record.hook}${KEY_SEP}${eventId}`;
		counts.set(cKey, (counts.get(cKey) ?? 0) + 1);

		if (record.hook === "tool_call" && eventId !== "(none)") {
			const owners = toolCallOwners.get(eventId) ?? new Set<string>();
			owners.add(record.owner);
			toolCallOwners.set(eventId, owners);
			if (record.blocked === true) {
				const blocked = toolCallBlocked.get(eventId) ?? new Set<string>();
				blocked.add(record.owner);
				toolCallBlocked.set(eventId, blocked);
			}
		}
		if (record.hook === "tool_result" && eventId !== "(none)") {
			const owners = toolResultOwners.get(eventId) ?? new Set<string>();
			owners.add(record.owner);
			toolResultOwners.set(eventId, owners);
		}
	};

	const snapshot = (): LedgerSnapshot => {
		let once = 0;
		let twice = 0;
		let thrice = 0;
		const duplicated: LedgerSnapshot["duplicated"] = [];
		const perOwnerHook = new Map<
			string,
			{ events: number; maxCount: number }
		>();
		for (const [key, count] of counts) {
			if (count <= 1) {
				once++;
				continue;
			}
			if (count === 2) twice++;
			else thrice++;
			const [owner, hook, eventId] = key.split(KEY_SEP);
			if (duplicated.length < 20)
				duplicated.push({ owner, hook, eventId, count });
			const ohKey = `${owner}${KEY_SEP}${hook}`;
			const agg = perOwnerHook.get(ohKey) ?? { events: 0, maxCount: 0 };
			agg.events++;
			agg.maxCount = Math.max(agg.maxCount, count);
			perOwnerHook.set(ohKey, agg);
		}
		duplicated.sort((a, b) => b.count - a.count);

		const missingResults: LedgerSnapshot["missingResults"] = [];
		for (const [toolCallId, expected] of toolCallOwners) {
			const actual = toolResultOwners.get(toolCallId);
			if (!actual) continue; // call still running or blocked before execution
			const blocked = toolCallBlocked.get(toolCallId) ?? new Set<string>();
			const missing = [...expected].filter(
				(owner) => !actual.has(owner) && !blocked.has(owner),
			);
			if (missing.length && missingResults.length < 20)
				missingResults.push({ toolCallId, owners: missing });
		}

		const suspectedStale: LedgerSnapshot["suspectedStale"] = [];
		for (const [ohKey, agg] of perOwnerHook) {
			if (agg.events < 3) continue;
			const [owner, hook] = ohKey.split(KEY_SEP);
			suspectedStale.push({ owner, hook, events: agg.events, maxCount: agg.maxCount });
		}
		suspectedStale.sort((a, b) => b.events - a.events || b.maxCount - a.maxCount);

		const firstMutators = new Map<string, number>();
		for (const entry of dispatches.values()) {
			if (!entry.firstMutator) continue;
			const key = `${entry.hook}${KEY_SEP}${entry.firstMutator}`;
			firstMutators.set(key, (firstMutators.get(key) ?? 0) + 1);
		}

		return {
			records,
			dispatches: dispatches.size,
			expectedPairs: toolCallOwners.size,
			multiplicity: { once, twice, thrice },
			duplicated,
			missingResults,
			suspectedStale: suspectedStale.slice(0, 10),
			firstMutators: [...firstMutators]
				.map(([key, n]) => {
					const [hook, owner] = key.split(KEY_SEP);
					return { hook, owner, dispatches: n };
				})
				.sort((a, b) => b.dispatches - a.dispatches),
		};
	};

	return {
		record,
		snapshot,
		reset() {
			dispatches.clear();
			counts.clear();
			toolCallOwners.clear();
			toolCallBlocked.clear();
			toolResultOwners.clear();
			records = 0;
		},
	};
}

/**
 * Execute-once guard for (extension, event, eventId). Extensions wrap a
 * handler when a duplicate dispatch has been demonstrated; the wrapper seen
 * by the metrics sink still observes every invocation, so suppressing here
 * cannot hide evidence from the ledger.
 *
 * The guard is process-wide and reload-safe (globalThis Symbol) so a reload
 * cannot forget what already ran for an in-flight event.
 */
const ONCE_GUARD = Symbol.for("yunus-pi.hook-once.v1");

export type OnceRegistry = {
	seen: Map<string, number>;
	cap: number;
};

function onceRegistry(cap = 4096): OnceRegistry {
	const g = globalThis as Record<symbol, unknown>;
	let registry = g[ONCE_GUARD] as OnceRegistry | undefined;
	if (!registry || typeof registry !== "object") {
		registry = { seen: new Map(), cap };
		g[ONCE_GUARD] = registry;
	}
	return registry;
}

export function shouldRunOnce(
	owner: string,
	hook: string,
	eventId: string,
): boolean {
	const registry = onceRegistry();
	const key = `${owner}${KEY_SEP}${hook}${KEY_SEP}${eventId}`;
	if (registry.seen.has(key)) return false;
	registry.seen.set(key, 0);
	while (registry.seen.size > registry.cap) {
		const oldest = registry.seen.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		registry.seen.delete(oldest);
	}
	return true;
}

/** Wrap a handler so it executes at most once per (owner, hook, eventId). */
export function oncePerEvent<H extends (...args: any[]) => any>(
	owner: string,
	hook: string,
	handler: H,
): (...args: Parameters<H>) => ReturnType<H> | undefined {
	return function (this: unknown, ...args: Parameters<H>): ReturnType<H> | undefined {
		const [event, ctx] = args as [unknown, unknown];
		const { eventId } = dispatchIdentity(event, ctx);
		if (!shouldRunOnce(owner, hook, eventId)) return undefined;
		return handler.apply(this, args);
	};
}

export function resetHookLedger(deps: {
	ledger?: HookLedger;
	clearOnce?: boolean;
} = {}): void {
	deps.ledger?.reset();
	if (deps.clearOnce) {
		const g = globalThis as Record<symbol, unknown>;
		delete g[ONCE_GUARD];
	}
}