/**
 * Advisory writer ownership and Git drift observations.
 *
 * The lease is deliberately non-blocking: multiple Codex sessions may need to
 * work in one checkout, but the harness must say when their writes overlap
 * instead of attributing every changed file to the session that noticed it.
 * Lease records live in the repository's private common Git directory, so no
 * tracked file or project artifact is changed.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const LEASE_DIR_NAME = "yunuspi-writer-leases";
const LEASE_VERSION = 1;
const MAX_PATHS = 128;

export interface WorkspaceGitState {
	root: string;
	commonDir: string;
	head: string;
	branch: string;
	upstream?: string;
	upstreamHead?: string;
}

export interface WorkspaceWriterLease {
	version: 1;
	sessionId: string;
	pid: number;
	cwd: string;
	acquiredAt: number;
	updatedAt: number;
	paths: string[];
}

export interface WorkspaceLeaseOwner {
	sessionId: string;
	pid: number;
	cwd: string;
	paths: string[];
}

export interface WorkspaceMutationRecord {
	path: string;
	tool: string;
	sha256?: string;
	observedAt: number;
	conflicts: WorkspaceLeaseOwner[];
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 1000,
	}).trim();
}

function optionalGit(cwd: string, args: string[]): string | undefined {
	try {
		const value = git(cwd, args);
		return value || undefined;
	} catch {
		return undefined;
	}
}

function inside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function readWorkspaceGitState(cwd: string): WorkspaceGitState | undefined {
	try {
		const root = path.resolve(git(cwd, ["rev-parse", "--show-toplevel"]));
		const commonRaw = git(cwd, ["rev-parse", "--git-common-dir"]);
		const commonDir = path.resolve(cwd, commonRaw);
		const head = git(cwd, ["rev-parse", "HEAD"]);
		const branch = optionalGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]) ?? "(detached)";
		const upstream = optionalGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
		const upstreamHead = upstream ? optionalGit(cwd, ["rev-parse", upstream]) : undefined;
		return { root, commonDir, head, branch, ...(upstream ? { upstream } : {}), ...(upstreamHead ? { upstreamHead } : {}) };
	} catch {
		return undefined;
	}
}

export function workspaceGitDrift(before: WorkspaceGitState | undefined, after: WorkspaceGitState | undefined): string[] {
	if (!before || !after || before.root !== after.root) return [];
	const warnings: string[] = [];
	if (before.head !== after.head) warnings.push(`HEAD moved during session (${before.head.slice(0, 12)} -> ${after.head.slice(0, 12)}).`);
	if (before.branch !== after.branch) warnings.push(`checked-out branch changed during session (${before.branch} -> ${after.branch}).`);
	if (before.upstream !== after.upstream) warnings.push(`upstream ref changed during session (${before.upstream ?? "none"} -> ${after.upstream ?? "none"}).`);
	if (before.upstream && after.upstream === before.upstream && before.upstreamHead !== after.upstreamHead) {
		warnings.push(`remote-tracking ref ${before.upstream} moved during session (${(before.upstreamHead ?? "none").slice(0, 12)} -> ${(after.upstreamHead ?? "none").slice(0, 12)}).`);
	}
	return warnings;
}

function leaseDir(state: WorkspaceGitState): string {
	return path.join(state.commonDir, LEASE_DIR_NAME);
}

function leaseFile(state: WorkspaceGitState, sessionId: string): string {
	const key = createHash("sha256").update(`${state.root}\0${sessionId}`).digest("hex").slice(0, 32);
	return path.join(leaseDir(state), `session-${key}.json`);
}

function validLease(value: unknown): value is WorkspaceWriterLease {
	if (!value || typeof value !== "object") return false;
	const lease = value as Partial<WorkspaceWriterLease>;
	return lease.version === LEASE_VERSION && typeof lease.sessionId === "string" && typeof lease.pid === "number" &&
		numberIsPositive(lease.pid) && typeof lease.cwd === "string" && typeof lease.acquiredAt === "number" &&
		typeof lease.updatedAt === "number" && Array.isArray(lease.paths) && lease.paths.every((p) => typeof p === "string");
}

function numberIsPositive(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function processAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

function readLeaseFile(file: string): WorkspaceWriterLease | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		return validLease(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function activeLeases(state: WorkspaceGitState): WorkspaceWriterLease[] {
	try {
		return fs.readdirSync(leaseDir(state), { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
			.map((entry) => readLeaseFile(path.join(leaseDir(state), entry.name)))
			.filter((lease): lease is WorkspaceWriterLease => Boolean(lease) && processAlive(lease.pid));
	} catch {
		return [];
	}
}

function writeLease(file: string, lease: WorkspaceWriterLease): void {
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(lease), { flag: "wx", mode: 0o600 });
		fs.renameSync(tmp, file);
	} finally {
		try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
	}
}

export function acquireWorkspaceWriterLease(cwd: string, sessionId: string): { state?: WorkspaceGitState; lease?: WorkspaceWriterLease; conflicts: WorkspaceLeaseOwner[] } {
	const state = readWorkspaceGitState(cwd);
	if (!state || !sessionId) return { conflicts: [] };
	try { fs.mkdirSync(leaseDir(state), { recursive: true, mode: 0o700 }); } catch { return { state, conflicts: [] }; }
	const file = leaseFile(state, sessionId);
	const existing = readLeaseFile(file);
	const now = Date.now();
	const lease: WorkspaceWriterLease = {
		version: LEASE_VERSION,
		sessionId,
		pid: process.pid,
		cwd: path.resolve(cwd),
		acquiredAt: existing?.acquiredAt ?? now,
		updatedAt: now,
		paths: existing?.paths?.slice(-MAX_PATHS) ?? [],
	};
	try { writeLease(file, lease); } catch { /* advisory only */ }
	return {
		state,
		lease,
		conflicts: activeLeases(state).filter((other) => other.sessionId !== sessionId).map(toOwner),
	};
}

export function releaseWorkspaceWriterLease(cwd: string, sessionId: string): void {
	const state = readWorkspaceGitState(cwd);
	if (!state || !sessionId) return;
	try { fs.rmSync(leaseFile(state, sessionId), { force: true }); } catch { /* advisory only */ }
}

function toOwner(lease: WorkspaceWriterLease): WorkspaceLeaseOwner {
	return { sessionId: lease.sessionId, pid: lease.pid, cwd: lease.cwd, paths: lease.paths.slice(-MAX_PATHS) };
}

export function workspacePath(cwd: string, rawPath: string): { state?: WorkspaceGitState; absolute: string; relative: string } {
	const state = readWorkspaceGitState(cwd);
	const absolute = path.resolve(cwd, rawPath);
	const relative = state && inside(state.root, absolute) ? path.relative(state.root, absolute) || "." : absolute;
	return { ...(state ? { state } : {}), absolute, relative };
}

export function workspaceFileSha256(absolute: string): string | undefined {
	try {
		const stat = fs.statSync(absolute);
		if (!stat.isFile() || stat.size > 1 << 20) return undefined;
		return createHash("sha256").update(fs.readFileSync(absolute)).digest("hex");
	} catch {
		return undefined;
	}
}

export function recordWorkspaceMutation(cwd: string, sessionId: string, rawPath: string | undefined, tool: string): WorkspaceMutationRecord | undefined {
	if (!rawPath) return undefined;
	const resolved = workspacePath(cwd, rawPath);
	const sha256 = workspaceFileSha256(resolved.absolute);
	if (!resolved.state || !sessionId) {
		return { path: resolved.relative, tool, ...(sha256 ? { sha256 } : {}), observedAt: Date.now(), conflicts: [] };
	}
	const acquired = acquireWorkspaceWriterLease(cwd, sessionId);
	const lease = acquired.lease;
	if (lease) {
		const nextPaths = [...new Set([...lease.paths, resolved.relative])].slice(-MAX_PATHS);
		try { writeLease(leaseFile(resolved.state, sessionId), { ...lease, paths: nextPaths, updatedAt: Date.now() }); } catch { /* advisory only */ }
	}
	const conflicts = activeLeases(resolved.state)
		.filter((other) => other.sessionId !== sessionId && (other.paths.length === 0 || other.paths.includes(resolved.relative)))
		.map(toOwner);
	return {
		path: resolved.relative,
		tool,
		...(sha256 ? { sha256 } : {}),
		observedAt: Date.now(),
		conflicts,
	};
}

export function attributeWorkspacePath(cwd: string, sessionId: string, relativePath: string): { status: "current_session" | "another_session" | "unattributed"; sessionId?: string; detail?: string } {
	const state = readWorkspaceGitState(cwd);
	if (!state) return { status: "unattributed", detail: "not a Git checkout" };
	const leases = activeLeases(state);
	// A foreign lease wins over the current session: concurrent ownership is
	// ambiguity, and the project-test gate must not silently credit this session
	// for a path another writer also touched.
	const foreign = leases.find((lease) => lease.sessionId !== sessionId && lease.paths.includes(relativePath));
	if (foreign) return { status: "another_session", sessionId: foreign.sessionId, detail: `writer lease in ${foreign.cwd}` };
	const owner = leases.find((lease) => lease.sessionId === sessionId && lease.paths.includes(relativePath));
	if (owner) return { status: "current_session", sessionId };
	if (leases.some((lease) => lease.sessionId !== sessionId)) return { status: "unattributed", detail: "another active writer lease exists, but it did not name this path" };
	return { status: "unattributed", detail: "no writer lease named this path" };
}
