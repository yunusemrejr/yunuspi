const WAIT_BUFFER = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(4) : undefined;
const WAIT_VIEW = WAIT_BUFFER ? new Int32Array(WAIT_BUFFER) : undefined;
const RETRYABLE_FILE_SYSTEM_ERROR_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const STORAGE_CAPACITY_ERROR_CODES = new Set(["EDQUOT", "EMFILE", "ENFILE", "ENOSPC"]);

export const FS_RETRY_MAX_TOTAL_MS_ENV = "PI_SUBAGENT_FS_RETRY_MAX_TOTAL_MS";

const BASE_FILE_SYSTEM_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 500, 1000, 2000, 4000] as const;

/**
 * Clamp the retry ladder to a total sleep budget, preserving its length.
 *
 * The parent event loop gets at most 100 ms of blocking waits. Isolated child
 * processes retain the full ladder for durable completion writes. Keep every
 * attempt: lock callers also use the array length as their attempt budget.
 * Explicit budgets override either default.
 */
export function resolveFileSystemRetryDelays(
	env: NodeJS.ProcessEnv = process.env,
	base: readonly number[] = BASE_FILE_SYSTEM_RETRY_DELAYS_MS,
): readonly number[] {
	const raw = env[FS_RETRY_MAX_TOTAL_MS_ENV];
	const hasBudget = raw !== undefined && raw.trim() !== "";
	if (!hasBudget && env.PI_SUBAGENT_CHILD === "1") return base;
	const budget = hasBudget ? Number(raw) : 100;
	if (!Number.isSafeInteger(budget) || budget < 0) {
		throw new Error(`${FS_RETRY_MAX_TOTAL_MS_ENV} must be a non-negative integer number of milliseconds.`);
	}
	let spent = 0;
	return base.map((delayMs) => {
		const allowed = Math.max(0, Math.min(delayMs, budget - spent));
		spent += allowed;
		return allowed;
	});
}

export const DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS = resolveFileSystemRetryDelays();

export type FileSystemRetryOptions = {
	retryDelaysMs?: readonly number[];
	wait?: (delayMs: number) => void;
};

export function waitForFileSystemRetry(delayMs: number): void {
	if (delayMs <= 0) return;
	if (WAIT_VIEW) {
		try {
			// Callers are synchronous status/result writers; Atomics.wait gives
			// Windows directory and rename locks time to clear without burning CPU.
			Atomics.wait(WAIT_VIEW, 0, 0, delayMs);
			return;
		} catch {
			// Fall through to the portable busy wait below.
		}
	}
	const end = Date.now() + delayMs;
	while (Date.now() < end) {
		// Portable fallback for runtimes where Atomics.wait is unavailable.
	}
}

export function isRetryableFileSystemError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && RETRYABLE_FILE_SYSTEM_ERROR_CODES.has(code);
}

export function isStorageCapacityError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && STORAGE_CAPACITY_ERROR_CODES.has(code);
}

export function runFileSystemOperationWithRetry<T>(operation: () => T, options: FileSystemRetryOptions = {}): T {
	const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS;
	const wait = options.wait ?? waitForFileSystemRetry;
	for (let attempt = 0; ; attempt++) {
		try {
			return operation();
		} catch (error) {
			const delayMs = retryDelaysMs[attempt];
			if (delayMs === undefined || !isRetryableFileSystemError(error)) throw error;
			wait(delayMs);
		}
	}
}
