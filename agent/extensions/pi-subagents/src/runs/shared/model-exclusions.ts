import * as fs from "node:fs";
import * as path from "node:path";
import { splitKnownThinkingSuffix } from "../../shared/model-info.ts";
import { TEMP_ROOT_DIR } from "../../shared/types.ts";
import { isLocalModelResolutionFailure } from "./local-model-failure.ts";

export const EXCLUSIONS_PATH_ENV = "PI_MODEL_EXCLUSIONS_PATH";

type ModelExclusionTarget = { modelId: string; provider?: string } | { provider: string; modelId?: never };

export type ModelExclusion = ModelExclusionTarget & {
	reason?: string;
	recordedAt: number;
	expiresAt: number;
};

type RecordModelFailureOptions = ModelExclusionTarget & {
	reason?: string;
	ttlMs?: number;
};

let exclusions: ModelExclusion[] = [];
let loaded = false;
let loadedPath = "";
let loadedStamp = "";
let lastReadWarning = "";
/** Default duration for a new model exclusion when no per-record TTL is supplied. */
export const DEFAULT_MODEL_EXCLUSION_TTL_MS = 24 * 60 * 60_000;
/** Keeps a new expiry safely below JavaScript's maximum Date timestamp. */
export const MAX_MODEL_EXCLUSION_TTL_MS = 8_000_000_000_000_000;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;
let defaultTTLMs = DEFAULT_MODEL_EXCLUSION_TTL_MS;
let loadedTTLCeilingMs: number | undefined;
const lockWait = new Int32Array(new SharedArrayBuffer(4));
let persistSeq = 0;

/**
 * Override the default TTL applied to newly recorded model exclusions.
 *
 * @param ms Duration in milliseconds. Must be finite and positive.
 * @returns Nothing.
 */
// TEST:test/unit/model-exclusions.test.ts[model exclusions — TTL expiry]
export function setDefaultTTL(ms: number, options?: { shortenExisting?: boolean }): void {
	if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_MODEL_EXCLUSION_TTL_MS) {
		throw new Error(`Default model exclusion TTL must be a finite positive number no greater than ${MAX_MODEL_EXCLUSION_TTL_MS}.`);
	}
	defaultTTLMs = ms;
	loadedTTLCeilingMs = options?.shortenExisting ? ms : undefined;
	if (loaded && loadedTTLCeilingMs !== undefined) flushPersist();
}

/**
 * Resolve the persistence path. Honors PI_MODEL_EXCLUSIONS_PATH; defaults to
 * <TEMP_ROOT_DIR>/model-exclusions.json. Resolved lazily so tests can point the
 * store at an isolated location after module load.
 */
export function getExclusionsFilePath(): string {
	const envPath = process.env[EXCLUSIONS_PATH_ENV];
	if (typeof envPath === "string" && envPath.trim()) return envPath.trim();
	return path.join(TEMP_ROOT_DIR, "model-exclusions.json");
}

/** Reconcile the latest durable store, never a stale process-local snapshot. */
export function flushPersist(): void {
	mutateExclusions(items => items);
}

function fileStamp(file: string): string {
	try { const stat = fs.statSync(file); return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
}

function validTarget(entry: { modelId?: unknown; provider?: unknown }): boolean {
	const valid = (value: unknown, limit: number) => typeof value === "string" && value.length > 0 && value.length <= limit && value.trim() === value && !/[\x00-\x1f\x7f-\x9f]/.test(value);
	if (entry.modelId !== undefined && !valid(entry.modelId, 512)) return false;
	if (entry.provider !== undefined && !valid(entry.provider, 128)) return false;
	return entry.modelId !== undefined || entry.provider !== undefined;
}

function readExclusions(file: string): { exists: boolean; entries: ModelExclusion[] } {
	let raw: string;
	try { raw = fs.readFileSync(file, "utf-8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, entries: [] }; throw error; }
	const data = JSON.parse(raw);
	if (data?.version !== 1 || !Array.isArray(data.exclusions)) throw new Error("Unsupported or malformed model exclusion store.");
	for (const entry of data.exclusions) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid model exclusion entry.");
		if (!validTarget(entry)) throw new Error("Invalid model exclusion target.");
		if (entry.reason !== undefined && typeof entry.reason !== "string") throw new Error("Invalid model exclusion reason.");
		for (const field of ["recordedAt", "expiresAt"] as const) {
			const value = entry[field];
			if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_DATE_TIMESTAMP_MS) throw new Error("Invalid model exclusion timestamp.");
		}
	}
	return { exists: true, entries: data.exclusions };
}

function normalizeExclusions(items: ModelExclusion[]): ModelExclusion[] {
	const now = Date.now();
	const current = items.filter(entry => entry.expiresAt > now && !isLocalModelResolutionFailure(entry.reason)).map(entry => ({ ...entry }));
	if (loadedTTLCeilingMs !== undefined) shortenExclusionsToTTL(current, loadedTTLCeilingMs, now);
	return deduplicate(current);
}

/** Short synchronous read-modify-write. Contention times out without deleting
 * another writer's lock. A crashed lock requires explicit repair: age/PID
 * checks cannot atomically distinguish it from a replacement live lock. */
function acquireLock(file: string): () => void {
	const directory = `${file}.lock`, deadline = Date.now() + 2000;
	for (;;) {
		try {
			fs.mkdirSync(directory, { mode: 0o700 });
			const owned = fs.statSync(directory);
			return () => {
				try {
					const current = fs.statSync(directory);
					if (current.dev === owned.dev && current.ino === owned.ino) fs.rmSync(directory, { recursive: true, force: true });
				} catch {}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() >= deadline) throw new Error("Model exclusion store lock timeout.");
			Atomics.wait(lockWait, 0, 0, 10);
		}
	}
}

function invalidateCache(file: string): void {
	if (loadedPath !== file) { exclusions = []; loadedPath = file; loadedStamp = ""; }
	loaded = false;
}

function mutateExclusions(change: (items: ModelExclusion[]) => ModelExclusion[]): boolean {
	const file = getExclusionsFilePath();
	let release: (() => void) | undefined, tmpPath: string | undefined;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		release = acquireLock(file);
		const disk = readExclusions(file);
		const next = normalizeExclusions(change(normalizeExclusions(disk.entries)));
		if (!disk.exists || JSON.stringify(next) !== JSON.stringify(disk.entries)) {
			tmpPath = `${file}.${process.pid}.${persistSeq++}.tmp`;
			fs.writeFileSync(tmpPath, JSON.stringify({ version: 1, exclusions: next }, null, 2), { mode: 0o600 });
			fs.renameSync(tmpPath, file); tmpPath = undefined;
		}
		exclusions = next; loaded = true; loadedPath = file; loadedStamp = fileStamp(file);
		return true;
	} catch (error) {
		// Never overwrite a malformed/locked store with an empty cached snapshot.
		invalidateCache(file);
		console.error(error instanceof Error && error.message === "Model exclusion store lock timeout."
			? "[model-exclusions] Store is locked; writes skipped and existing state retained. An abandoned lock requires explicit repair."
			: "[model-exclusions] Could not update the model exclusion store; existing state was retained.");
		return false;
	} finally {
		if (tmpPath) try { fs.unlinkSync(tmpPath); } catch {}
		release?.();
	}
}

function ensureLoaded(): void {
	const file = getExclusionsFilePath();
	let stamp = "unreadable";
	try {
		stamp = fileStamp(file);
		if (loaded && loadedPath === file && loadedStamp === stamp) return;
		const disk = readExclusions(file);
		const current = normalizeExclusions(disk.entries);
		exclusions = current; loaded = true; loadedPath = file; loadedStamp = stamp;
		lastReadWarning = "";
		// Exact historical CLI failures are not evidence against a provider.
		// Re-read under the writer lock before persisting their removal.
		if (disk.exists && JSON.stringify(current) !== JSON.stringify(disk.entries) && !mutateExclusions(items => items)) {
			// A read may identify obsolete local failures while a writer owns the
			// file. Cache this stamp so ordinary lookups do not retry a locked
			// reconciliation on every render. Any changed durable file is re-read.
			exclusions = current; loaded = true; loadedPath = file; loadedStamp = stamp;
		}
	} catch {
		invalidateCache(file);
		const warning = JSON.stringify([file, stamp]);
		if (lastReadWarning !== warning) console.error("[model-exclusions] Could not read the model exclusion store; existing file and last valid same-path state were retained.");
		lastReadWarning = warning;
	}
}

function dedupKey(entry: ModelExclusion): string {
	return JSON.stringify([entry.provider ?? "", entry.modelId ?? ""]);
}

function deduplicate(items: ModelExclusion[]): ModelExclusion[] {
	const map = new Map<string, ModelExclusion>();
	for (const entry of items) {
		const key = dedupKey(entry);
		const existing = map.get(key);
		if (!existing || entry.recordedAt > existing.recordedAt) {
			map.set(key, entry);
		}
	}
	return Array.from(map.values());
}

/**
 * Record a model failure as a temporary exclusion. While the exclusion is
 * active, {@link isExcluded} returns true for the model (or for every model of
 * the provider when modelId is omitted), and {@link filterFallbackCandidates}
 * removes matching candidates from fallback lists.
 */
export function recordModelFailure(options: RecordModelFailureOptions): void {
	if (!validTarget(options)) throw new Error("Model exclusion target must name a non-empty model or provider.");
	if (options.ttlMs !== undefined && (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0 || options.ttlMs > MAX_MODEL_EXCLUSION_TTL_MS)) {
		throw new Error(`Model exclusion TTL must be a finite positive number no greater than ${MAX_MODEL_EXCLUSION_TTL_MS}.`);
	}
	if (isLocalModelResolutionFailure(options.reason)) return;
	const ttl = options.ttlMs ?? defaultTTLMs;
	const now = Date.now();
	const target: ModelExclusionTarget = options.modelId !== undefined
		? { modelId: options.modelId, ...(options.provider ? { provider: options.provider } : {}) }
		: { provider: options.provider };
	const exclusion: ModelExclusion = { ...target, reason: options.reason ?? "runtime-failure", recordedAt: now, expiresAt: now + ttl };
	mutateExclusions(items => deduplicate([exclusion, ...items]).sort((a, b) => b.recordedAt - a.recordedAt).slice(0, 200));
}

/**
 * Drop expired exclusions from the latest durable state.
 */
export function clearExpiredExclusions(): void {
	flushPersist();
}

/**
 * Remove every exclusion (e.g. after the operator fixes credentials).
 */
export function clearExclusions(): void {
	mutateExclusions(() => []);
}

/**
 * Whether an exclusion entry matches a candidate.
 *
 * Semantics:
 * - Entry with modelId: model-specific exclusion. Matches only that modelId;
 *   when both the entry and the candidate carry a provider, the providers must
 *   also agree so `openai/gpt-4` does not exclude `github-copilot/gpt-4`.
 * - Entry without modelId: provider-wide exclusion (e.g. quota or auth failure).
 *   Matches every model of that provider.
 */
function entryMatches(entry: ModelExclusion, candidateModelId: string, candidateProvider: string | undefined, now: number): boolean {
	if (entry.expiresAt <= now) return false;
	if (entry.modelId) {
		if (entry.modelId !== candidateModelId) return false;
		return !entry.provider || !candidateProvider || entry.provider === candidateProvider;
	}
	return Boolean(entry.provider) && entry.provider === candidateProvider;
}

/**
 * Whether a model (or its provider) is currently excluded.
 */
export function isExcluded(modelId: string, provider: string): boolean {
	ensureLoaded();
	return exclusions.some((entry) => entryMatches(entry, modelId, provider, Date.now()));
}

/**
 * Return the active exclusion matching a full model id, if any.
 *
 * The caller uses this for hard-fail diagnostics; fallback filtering should
 * continue to use {@link filterFallbackCandidates}.
 */
export function findModelExclusion(fullId: string, now = Date.now()): Readonly<ModelExclusion> | undefined {
	return createModelExclusionLookup(now)(fullId);
}

/** One fresh durable snapshot for a synchronous routing decision. */
export function createModelExclusionLookup(now = Date.now()): (fullId: string) => Readonly<ModelExclusion> | undefined {
	ensureLoaded();
	const snapshot = exclusions;
	return (fullId) => {
		const { provider, modelId } = parseModelKey(fullId);
		return snapshot.find((entry) => entryMatches(entry, modelId, provider, now));
	};
}

/**
 * Number of live (non-expired) exclusions.
 */
export function getExcludedCount(): number {
	ensureLoaded();
	return exclusions.filter(entry => entry.expiresAt > Date.now()).length;
}

/**
 * Split a candidate fullId into its provider + modelId components.
 *
 * A fullId may carry a thinking suffix (`provider/model:thinking`) which is
 * stripped before parsing, and the modelId itself may contain slashes
 * (e.g. `openrouter/google/gemini-flash`). The first `/`-segment is the
 * provider; everything after is the modelId. This MUST stay in lock-step with
 * the matching inside {@link isExcluded} so that a failure recorded via
 * {@link recordModelFailure} is later recognised by the candidate filter.
 */
export function parseModelKey(fullId: string): { provider?: string; modelId: string } {
	const base = splitKnownThinkingSuffix(fullId).baseModel;
	if (!base.includes("/")) return { modelId: base };
	const slash = base.indexOf("/");
	return { provider: base.slice(0, slash), modelId: base.slice(slash + 1) };
}

/**
 * Filter a list of candidate fullIds, removing excluded models/providers and
 * duplicates while preserving order.
 */
export function filterFallbackCandidates(candidates: string[], opts?: {
	now?: number;
	onExcluded?: (candidate: string, exclusion: Readonly<ModelExclusion>) => void;
}): string[] {
	ensureLoaded();
	const timestamp = opts?.now ?? Date.now();
	const seen = new Set<string>();
	const filtered: string[] = [];
	for (const raw of candidates) {
		if (!raw || seen.has(raw)) continue;
		const { provider: candidateProvider, modelId: candidateModelId } = parseModelKey(raw);
		const exclusion = exclusions.find((entry) => entryMatches(entry, candidateModelId, candidateProvider, timestamp));
		if (exclusion) {
			opts?.onExcluded?.(raw, exclusion);
			continue;
		}
		seen.add(raw);
		filtered.push(raw);
	}
	return filtered;
}

/**
 * Reload exclusions from disk (for tests and config hot-reload).
 * Discards the read cache; all mutations already persist under the writer lock.
 */
export function reloadFromDisk(): void {
	loaded = false;
	ensureLoaded();
}

function prune(items: ModelExclusion[], now: number): void {
	let write = 0;
	for (let i = 0; i < items.length; i++) {
		const entry = items[i]!;
		if (entry.expiresAt > now) {
			items[write++] = entry;
		}
	}
	items.length = write;
}

function shortenExclusionsToTTL(items: ModelExclusion[], ttlMs: number, now: number): boolean {
	let changed = false;
	for (const entry of items) {
		const configuredExpiry = entry.recordedAt + ttlMs;
		if (entry.expiresAt > configuredExpiry) {
			entry.expiresAt = configuredExpiry;
			changed = true;
		}
	}
	const previousLength = items.length;
	prune(items, now);
	return changed || items.length !== previousLength;
}
