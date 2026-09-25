/**
 * Explicit model/provider preferences layered over the autonomous selector.
 *
 * This module owns ONLY the `~/.pi/settings/llm_preferences.json` document:
 * parsing, validation, alias resolution, role chains, thinking normalization
 * and provider-option translation. It never selects a model by itself and
 * never replaces the autonomous machinery.
 *
 * Resolution hierarchy (implemented by callers in model-fallback.ts,
 * assistance-plan.ts and autonomous-recovery.ts):
 *   1. applicable explicit preference in llm_preferences.json, in order;
 *   2. remaining configured preferences when one is unusable or fails;
 *   3. the existing autonomous selection when the file is missing, malformed,
 *      has no applicable preference, or every configured option fails.
 *
 * State vs policy: this file defines preferences and fallbacks. The running
 * main-session model is state owned by Pi persistence (last-model.ts); this
 * module must never silently become its source of truth. Main-session callers
 * consult the `main_session_fallback` chain only after the persisted
 * selection fails or is unavailable.
 *
 * Partial failure: one bad alias, unavailable provider, unsupported thinking
 * level or invalid model skips that entry only. Callers continue through the
 * chain and then fall back to autonomous selection.
 *
 * No harness imports (leaf module): registry/health/capability validation
 * lives with the existing owners in model-fallback.ts to avoid import cycles.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { THINKING_LEVELS, type ThinkingLevel } from "../../shared/model-info.ts";

export const LLM_PREFERENCES_ENV = "PI_LLM_PREFERENCES_FILE";
export const LLM_PREFERENCES_VERSION = 1;
export const SESSION_OBSERVER_ROLE = "session_observer";
export const SESSION_OBSERVER_DEFAULT = Object.freeze({ provider: "deepseek", model: "deepseek-flash", thinking: "high" });
export const WATCHMAKER_ROLE = "watchmaker";
export const WATCHMAKER_DEFAULT = Object.freeze({ provider: "deepseek", model: "deepseek-flash", thinking: "low" });

/** Per-request OpenRouter backend control. Vocabulary matches the existing
 * `/provider` pins (provider-cmd.ts) and the wire path
 * `compat.openRouterRouting`; see providerOptionsToRouting(). */
export interface LlmProviderOptions {
	routing?: string;
	order?: unknown;
	allow_fallbacks?: unknown;
	sort?: unknown;
	only?: unknown;
	ignore?: unknown;
}

export interface LlmModelEntry {
	provider?: string;
	model?: string;
	thinking?: string;
	provider_options?: LlmProviderOptions;
}

/** A model address plus request-scoped upstream routing. The route remains
 * the exact provider/model identifier accepted by the existing registry. */
export interface LlmPreferenceCandidate {
	route: string;
	providerRouting?: Record<string, unknown>;
}

export interface LlmPreferencesConfig {
	version: number;
	models: Record<string, LlmModelEntry>;
	preferences: Record<string, { models: Array<string | LlmModelEntry> }>;
	metadata?: Record<string, unknown>;
}

export interface LlmPreferencesLoad {
	ok: boolean;
	config?: LlmPreferencesConfig;
	reason?: string;
	path: string;
	missing?: boolean;
	warnings?: string[];
}

export type LlmPreferencesDocumentValidation =
	| { ok: true; config: LlmPreferencesConfig; warnings?: string[] }
	| { ok: false; reason: string; warnings?: string[] };

export interface LlmPreferencesDocumentRead {
	path: string;
	revision: string;
	exists: boolean;
	ok: boolean;
	document?: Record<string, unknown>;
	config?: LlmPreferencesConfig;
	reason?: string;
	warnings?: string[];
}

export interface LlmPreferencesDocumentSave {
	ok: boolean;
	conflict?: boolean;
	revision?: string;
	reason?: string;
	warnings?: string[];
}

export function llmPreferencesPath(): string {
	const override = process.env[LLM_PREFERENCES_ENV]?.trim();
	if (override) return override;
	return path.join(os.homedir(), ".pi", "settings", "llm_preferences.json");
}

let cache: LlmPreferencesLoad | undefined;
let cacheKey: string | undefined;
let cacheStamp: string | undefined;

function stampOf(filePath: string): string {
	try {
		const stat = fs.statSync(filePath);
		return `${filePath}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
	} catch {
		return `${filePath}:missing`;
	}
}

export function clearLlmPreferencesCache(): void {
	cache = undefined;
	cacheKey = undefined;
	cacheStamp = undefined;
}

/** Deployment opt-in for an absent observer role. Uses the same revision,
 * lock and verified-backup writer as /models; never replaces an existing role
 * (including an explicit empty list), aliases or unrelated user fields. */
export async function ensureSessionObserverPreference(filePath = llmPreferencesPath()): Promise<LlmPreferencesDocumentSave & { changed: boolean }> {
	const current = readLlmPreferencesDocument(filePath);
	if (current.exists && !current.ok) return { ok: false, changed: false, reason: current.reason };
	const document = structuredClone(current.document ?? { version: LLM_PREFERENCES_VERSION, models: {}, preferences: {} });
	const preferences = document.preferences as Record<string, unknown> | undefined;
	if (Object.keys(preferences ?? {}).some(role => normalizePreferenceRole(role) === SESSION_OBSERVER_ROLE))
		return { ok: true, changed: false, revision: current.revision };
	document.preferences = { ...(preferences ?? {}), [SESSION_OBSERVER_ROLE]: { models: [{ ...SESSION_OBSERVER_DEFAULT }] } };
	const saved = await saveLlmPreferencesDocument(filePath, current.revision, document);
	return { ...saved, changed: saved.ok };
}

/** Validate the public preference schema without normalizing the input object.
 * GUI callers retain the original JSON object and edit only the role list, so
 * unknown fields survive a round trip while routing still uses this parser. */
export function validateLlmPreferencesDocument(raw: unknown): LlmPreferencesDocumentValidation {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "preference file must be a JSON object" };
	const doc = raw as Record<string, unknown>;
	if (doc.version !== undefined && doc.version !== LLM_PREFERENCES_VERSION)
		return { ok: false, reason: `unsupported llm_preferences version ${JSON.stringify(doc.version)}; expected ${LLM_PREFERENCES_VERSION}` };
	const warnings: string[] = [];
	const models = parseRegistry(doc.models, warnings);
	if (!models) return { ok: false, reason: "preferences.models must be an object of alias to {provider, model, thinking?, provider_options?}" };
	const preferences = parsePreferences(doc.preferences, warnings);
	if (!preferences) return { ok: false, reason: "preferences.preferences must be an object of role to {models:[alias-or-entry]}" };
	const metadata = doc.metadata && typeof doc.metadata === "object" && !Array.isArray(doc.metadata)
		? (doc.metadata as Record<string, unknown>) : undefined;
	return {
		ok: true,
		config: { version: LLM_PREFERENCES_VERSION, models, preferences, ...(metadata ? { metadata } : {}) },
		...(warnings.length ? { warnings } : {}),
	};
}

/** Strict write-time validation for graphical edits. The runtime loader stays
 * permissive for manual compatibility; the editor must not persist entries
 * that the runtime will silently skip. Unrelated fields remain allowed. */
export function validateLlmPreferencesDocumentForWrite(raw: unknown): LlmPreferencesDocumentValidation {
	const runtime = validateLlmPreferencesDocument(raw);
	if (!runtime.ok) return runtime;
	const doc = raw as Record<string, unknown>;
	if (doc.metadata !== undefined && (!doc.metadata || typeof doc.metadata !== "object" || Array.isArray(doc.metadata)))
		return { ok: false, reason: "preferences.metadata must be an object when present" };
	const modelsRaw = doc.models === undefined ? {} : doc.models;
	if (!modelsRaw || typeof modelsRaw !== "object" || Array.isArray(modelsRaw)) return { ok: false, reason: "preferences.models must be an object" };
	const aliases = new Set(Object.keys(modelsRaw as Record<string, unknown>));
	for (const [alias, value] of Object.entries(modelsRaw as Record<string, unknown>)) {
		if (!ALIAS_RE.test(alias)) return { ok: false, reason: `Invalid model alias ${JSON.stringify(alias)}.` };
		const problem = strictModelEntryProblem(value);
		if (problem) return { ok: false, reason: `Invalid model alias ${JSON.stringify(alias)}: ${problem}` };
	}
	const preferencesRaw = doc.preferences === undefined ? {} : doc.preferences;
	if (!preferencesRaw || typeof preferencesRaw !== "object" || Array.isArray(preferencesRaw)) return { ok: false, reason: "preferences.preferences must be an object" };
	const canonicalRoles = new Map<string, string>();
	for (const [role, rawSpec] of Object.entries(preferencesRaw as Record<string, unknown>)) {
		const canonical = normalizePreferenceRole(role);
		if (!canonical) return { ok: false, reason: `Invalid preference role ${JSON.stringify(role)}.` };
		const earlier = canonicalRoles.get(canonical);
		if (earlier && earlier !== role) return { ok: false, reason: `Preference roles ${JSON.stringify(earlier)} and ${JSON.stringify(role)} normalize to the same role.` };
		canonicalRoles.set(canonical, role);
		const list = Array.isArray(rawSpec) ? rawSpec : rawSpec && typeof rawSpec === "object" && !Array.isArray(rawSpec)
			? (rawSpec as Record<string, unknown>).models : undefined;
		if (!Array.isArray(list) || list.length > 64) return { ok: false, reason: `Preference list for ${JSON.stringify(role)} must be an array of at most 64 routes.` };
		for (const item of list) {
			if (typeof item === "string") {
				const alias = item.trim();
				if (!ALIAS_RE.test(alias) || !aliases.has(alias)) return { ok: false, reason: `Preference ${JSON.stringify(role)} references unknown model alias ${JSON.stringify(item)}.` };
				continue;
			}
			const problem = strictModelEntryProblem(item);
			if (problem) return { ok: false, reason: `Invalid model entry in ${JSON.stringify(role)}: ${problem}` };
		}
	}
	return runtime;
}

function strictModelEntryProblem(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "entry must be an object";
	const entry = value as Record<string, unknown>;
	const model = cleanText(entry.model);
	if (!model || model !== entry.model) return "model must be a non-empty, trimmed string";
	if (entry.provider !== undefined && (!cleanText(entry.provider, 128) || cleanText(entry.provider, 128) !== entry.provider)) return "provider must be a non-empty, trimmed string";
	if (entry.thinking !== undefined) {
		if (typeof entry.thinking !== "string") return "thinking must be a string";
		const thinking = entry.thinking.trim().toLowerCase();
		if (!thinking || ![...THINKING_LEVELS, "none", "auto", "dynamic"].includes(thinking as typeof THINKING_LEVELS[number])) return "thinking must be auto, dynamic, none, or a supported level";
	}
	if (entry.provider_options !== undefined) {
		const options = entry.provider_options;
		if (!options || typeof options !== "object" || Array.isArray(options)) return "provider_options must be an object";
		const record = options as Record<string, unknown>;
		const routing = record.routing === undefined ? "auto" : record.routing;
		if (typeof routing !== "string" || !["auto", "pinned", "custom"].includes(routing.trim().toLowerCase())) return "provider_options.routing must be auto, pinned, or custom";
		if (typeof entry.provider === "string" && entry.provider.toLowerCase() !== "openrouter" && routing.trim().toLowerCase() !== "auto") return "provider_options routing is supported only for OpenRouter routes";
		const validateSlugs = (key: "order" | "only" | "ignore", required = false) => {
			const raw = record[key];
			if (raw === undefined) return required ? `${key} must contain at least one provider slug` : undefined;
			if (!Array.isArray(raw) || raw.length > 32 || raw.some(item => typeof item !== "string" || !item.trim() || item.length > 128 || /[\u0000-\u001f\u007f]/.test(item))) return `${key} must contain provider slugs`;
			if (required && raw.length === 0) return `${key} must contain at least one provider slug`;
		};
		const issue = validateSlugs("order", routing.trim().toLowerCase() === "pinned")
			?? validateSlugs("only") ?? validateSlugs("ignore");
		if (issue) return `provider_options.${issue}`;
		if (record.allow_fallbacks !== undefined && typeof record.allow_fallbacks !== "boolean") return "provider_options.allow_fallbacks must be boolean";
		if (record.sort !== undefined && (typeof record.sort !== "string" || !record.sort.trim() || record.sort.length > 32)) return "provider_options.sort must be a non-empty string of at most 32 characters";
	}
	return undefined;
}

function revisionOf(bytes: Buffer | undefined): string {
	return bytes ? createHash("sha256").update(bytes).digest("hex") : "missing";
}

function readRegularFile(filePath: string): Buffer | undefined {
	let fd: number | undefined;
	try {
		const stat = fs.lstatSync(filePath);
		if (!stat.isFile()) throw new Error("preference file must be a regular file; symbolic links are not accepted");
		if (stat.size > 256 * 1024) throw new Error("preference file exceeds 256 KiB");
		const noFollow = fs.constants.O_NOFOLLOW ?? 0;
		fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
		const opened = fs.fstatSync(fd);
		if (!opened.isFile() || opened.size > 256 * 1024) throw new Error("preference file changed while it was being read");
		return fs.readFileSync(fd);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
		throw error;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

/** Read exact JSON bytes plus a content revision for optimistic GUI saves. */
export function readLlmPreferencesDocument(filePath = llmPreferencesPath()): LlmPreferencesDocumentRead {
	let bytes: Buffer | undefined;
	try { bytes = readRegularFile(filePath); }
	catch (error) {
		return { path: filePath, revision: "unreadable", exists: true, ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
	if (!bytes) return { path: filePath, revision: "missing", exists: false, ok: true };
	const revision = revisionOf(bytes);
	let raw: unknown;
	try { raw = JSON.parse(bytes.toString("utf8")); }
	catch { return { path: filePath, revision, exists: true, ok: false, reason: "preference file is not valid JSON" }; }
	const checked = validateLlmPreferencesDocument(raw);
	if (!checked.ok) return { path: filePath, revision, exists: true, ok: false, reason: checked.reason, ...(checked.warnings ? { warnings: checked.warnings } : {}) };
	return {
		path: filePath,
		revision,
		exists: true,
		ok: true,
		document: raw as Record<string, unknown>,
		config: checked.config,
		...(checked.warnings ? { warnings: checked.warnings } : {}),
	};
}

function syncDirectory(dirPath: string): void {
	let fd: number | undefined;
	try { fd = fs.openSync(dirPath, fs.constants.O_RDONLY); fs.fsyncSync(fd); }
	finally { if (fd !== undefined) fs.closeSync(fd); }
}

function atomicWrite(filePath: string, bytes: Buffer, mode: number, validateJson = true): void {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const temp = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = fs.openSync(temp, "wx", mode);
		fs.writeFileSync(fd, bytes);
		fs.fsyncSync(fd);
		fs.closeSync(fd); fd = undefined;
		const staged = readRegularFile(temp);
		if (!staged || !staged.equals(bytes)) throw new Error("temporary preference write did not verify");
		if (validateJson) JSON.parse(staged.toString("utf8"));
		fs.renameSync(temp, filePath);
		syncDirectory(dir);
		const installed = readRegularFile(filePath);
		if (!installed || !installed.equals(bytes)) throw new Error("installed preference write did not verify");
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		fs.rmSync(temp, { force: true });
	}
}

async function acquirePreferenceWriterLock(filePath: string): Promise<(() => void) | undefined> {
	const lockPath = `${filePath}.lock`;
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const deadline = Date.now() + 1500;
	while (Date.now() < deadline) {
		let fd: number | undefined;
		let owned: { dev: number; ino: number } | undefined;
		try {
			fd = fs.openSync(lockPath, "wx", 0o600);
			const stat = fs.fstatSync(fd);
			owned = { dev: stat.dev, ino: stat.ino };
			fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, at: Date.now(), token: randomUUID() })}\n`);
			fs.fsyncSync(fd);
			fs.closeSync(fd); fd = undefined;
			return () => {
				try {
					const now = fs.lstatSync(lockPath);
					if (owned && now.dev === owned.dev && now.ino === owned.ino) fs.unlinkSync(lockPath);
				} catch { /* another process already removed the lock */ }
			};
		} catch (error) {
			if (fd !== undefined) fs.closeSync(fd);
			if (owned) {
				try {
					const now = fs.lstatSync(lockPath);
					if (now.dev === owned.dev && now.ino === owned.ino) fs.unlinkSync(lockPath);
				} catch { /* cleanup is best-effort */ }
			}
			if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
			try {
				const before = fs.lstatSync(lockPath);
				if (Date.now() - before.mtimeMs > 500) {
					let stale = false;
					try {
						const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown; at?: unknown };
						if (Number.isSafeInteger(lock.pid) && (lock.pid as number) > 0) {
							try { process.kill(lock.pid as number, 0); }
							catch (probe) { stale = (probe as NodeJS.ErrnoException)?.code === "ESRCH"; }
						} else stale = true;
					} catch { stale = true; }
					if (stale) {
						const after = fs.lstatSync(lockPath);
						if (after.dev === before.dev && after.ino === before.ino) fs.unlinkSync(lockPath);
					}
				}
			} catch { /* lock may have been released between inspection and cleanup */ }
			await new Promise(resolve => setTimeout(resolve, 25));
		}
	}
	return undefined;
}

/** A regular (non-symlink) file at the preference path. Used by the explicit
 * backup-restore recovery path before it replaces the current bytes. */
function isRegularPreferenceFile(filePath: string): boolean {
	try { return fs.lstatSync(filePath).isFile(); } catch { return false; }
}

function rollbackIfStillOwned(filePath: string, installedRevision: string, oldBytes?: Buffer): void {
	const current = readLlmPreferencesDocument(filePath);
	if (current.revision !== installedRevision) return;
	if (oldBytes) {
		if (readLlmPreferencesDocument(filePath).revision === installedRevision) atomicWrite(filePath, oldBytes, 0o600, false);
		return;
	}
	try {
		const before = fs.lstatSync(filePath);
		if (readLlmPreferencesDocument(filePath).revision !== installedRevision) return;
		const after = fs.lstatSync(filePath);
		if (before.dev === after.dev && before.ino === after.ino) {
			fs.unlinkSync(filePath);
			syncDirectory(path.dirname(filePath));
		}
	} catch { /* absent or concurrently changed */ }
}

/** Save only when the on-disk revision still matches the user's view. Writes
 * use a same-directory fsync/rename, and a verified previous-file backup. */
export async function saveLlmPreferencesDocument(
	filePath: string,
	expectedRevision: string,
	document: unknown,
	options: { restoreBackup?: boolean } = {},
): Promise<LlmPreferencesDocumentSave> {
	let release: (() => void) | undefined;
	try { release = await acquirePreferenceWriterLock(filePath); }
	catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
	if (!release) return { ok: false, reason: "Another model-routing editor is saving. Try again shortly." };
	try {
		const current = readLlmPreferencesDocument(filePath);
		if (current.revision !== expectedRevision) return { ok: false, conflict: true, revision: current.revision, reason: "The file changed on disk. Reload it before saving." };
		if (current.revision === "unreadable" && !options.restoreBackup) return { ok: false, revision: current.revision, reason: current.reason ?? "Preference file is not safely writable." };
		// Restoring the backup is the supported recovery for an unreadable path,
		// but a symbolic link or special file is never replaced.
		if (options.restoreBackup && current.exists && !isRegularPreferenceFile(filePath))
			return { ok: false, revision: current.revision, reason: "The configuration path is not a regular file and will not be replaced." };
		if (current.exists && !current.ok && !options.restoreBackup)
			return { ok: false, revision: current.revision, reason: "The current configuration is malformed. Restore the previous valid file before editing." };
		let nextDocument = document;
		if (options.restoreBackup) {
			const previous = readLlmPreferencesDocument(`${filePath}.bak`);
			if (!previous.ok || !previous.document) return { ok: false, revision: current.revision, reason: "No valid previous configuration is available." };
			nextDocument = previous.document;
		}
		const checked = validateLlmPreferencesDocumentForWrite(nextDocument);
		if (!checked.ok) return { ok: false, revision: current.revision, reason: checked.reason, ...(checked.warnings ? { warnings: checked.warnings } : {}) };
		let bytes: Buffer;
		try { bytes = Buffer.from(`${JSON.stringify(nextDocument, null, 2)}\n`, "utf8"); }
		catch { return { ok: false, revision: current.revision, reason: "Configuration could not be serialized." }; }
		if (bytes.byteLength > 256 * 1024) return { ok: false, revision: current.revision, reason: "Configuration exceeds 256 KiB." };
		const verified = validateLlmPreferencesDocumentForWrite(JSON.parse(bytes.toString("utf8")));
		if (!verified.ok) return { ok: false, revision: current.revision, reason: verified.reason };
		let oldBytes: Buffer | undefined;
		if (current.exists) { try { oldBytes = readRegularFile(filePath); } catch { oldBytes = undefined; } }
		// An explicit restore discards the current file by design: the revision
		// was verified above and an oversized/unreadable file has no bytes to
		// compare against. Every other save still requires an exact match.
		if (current.exists && !options.restoreBackup && (!oldBytes || revisionOf(oldBytes) !== expectedRevision)) return { ok: false, conflict: true, revision: readLlmPreferencesDocument(filePath).revision, reason: "The file changed while saving. Reload it before saving." };
		if (oldBytes && !options.restoreBackup) atomicWrite(`${filePath}.bak`, oldBytes, 0o600);
		// Recheck after backup creation and immediately before replacement.
		const beforeReplace = readLlmPreferencesDocument(filePath);
		if (beforeReplace.revision !== expectedRevision) return { ok: false, conflict: true, revision: beforeReplace.revision, reason: "The file changed while saving. Reload it before saving." };
		try { atomicWrite(filePath, bytes, 0o600); }
		catch (error) {
			const installedRevision = revisionOf(bytes);
			rollbackIfStillOwned(filePath, installedRevision, oldBytes);
			const afterFailure = readLlmPreferencesDocument(filePath);
			return afterFailure.revision !== installedRevision && afterFailure.revision !== expectedRevision
				? { ok: false, conflict: true, revision: afterFailure.revision, reason: "The save failed after another edit changed the file; the newer file was left untouched." }
				: { ok: false, revision: afterFailure.revision, reason: error instanceof Error ? error.message : String(error) };
		}
		const installed = readLlmPreferencesDocument(filePath);
		if (!installed.ok || !installed.document || installed.revision !== revisionOf(bytes)) {
			rollbackIfStillOwned(filePath, revisionOf(bytes), oldBytes);
			return { ok: false, revision: installed.revision, reason: "Saved configuration did not pass read-back verification." };
		}
		clearLlmPreferencesCache();
		return { ok: true, revision: installed.revision, ...(verified.warnings ? { warnings: verified.warnings } : {}) };
	} catch (error) {
		return { ok: false, revision: readLlmPreferencesDocument(filePath).revision, reason: error instanceof Error ? error.message : String(error) };
	} finally {
		release();
	}
}

/** Load and validate the preference document. Never throws: malformed input
 * reports `{ ok: false, reason }` so callers fall back to autonomous logic. */
export function loadLlmPreferences(filePath = llmPreferencesPath()): LlmPreferencesLoad {
	const stamp = stampOf(filePath);
	if (cache && cacheKey === filePath && cacheStamp === stamp) return cache;
	const miss = (reason: string, missing = false): LlmPreferencesLoad => {
		cacheKey = filePath; cacheStamp = stamp;
		return (cache = { ok: false, reason, path: filePath, ...(missing ? { missing: true } : {}) });
	};
	let raw: unknown;
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile() || stat.size > 256 * 1024) return miss("preference file is not a regular file or exceeds 256 KiB");
		raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return miss("preference file not present; autonomous selection applies", true);
		return miss(`preference file unreadable: ${error instanceof Error ? error.message : String(error)}`);
	}
	const checked = validateLlmPreferencesDocument(raw);
	if (!checked.ok) return miss(checked.reason);
	cacheKey = filePath; cacheStamp = stamp;
	return (cache = { ok: true, config: checked.config, path: filePath, ...(checked.warnings ? { warnings: checked.warnings } : {}) });
}

const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function cleanText(value: unknown, max = 512): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) return undefined;
	return text;
}

function parseEntry(value: unknown): LlmModelEntry | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const model = cleanText(raw.model);
	const provider = cleanText(raw.provider, 128);
	if (raw.provider !== undefined && !provider) return undefined;
	if (!model && !provider) return undefined;
	const thinking = cleanText(raw.thinking, 32);
	const options = raw.provider_options && typeof raw.provider_options === "object" && !Array.isArray(raw.provider_options)
		? (raw.provider_options as LlmProviderOptions) : undefined;
	return { ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(options ? { provider_options: options } : {}) };
}

function parseRegistry(value: unknown, warnings: string[]): Record<string, LlmModelEntry> | undefined {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: Record<string, LlmModelEntry> = Object.create(null);
	for (const [alias, entry] of Object.entries(value as Record<string, unknown>)) {
		if (!ALIAS_RE.test(alias)) { warnings.push("ignored an invalid model alias"); continue; }
		const parsed = parseEntry(entry);
		if (!parsed || !parsed.model) { warnings.push(`ignored invalid model alias ${JSON.stringify(alias)}`); continue; }
		out[alias] = parsed;
	}
	return out;
}

function parsePreferences(value: unknown, warnings: string[]): LlmPreferencesConfig["preferences"] | undefined {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: LlmPreferencesConfig["preferences"] = Object.create(null);
	for (const [role, spec] of Object.entries(value as Record<string, unknown>)) {
		const canonical = normalizePreferenceRole(role);
		if (!canonical) { warnings.push("ignored an invalid preference role"); continue; }
		const list = Array.isArray(spec) ? spec : (spec && typeof spec === "object" && !Array.isArray(spec)
			? (spec as Record<string, unknown>).models : undefined);
		if (!Array.isArray(list) || list.length > 64) { warnings.push(`ignored invalid preference list for ${canonical}`); continue; }
		const models: Array<string | LlmModelEntry> = [];
		for (const item of list) {
			if (typeof item === "string") {
				if (!ALIAS_RE.test(item.trim())) { warnings.push(`ignored invalid alias in ${canonical}`); continue; }
				models.push(item.trim());
				continue;
			}
			const parsed = parseEntry(item);
			if (!parsed || !parsed.model) { warnings.push(`ignored invalid model entry in ${canonical}`); continue; }
			models.push(parsed);
		}
		// Two raw keys can normalize to the same canonical role (for example
		// error_review and bug_reviews). The later list wins, as before, but the
		// collision is reported instead of silently discarding the earlier one.
		if (out[canonical]) warnings.push(`duplicate preference role ${canonical}; the later list replaced the earlier one`);
		out[canonical] = { models };
	}
	return out;
}

/** Canonical role names. Unknown roles pass through cleaned so future
 * mechanisms can use this file without a code change. */
export function normalizePreferenceRole(role: unknown): string | undefined {
	if (typeof role !== "string") return undefined;
	const key = role.trim().toLowerCase().replace(/[-_\s]+/g, "");
	if (!key || key.length > 64 || /[^a-z0-9]/.test(key)) return undefined;
	switch (key) {
		case "mainsessionfallback":
		case "mainfallback":
		case "main":
			return "main_session_fallback";
		case "subagents":
		case "subagent":
			return "subagents";
		case "council":
		case "councils":
			return "council";
		case "swarm":
		case "swarms":
			return "swarm";
		case "fusion":
			return "fusion";
		case "qualityreview":
		case "qualityreviews":
			return "quality_review";
		case "projectreview":
		case "projectreviews":
			return "project_review";
		case "errorreview":
		case "errorreviews":
		case "bugreview":
		case "bugreviews":
			return "error_review";
		case "promptanalysis":
		case "initialintentanalysis":
		case "followupintentanalysis":
			return "prompt_analysis";
		case "sessionobserver":
			return SESSION_OBSERVER_ROLE;
		case "watchmaker":
		case "mrwatchmaker":
			return WATCHMAKER_ROLE;
		default:
			return key;
	}
}

/** Ordered entries for a role, aliases resolved. Unknown aliases are skipped
 * here (partial failure); registry/unusability checks happen at resolve time
 * in model-fallback.ts where the live registry is available. */
export function preferenceEntriesFor(role: string, config: LlmPreferencesConfig): LlmModelEntry[] {
	const canonical = normalizePreferenceRole(role) ?? role;
	const spec = config.preferences[canonical];
	if (!spec) return [];
	const out: LlmModelEntry[] = [];
	for (const item of spec.models) {
		if (typeof item === "string") {
			const entry = config.models[item];
			if (entry) out.push(entry);
			continue;
		}
		out.push(item);
	}
	return out;
}

export interface NormalizedThinking {
	/** Concrete harness level, or undefined when dynamic logic should decide. */
	thinking?: ThinkingLevel;
	dynamic: boolean;
	note?: string;
}

/** Harness thinking values plus `auto` (dynamic) and `none` (off). Omitted,
 * `auto` or unrecognized values keep the existing dynamic-thinking logic. */
export function normalizeThinking(value: unknown): NormalizedThinking {
	if (value === undefined || value === null || value === "") return { dynamic: true };
	if (typeof value !== "string") return { dynamic: true, note: "thinking is not a string; dynamic logic applies" };
	const key = value.trim().toLowerCase();
	if (!key || key === "auto" || key === "dynamic") return { dynamic: true };
	if (key === "none") return { thinking: "off", dynamic: false };
	if ((THINKING_LEVELS as readonly string[]).includes(key)) return { thinking: key as ThinkingLevel, dynamic: false };
	return { dynamic: true, note: `unknown thinking level ${JSON.stringify(value)}; dynamic logic applies` };
}

/**
 * Translate `provider_options` to the existing OpenRouter `compat`
 * vocabulary. `auto` (or omitted) preserves normal OpenRouter selection by
 * returning undefined. `pinned` becomes a hard pin, `custom` an ordered
 * preference — the same shapes `/provider order|only|json` persists.
 * Only meaningful for OpenRouter routes; other providers ignore it.
 */
export function providerOptionsToRouting(
	options: LlmProviderOptions | undefined,
	provider: string,
): { routing?: Record<string, unknown>; note?: string } {
	if (!options) return {};
	if (options.routing !== undefined && typeof options.routing !== "string") return { note: "invalid provider_options.routing; expected auto, pinned, or custom" };
	if (provider.toLowerCase() !== "openrouter") return { note: "provider_options applies to OpenRouter routes only" };
	const routing = typeof options.routing === "string" ? options.routing.trim().toLowerCase() : "auto";
	const slugs = (value: unknown): string[] | undefined => {
		if (value === undefined) return undefined;
		if (!Array.isArray(value)) return undefined;
		const out = value.filter((s): s is string => typeof s === "string" && !!s.trim() && s.length <= 128 && !/[\u0000-\u001f\u007f]/.test(s)).map(s => s.trim());
		return out.length ? out : undefined;
	};
	if (routing === "auto" || routing === "") return {};
	// A malformed hard constraint must never silently become an unrestricted
	// provider request. Return a diagnostic so the resolver skips this entry.
	for (const key of ["order", "only", "ignore"] as const) {
		const raw = options[key];
		if (raw !== undefined && (!Array.isArray(raw) || raw.length > 32 || raw.some(item => typeof item !== "string" || !item.trim() || item.length > 128 || /[\u0000-\u001f\u007f]/.test(item))))
			return { note: `invalid provider_options.${key}; expected provider slugs` };
	}
	if (options.allow_fallbacks !== undefined && typeof options.allow_fallbacks !== "boolean") return { note: "invalid provider_options.allow_fallbacks; expected boolean" };
	if (options.sort !== undefined && (typeof options.sort !== "string" || !options.sort.trim() || options.sort.length > 32)) return { note: "invalid provider_options.sort" };
	if (routing === "pinned") {
		const order = slugs(options.order);
		if (!order) return { note: "pinned routing needs a non-empty order list" };
		return { routing: { only: order, order, allow_fallbacks: false } };
	}
	if (routing === "custom") {
		const order = slugs(options.order);
		const allow = typeof options.allow_fallbacks === "boolean" ? options.allow_fallbacks : true;
		const out: Record<string, unknown> = { ...(order ? { order } : {}), allow_fallbacks: allow };
		const only = slugs(options.only);
		if (only) out.only = only;
		const ignore = slugs(options.ignore);
		if (ignore) out.ignore = ignore;
		if (typeof options.sort === "string" && options.sort.trim() && options.sort.length <= 32) out.sort = options.sort.trim();
		return { routing: out };
	}
	return { note: `unknown provider_options.routing ${JSON.stringify(options.routing)}; normal routing applies` };
}

/** Conservative role inference for ad-hoc subagent tasks: only explicit
 * review/council phrasing selects a specialized role; everything else uses
 * the `subagents` chain. Automatic dispatchers pass their role explicitly. */
export function inferPreferenceRole(task = ""): string {
	const text = task.slice(0, 32768).replace(/```[\s\S]*?```/g, " ").replace(/^\s*>.*$/gm, " ");
	if (/\bproject[ -]?reviews?\b/i.test(text)) return "project_review";
	if (/\b(error[ -]?reviews?|bug[ -]?reviews?|root[ -]?cause[ -]?reviews?)\b/i.test(text)) return "error_review";
	if (/\bquality[ -]?reviews?\b/i.test(text)) return "quality_review";
	if (/\bcouncils?\b/i.test(text)) return "council";
	return "subagents";
}
