import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const WAIT_MS = 5_000;
const POLL_MS = 25;
const MAX_OWNER_BYTES = 512;
const NOFOLLOW = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;

type Owner = { pid: number; token?: string };

function code(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

function pid(value: unknown): number | undefined {
	return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function readOwner(lockPath: string): Owner | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(path.join(lockPath, "owner"), fs.constants.O_RDONLY | NOFOLLOW);
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_OWNER_BYTES) return undefined;
		const text = fs.readFileSync(fd, "utf8").trim();
		if (/^\d+$/u.test(text)) {
			const ownerPid = pid(Number(text));
			return ownerPid === undefined ? undefined : { pid: ownerPid };
		}
		const parsed: unknown = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const ownerPid = pid((parsed as { pid?: unknown }).pid);
		const token = (parsed as { token?: unknown }).token;
		return ownerPid === undefined
			? undefined
			: { pid: ownerPid, ...(typeof token === "string" && token ? { token } : {}) };
	} catch (error) {
		if (code(error) === "ENOENT") return undefined;
		throw error;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function processIsAlive(ownerPid: number): boolean {
	try {
		process.kill(ownerPid, 0);
		return true;
	} catch (error) {
		// EPERM and unknown errors are treated as alive.  Reclaiming a live
		// writer is worse than leaving an uninspectable lock for manual recovery.
		return code(error) !== "ESRCH";
	}
}

/** Runs in a child already holding the kernel reclaim lock. */
function reclaimStaleLock(lockPath: string): boolean {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(lockPath);
	} catch (error) {
		if (code(error) === "ENOENT") return false;
		throw error;
	}
	if (!stat.isDirectory()) throw new Error(`Unsafe catalog cache lock (expected directory): ${lockPath}`);
	const entries = fs.readdirSync(lockPath, { withFileTypes: true });
	// Unknown/ownerless states are deliberately not guessed at.  This also
	// keeps a crash between mkdir and owner publication fail-closed.
	if (entries.length !== 1 || entries[0].name !== "owner" || !entries[0].isFile()) return false;
	const owner = readOwner(lockPath);
	if (!owner || processIsAlive(owner.pid)) return false;
	const retired = `${lockPath}.reclaimed-${process.pid}-${randomUUID()}`;
	try {
		// The parent holds flock on the reclaim gate while this re-check and move
		// run.  A second reclaimer therefore cannot move a new owner's directory.
		fs.renameSync(lockPath, retired);
	} catch (error) {
		if (code(error) === "ENOENT") return false;
		throw error;
	}
	fs.rmSync(retired, { recursive: true, force: true });
	return true;
}

function looksStale(lockPath: string): boolean {
	try {
		const stat = fs.lstatSync(lockPath);
		if (!stat.isDirectory()) return false;
		const entries = fs.readdirSync(lockPath, { withFileTypes: true });
		if (entries.length !== 1 || entries[0].name !== "owner" || !entries[0].isFile()) return false;
		const owner = readOwner(lockPath);
		return owner !== undefined && !processIsAlive(owner.pid);
	} catch {
		// The child re-checks authoritatively under flock.  This fast path only
		// avoids spawning it for the overwhelmingly common live/unknown case.
		return false;
	}
}

function attemptRecovery(lockPath: string, remainingMs: number): boolean {
	const gatePath = `${lockPath}.reclaim`;
	if (!looksStale(lockPath)) return false;
	let fd: number | undefined;
	try {
		fd = fs.openSync(gatePath, fs.constants.O_CREAT | fs.constants.O_RDWR | NOFOLLOW, 0o600);
	} catch {
		// Recovery is optional infrastructure.  If the gate cannot be created,
		// retain the old fail-closed timeout rather than guessing at ownership.
		return false;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
	const result = spawnSync(
		"flock",
		[
			"-n",
			gatePath,
			process.execPath,
			"--experimental-strip-types",
			fileURLToPath(import.meta.url),
			"--reclaim",
			lockPath,
		],
		{ stdio: "ignore", timeout: Math.max(1, Math.min(remainingMs, 1000)) },
	);
	return result.status === 0;
}

function releaseLock(lockPath: string, token: string): void {
	let owner: Owner | undefined;
	try {
		const stat = fs.lstatSync(lockPath);
		if (!stat.isDirectory()) return;
		owner = readOwner(lockPath);
	} catch (error) {
		if (code(error) === "ENOENT") return;
		throw error;
	}
	if (!owner || owner.pid !== process.pid || owner.token !== token) return;
	try {
		fs.unlinkSync(path.join(lockPath, "owner"));
	} catch (error) {
		if (code(error) === "ENOENT") return;
		throw error;
	}
	try {
		// Never recursively remove the live path: rmdir only succeeds for the
		// empty directory belonging to this owner.
		fs.rmdirSync(lockPath);
	} catch (error) {
		if (code(error) !== "ENOENT" && code(error) !== "ENOTEMPTY") throw error;
	}
}

/**
 * Acquire the cross-process lock associated with a catalog cache file.
 *
 * Existing `${cacheFile}.lock/owner` files containing a numeric PID remain
 * readable.  A live owner is never stolen.  Dead-owner recovery is serialized
 * by the kernel's `flock` command and re-checks ownership inside that lock;
 * ownerless or unknown directories fail closed.  Acquisition is bounded to
 * five seconds and obeys the optional abort signal.
 */
export async function acquireCatalogCacheLock(
	cacheFile: string,
	signal?: AbortSignal | null,
): Promise<() => void> {
	if (typeof cacheFile !== "string" || cacheFile.trim().length === 0) {
		throw new TypeError("Catalog cache file must be a non-empty path");
	}
	const cachePath = path.resolve(cacheFile);
	const lockPath = `${cachePath}.lock`;
	fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
	const started = performance.now();
	for (;;) {
		signal?.throwIfAborted();
		try {
			fs.mkdirSync(lockPath, { mode: 0o700 });
			const token = randomUUID();
			try {
				fs.writeFileSync(path.join(lockPath, "owner"), JSON.stringify({ pid: process.pid, token }) + "\n", {
					flag: "wx",
					mode: 0o600,
				});
			} catch (error) {
				try { fs.rmdirSync(lockPath); } catch {}
				throw error;
			}
			try {
				signal?.throwIfAborted();
			} catch (error) {
				releaseLock(lockPath, token);
				throw error;
			}
			let released = false;
			return () => {
				if (released) return;
				released = true;
				releaseLock(lockPath, token);
			};
		} catch (error) {
			if (code(error) !== "EEXIST") throw error;
			const remaining = WAIT_MS - (performance.now() - started);
			if (remaining <= 0) throw new Error(`Catalog cache lock timed out after ${WAIT_MS}ms: ${lockPath}`);
			signal?.throwIfAborted();
			if (attemptRecovery(lockPath, remaining)) continue;
			await delay(Math.min(POLL_MS, remaining), undefined, { signal: signal ?? undefined });
		}
	}
}

// `flock` invokes this module in a short-lived child while holding the
// reclaim gate.  The child performs the re-inspection and never calls the
// public acquisition loop recursively.
if (
	process.argv[2] === "--reclaim" &&
	process.argv[1] &&
	path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
	try {
		process.exitCode = reclaimStaleLock(process.argv[3]) ? 0 : 1;
	} catch {
		process.exitCode = 1;
	}
}
