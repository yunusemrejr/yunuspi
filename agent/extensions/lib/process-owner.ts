/**
 * Session-owned process lifetime.
 *
 * A YunusPi process that starts long-lived detached children (managed bash
 * jobs, background tasks, browsers, desktop sessions, video renders) or uses
 * the shared local model writes one owner record, <dir>/<pid>: its own start
 * identity on the first line, then one "pgid identity" line per process group
 * it owns. Graceful shutdown already stops those groups via session_shutdown;
 * the record is the backstop when that never runs (SIGKILL, a terminal closed
 * under a stalled handler, a hung teardown). One detached reaper per owner
 * (scripts/process-owner.sh reap) waits for the owner to die, stops the
 * listed groups whose leader identity still matches, and deletes the record.
 *
 * The same records are the leases on the shared local model: its unit runs
 * under `process-owner.sh guard`, which stops the server once no live owner
 * record has existed for a grace period. The model therefore never outlives
 * the last session, and one session exiting never stops it under another.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const LOCAL_LM_SERVICE = "pi-local-lm.service";
export const OWNER_SCRIPT = fileURLToPath(new URL("../../scripts/process-owner.sh", import.meta.url));

export function ownerDir(env: NodeJS.ProcessEnv = process.env): string {
	if (env.PI_OWNER_DIR) return env.PI_OWNER_DIR;
	// Must match the unit's %t (the user manager's XDG_RUNTIME_DIR).
	const uid = userInfo().uid, run = `/run/user/${uid}`;
	const base = env.XDG_RUNTIME_DIR || (existsSync(run) ? run : join(tmpdir(), `yunuspi-${uid}`));
	return join(base, "yunuspi", "owners");
}

function statFields(pid: number): string[] | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	} catch { return undefined; }
}

/** Kernel start time of a pid (Linux), or "" where /proc is unavailable. */
export function processIdentity(pid: number): string {
	return statFields(pid)?.[19] ?? "";
}

let record: string | undefined;

/** Idempotent: writes this process's record and starts its reaper once. */
export function ensureOwnerRecord(): string | undefined {
	if (record) return record;
	if (process.platform === "win32") return undefined;
	try {
		const dir = ownerDir();
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const path = join(dir, String(process.pid)), identity = processIdentity(process.pid);
		writeFileSync(path, `${identity}\n`, { mode: 0o600 });
		const reaper = spawn("/bin/bash", [OWNER_SCRIPT, "reap", path, String(process.pid), identity], { cwd: "/", detached: true, stdio: "ignore" });
		reaper.once("error", () => { /* backstop only; graceful shutdown still applies */ });
		reaper.unref();
		record = path;
	} catch { /* backstop only */ }
	return record;
}

export function resetOwnerRecordForTests(): void { record = undefined; servicesRequestedAt = 0; }

/** Record a detached child's process group so it dies with this process.
 * Only a direct child that leads its own group is recorded (Linux), so an
 * unrelated or recycled pid can never be listed for killing. */
export function ownProcessGroup(pgid: number | undefined): void {
	if (!pgid) return;
	const fields = statFields(pgid);
	if (!fields || Number(fields[1]) !== process.pid || Number(fields[2]) !== pgid) return;
	const path = ensureOwnerRecord();
	if (!path) return;
	try { appendFileSync(path, `${pgid} ${fields[19]}\n`); } catch { /* backstop only */ }
}

let servicesRequestedAt = 0;

/** Hold a lease on the local model and start its unit when it is down.
 * Throttled; a no-op without a user systemd unit (manual installs). */
export function ensureLocalServices(now = Date.now()): boolean {
	if (process.platform !== "linux" || now - servicesRequestedAt < 30_000) return false;
	if (!existsSync(join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", LOCAL_LM_SERVICE))) return false;
	if (!ensureOwnerRecord()) return false;
	servicesRequestedAt = now;
	try {
		const child = spawn("systemctl", ["--user", "start", "--no-block", LOCAL_LM_SERVICE], { stdio: "ignore", detached: true });
		child.once("error", () => {});
		child.unref();
	} catch { return false; }
	return true;
}

/** True shortly after this process asked the local model to start. */
export function localServicesWarming(now = Date.now(), windowMs = 20_000): boolean {
	return servicesRequestedAt > 0 && now - servicesRequestedAt < windowMs;
}
