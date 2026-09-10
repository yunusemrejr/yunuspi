import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 25;

/** All memory writers share this owner, including append-only lifecycle hooks.
 * Do not reclaim locks by age: a suspended owner may resume and overwrite a
 * newer writer. An orphaned lock fails closed and requires explicit recovery.
 * The returned release is idempotent; callers release before QMD/model awaits.
 */
export async function acquireMemoryMutation(
	directory: string,
	signal?: AbortSignal | null,
	options: { timeoutMs?: number } = {},
): Promise<() => void> {
	const timeoutMs = options.timeoutMs ?? LOCK_WAIT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > LOCK_WAIT_MS) {
		throw new Error(`Memory lock timeout must be between 0 and ${LOCK_WAIT_MS}ms.`);
	}
	signal?.throwIfAborted();
	fs.mkdirSync(directory, { recursive: true });
	const lockPath = path.join(directory, ".mutation.lock");
	const token = randomUUID();
	const ownerPath = path.join(lockPath, token);
	const started = performance.now();
	for (;;) {
		signal?.throwIfAborted();
		try {
			fs.mkdirSync(lockPath, { mode: 0o700 });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const remaining = timeoutMs - (performance.now() - started);
			if (remaining <= 0) {
				throw new Error(`Memory mutation lock timed out after ${timeoutMs}ms: ${lockPath}. This operation changed no memory. If its owner has exited, remove this lock only after confirming no memory writer is active.`);
			}
			await delay(Math.min(LOCK_POLL_MS, remaining), undefined, { signal: signal ?? undefined });
		}
	}
	try {
		fs.writeFileSync(ownerPath, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
	} catch (error) {
		// Only remove our marker and an empty directory, never another owner.
		try { fs.unlinkSync(ownerPath); } catch {}
		try { fs.rmdirSync(lockPath); } catch {}
		throw error;
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		fs.unlinkSync(ownerPath);
		fs.rmdirSync(lockPath);
	};
}

/** A failed read must never become an empty rewrite. */
export function readMemoryForMutation(filePath: string): string | null {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

/** Write fully before replacing the old file; a failed write/rename keeps it.
 * Must be called under the shared memory mutation owner.
 */
export function replaceMemoryFile(filePath: string, content: string): void {
	// Existing memory files may be aliases into a shared notes directory. Match
	// writeFileSync's target semantics instead of silently replacing the alias.
	let destination = filePath;
	let mode = 0o600;
	try {
		destination = fs.realpathSync(filePath);
		mode = fs.statSync(destination).mode & 0o777;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		// A dangling alias is different from a new file: do not split it from
		// its intended destination merely because the target is unavailable.
		try {
			if (fs.lstatSync(filePath).isSymbolicLink()) {
				throw new Error(`Memory file is a dangling symlink: ${filePath}`);
			}
		} catch (statError) {
			if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
		}
	}
	const tempPath = `${destination}.${randomUUID()}.tmp`;
	let fd: number | undefined;
	try {
		fd = fs.openSync(tempPath, "wx", mode);
		fs.writeFileSync(fd, content, "utf-8");
		fs.fchmodSync(fd, mode);
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(tempPath, destination);
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		try { fs.unlinkSync(tempPath); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}
