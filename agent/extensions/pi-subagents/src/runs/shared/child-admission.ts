import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { homedir, hostname } from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { processIdentity } from "../../../../lib/process-owner.ts";

const DEFAULT_CAPACITY = 4;
const DEFAULT_WAIT_MS = 30_000;
const LEGACY_LEASE = /^subagent-([1-9]\d*)-[a-z0-9]+\.lock$/;
const SLOT_DIRECTORY = /^slot-v1-(\d+)$/;

export type ChildAdmissionFailureKind = "cancelled" | "timed_out" | "capacity" | "unavailable";
export interface ChildAdmissionLease {
	markSpawning(): void;
	markChild(pid: number): void;
	release(): void;
}
export type ChildAdmissionResult = { kind: "admitted"; lease: ChildAdmissionLease }
	| { kind: ChildAdmissionFailureKind; error: string };

interface Owner {
	token: string;
	host: string;
	pid: number;
	identity: string;
	state: "reserved" | "spawning" | "running";
	childPid?: number;
	childIdentity?: string;
}

function positivePid(pid: unknown): pid is number {
	return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
}

function processGone(pid: number, identity?: string): boolean {
	try { process.kill(pid, 0); }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
	const current = identity && processIdentity(pid);
	return Boolean(current && current !== identity);
}

function readOwner(slot: string): Owner | null | undefined {
	try {
		const file = path.join(slot, "owner.json");
		const stat = fs.lstatSync(file);
		if (!stat.isFile() || stat.size > 4096) return null;
		const owner = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Owner> | null;
		if (!owner || !positivePid(owner.pid) || typeof owner.host !== "string" || typeof owner.identity !== "string" ||
			typeof owner.token !== "string" || !/^[a-f0-9-]{36}$/.test(owner.token)) return null;
		if (owner.state === "running") {
			if (!positivePid(owner.childPid) || typeof owner.childIdentity !== "string") return null;
		} else if (owner.state !== "reserved" && owner.state !== "spawning") return null;
		return owner as Owner;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && !fs.existsSync(slot)) return undefined;
		return null;
	}
}

function reclaimable(owner: Owner): boolean {
	if (owner.host !== hostname() || !processGone(owner.pid, owner.identity)) return false;
	if (owner.state === "reserved") return true;
	// Death between spawn and PID publication leaves an ambiguous child. Keep
	// that slot until an operator can establish what happened.
	return owner.state === "running" && positivePid(owner.childPid) && processGone(owner.childPid, owner.childIdentity);
}

function claim(directory: string, index: number): ChildAdmissionLease | undefined {
	const metadataDir = path.join(directory, ".subagent-admission-v1");
	const slot = path.join(directory, `slot-v1-${index}`);
	const existing = readOwner(slot);
	if (existing === null) return undefined;
	if (existing) {
		if (!reclaimable(existing)) return undefined;
		// Keep the token's nonempty tombstone. A second reaper that observed the
		// same stale token can never rename its successor over this destination.
		const tombstone = path.join(metadataDir, `stale-${existing.token}`);
		try { fs.renameSync(slot, tombstone); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT" || fs.existsSync(tombstone)) return undefined;
			throw error;
		}
	}
	const owner: Owner = {
		token: randomUUID(), host: hostname(), pid: process.pid,
		identity: processIdentity(process.pid), state: "reserved",
	};
	const candidate = fs.mkdtempSync(path.join(metadataDir, "candidate-"));
	try {
		fs.writeFileSync(path.join(candidate, "owner.json"), JSON.stringify(owner), { mode: 0o600, flag: "wx" });
		try { fs.renameSync(candidate, slot); }
		catch (error) {
			if (["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
			throw error;
		}
	} finally {
		fs.rmSync(candidate, { recursive: true, force: true });
	}
	let released = false;
	const update = (next: Owner): void => {
		if (released || readOwner(slot)?.token !== owner.token) throw new Error("Child admission ownership changed.");
		const candidateOwner = path.join(slot, `.owner-${owner.token}`);
		try {
			fs.writeFileSync(candidateOwner, JSON.stringify(next), { mode: 0o600, flag: "wx" });
			fs.renameSync(candidateOwner, path.join(slot, "owner.json"));
		} finally { fs.rmSync(candidateOwner, { force: true }); }
	};
	return {
		markSpawning: () => update({ ...owner, state: "spawning" }),
		markChild(pid) {
			if (!positivePid(pid)) return;
			try { update({ ...owner, state: "running", childPid: pid, childIdentity: processIdentity(pid) }); }
			catch { /* Keep the spawning claim if the writer identity cannot be published. */ }
		},
		release() {
			if (released) return;
			if (readOwner(slot)?.token !== owner.token) return;
			const retired = path.join(metadataDir, `released-${owner.token}`);
			try {
				// Detach the whole slot before deleting. An empty active directory
				// could otherwise be replaced by a new claim during removal.
				fs.renameSync(slot, retired);
				released = true;
			} catch { /* A retained lease is safe and can be reclaimed after proven exit. */ }
			if (released) {
				try { fs.rmSync(retired, { recursive: true, force: true }); } catch { /* Inactive entry. */ }
			}
		},
	};
}

function availableSlots(directory: string, capacity: number): number {
	const names = fs.readdirSync(directory);
	const legacy = names.filter(name => {
		const match = name.match(LEGACY_LEASE);
		if (!match) return false;
		const pid = Number(match[1]);
		// Legacy files only identify their parent. Preserve live holders and
		// recent uncertain files during the upgrade, without modifying them.
		if (!positivePid(pid) || !processGone(pid)) return true;
		try { return Date.now() - fs.lstatSync(path.join(directory, name)).mtimeMs < 300_000; }
		catch { return false; }
	}).length;
	let available = capacity - legacy;
	// If settings changed while other parents were running, leases above the
	// current slot range still consume capacity. Shared parents should use
	// the same cap, and old gate versions cannot enforce this atomic protocol.
	const indexes = names.flatMap(name => {
		const match = name.match(SLOT_DIRECTORY);
		return match ? [Number(match[1])] : [];
	}).sort((a, b) => b - a);
	for (const index of indexes) {
		if (index < available) break;
		const owner = readOwner(path.join(directory, `slot-v1-${index}`));
		if (owner === null || (owner && !reclaimable(owner))) available--;
	}
	return available;
}

export async function acquireChildAdmission(options: {
	signal?: AbortSignal;
	deadlineAt?: number;
	directory?: string;
	capacity?: number;
	waitMs?: number;
} = {}): Promise<ChildAdmissionResult> {
	const { signal, deadlineAt } = options;
	const directory = options.directory ?? process.env.PI_SUBAGENT_ADMISSION_DIR ?? path.join(homedir(), ".pi", "inference-slots");
	const configured = options.capacity ?? Number(process.env.PI_SUBAGENT_MAX_CONCURRENT);
	const capacity = Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_CAPACITY;
	const waitUntil = Date.now() + (options.waitMs ?? DEFAULT_WAIT_MS);
	const cancelled = { kind: "cancelled", error: "Subagent stopped while waiting for a child slot." } as const;
	const timedOut = { kind: "timed_out", error: "Subagent timed out waiting for a child slot." } as const;
	const full = { kind: "capacity", error: `Subagent child admission is full (${capacity} configured slots).` } as const;
	try {
		if (signal?.aborted) return cancelled;
		if (deadlineAt !== undefined && Date.now() >= deadlineAt) return timedOut;
		fs.mkdirSync(path.join(directory, ".subagent-admission-v1"), { recursive: true, mode: 0o700 });
		for (;;) {
			const available = availableSlots(directory, capacity);
			for (let slot = 0; slot < available; slot++) {
				const lease = claim(directory, slot);
				if (lease) {
					if (deadlineAt === undefined || Date.now() < deadlineAt) return { kind: "admitted", lease };
					lease.release();
					return timedOut;
				}
			}
			const remaining = Math.min(waitUntil, deadlineAt ?? Infinity) - Date.now();
			if (remaining <= 0) return deadlineAt !== undefined && deadlineAt <= waitUntil ? timedOut : full;
			await delay(Math.min(remaining, 55 + Math.random() * 35), undefined, { signal });
			if (signal?.aborted) return cancelled;
			if (deadlineAt !== undefined && Date.now() >= deadlineAt && deadlineAt <= waitUntil) return timedOut;
			if (Date.now() >= waitUntil) return full;
		}
	} catch (error) {
		if (signal?.aborted) return cancelled;
		const code = (error as NodeJS.ErrnoException).code;
		return { kind: "unavailable", error: `Subagent child admission is unavailable${code ? ` (${code})` : ""}.` };
	}
}
