/**
 * Advisory writer ownership and Git drift observations.
 *
 * The lease is deliberately non-blocking: multiple Codex sessions may need to
 * work in one checkout, but the harness must say when their writes overlap
 * instead of attributing every changed file to the session that noticed it.
 * Lease records live in the repository's private common Git directory, so no
 * tracked file or project artifact is changed.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const LEASE_DIR_NAME = "yunuspi-writer-leases";
const LEASE_VERSION = 1;
const MAX_PATHS = 128;
const MAX_CHECKOUTS = 128;
const SMALL_GIT_METADATA_BYTES = 8192;
const MAX_GIT_CONFIG_BYTES = 1024 * 1024;
const MAX_PACKED_REFS_BYTES = 16 * 1024 * 1024;

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

function trimGitWhitespace(value: string): string {
	return value.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");
}

function git(cwd: string, args: string[]): string {
	return trimGitWhitespace(execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 1000,
	}));
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
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

type GitIdentity = { root: string; commonDir: string; gitDir: string; refFormat: string };
const repoIdentityCache = new Map<string, { marker: string; identity: GitIdentity }>();

function nearestCheckout(cwd: string): { root: string; marker: string; directory: boolean } | undefined {
	try {
		let dir = fs.realpathSync(cwd);
		for (;;) {
			const stat = fs.statSync(path.join(dir, ".git"), { bigint: true, throwIfNoEntry: false });
			if (stat) {
				if (!stat.isFile() && !stat.isDirectory()) return undefined;
				// Gitfiles can be rewritten in place when a linked checkout moves.
				const revision = stat.isDirectory() ? "" : stat.ctimeNs;
				return { root: dir, marker: `${stat.dev}:${stat.ino}:${revision}`, directory: stat.isDirectory() };
			}
			const parent = path.dirname(dir);
			if (parent === dir) return undefined;
			dir = parent;
		}
	} catch { return undefined; }
}

function readGitMetadata(file: string, maxBytes = SMALL_GIT_METADATA_BYTES): string | undefined {
	let fd: number;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw error;
	}
	try {
		const info = fs.fstatSync(fd);
		if (!info.isFile() || info.size > maxBytes) throw new Error("Unsuitable Git metadata file");
		// Read the verified descriptor only, including one byte to detect growth
		// after validation. A changing or oversized file cannot consume more I/O.
		const buffer = Buffer.allocUnsafe(info.size + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
			if (count === 0) break;
			offset += count;
		}
		if (offset !== info.size) throw new Error("Git metadata changed during observation");
		return buffer.toString("utf8", 0, offset);
	} finally {
		fs.closeSync(fd);
	}
}

/** undefined = no ref in the files backend; null = needs authoritative Git resolution. */
function readRefSha(commonDir: string, gitDir: string, ref: string): string | null | undefined {
	const parts = ref.split("/");
	if (!ref.startsWith("refs/") || parts.some(part => !part || part === "." || part === "..")) throw new Error("Invalid Git reference");
	for (const base of commonDir === gitDir ? [gitDir] : [gitDir, commonDir]) {
		const sha = readGitMetadata(path.join(base, ref))?.trim();
		if (sha !== undefined) return /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null;
	}
	const packed = readGitMetadata(path.join(commonDir, "packed-refs"), MAX_PACKED_REFS_BYTES);
	for (const line of packed?.split("\n") ?? []) {
		const match = /^([0-9a-f]{40,64}) (.+)$/i.exec(trimGitWhitespace(line));
		if (match && match[2] === ref) return match[1];
	}
	return undefined;
}

function readUpstreamRef(commonDir: string, branch: string): string | undefined {
	// Minimal config read: locate [branch "<name>"] remote + merge entries.
	const config = readGitMetadata(path.join(commonDir, "config"), MAX_GIT_CONFIG_BYTES);
	if (!config) return undefined;
	let inSection = false, remote: string | undefined, merge: string | undefined;
	for (const rawLine of config.split("\n")) {
		const line = trimGitWhitespace(rawLine);
		const section = /^\[branch "(.+)"\]$/.exec(line);
		if (section) { inSection = section[1] === branch; continue; }
		if (line.startsWith("[")) { inSection = false; continue; }
		if (!inSection) continue;
		const kv = /^(\w+)[\t\v\f\r ]*=(.+)$/.exec(line);
		if (kv?.[1] === "remote") remote = trimGitWhitespace(kv[2]);
		if (kv?.[1] === "merge") merge = trimGitWhitespace(kv[2]);
	}
	if (!remote || !merge?.startsWith("refs/heads/")) return undefined;
	return `${remote}/${merge.slice("refs/heads/".length)}`;
}

/** null represents a verified files-format branch before its first commit. */
function readWorkspaceGitStateFromFiles(identity: GitIdentity): WorkspaceGitState | null | undefined {
	const { root, commonDir, gitDir, refFormat } = identity;
	const headFile = trimGitWhitespace(readGitMetadata(path.join(gitDir, "HEAD")) ?? "");
	if (!headFile) return undefined;
	let head: string | null | undefined, branch = "(detached)";
	const refMatch = /^ref:\s*(refs\/heads\/.+)$/.exec(headFile);
	if (refMatch) {
		branch = refMatch[1].slice("refs/heads/".length);
		head = readRefSha(commonDir, gitDir, refMatch[1]);
		if (head === undefined && !refMatch[1].includes("\uFFFD") && (refFormat === "files" || refFormat === "--show-ref-format")) {
			// Git can migrate the ref backend without replacing .git. Only
			// conclude "unborn" when current config cannot select another backend.
			const config = readGitMetadata(path.join(commonDir, "config"), MAX_GIT_CONFIG_BYTES);
			if (config !== undefined && !/^\s*(?:\[\s*include(?:if)?(?:\s|\])|refstorage\s*=)/im.test(config)) return null;
		}
	} else if (/^[0-9a-f]{40,64}$/i.test(headFile)) {
		head = headFile;
	}
	if (!head) return undefined;
	const upstream = branch === "(detached)" ? undefined : readUpstreamRef(commonDir, branch);
	const upstreamRef = upstream?.startsWith("./") ? `refs/heads/${upstream.slice(2)}` : upstream ? `refs/remotes/${upstream}` : undefined;
	const upstreamHead = upstreamRef ? readRefSha(commonDir, gitDir, upstreamRef) : undefined;
	return { root, commonDir, head, branch, ...(upstream ? { upstream } : {}), ...(upstreamHead ? { upstreamHead } : {}) };
}

export function readWorkspaceGitState(cwd: string): WorkspaceGitState | undefined {
	const { GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, GIT_CEILING_DIRECTORIES, GIT_DISCOVERY_ACROSS_FILESYSTEM } = process.env;
	const overridden = GIT_DIR || GIT_WORK_TREE || GIT_COMMON_DIR || GIT_CEILING_DIRECTORIES || GIT_DISCOVERY_ACROSS_FILESYSTEM;
	const checkout = overridden ? undefined : nearestCheckout(cwd);
	if (!checkout && !overridden) return undefined;
	try {
		let identity: GitIdentity | undefined;
		if (checkout) {
			const cached = repoIdentityCache.get(checkout.root);
			if (cached?.marker === checkout.marker) identity = cached.identity;
			else {
				repoIdentityCache.delete(checkout.root);
				// Reject an unsuitable known checkout HEAD before invoking git.
				const entry = path.join(checkout.root, ".git");
				const pointer = checkout.directory ? undefined : /^gitdir: (.+)$/.exec(trimGitWhitespace(readGitMetadata(entry) ?? ""));
				if (checkout.directory || pointer) {
					const dir = pointer ? path.resolve(checkout.root, pointer[1]) : entry;
					if (readGitMetadata(path.join(dir, "HEAD")) === undefined) return undefined;
				}
			}
		}
		if (!identity) {
			// Identify the checkout independently: an unborn HEAD does not
			// invalidate the root or require a new subprocess on every result.
			const [rootRaw, commonRaw, gitDirRaw, refFormat] = git(cwd, ["rev-parse", "--show-toplevel", "--git-common-dir", "--git-dir", "--show-ref-format"]).split("\n");
			if (!rootRaw || !commonRaw || !gitDirRaw) return undefined;
			const root = path.resolve(rootRaw), commonDir = path.resolve(cwd, commonRaw), gitDir = path.resolve(cwd, gitDirRaw);
			identity = { root, commonDir, gitDir, refFormat };
			if (checkout) {
				const current = nearestCheckout(cwd);
				if (current?.root !== checkout.root || current?.marker !== checkout.marker) return undefined;
			}
			if (checkout?.root === root) {
				if (repoIdentityCache.size >= MAX_CHECKOUTS) {
					const oldest = repoIdentityCache.keys().next().value;
					if (oldest !== undefined) repoIdentityCache.delete(oldest);
				}
				repoIdentityCache.set(root, { marker: checkout.marker, identity });
			}
		}
		const viaFiles = readWorkspaceGitStateFromFiles(identity);
		if (viaFiles !== undefined) return viaFiles ?? undefined;
		const head = optionalGit(cwd, ["rev-parse", "--verify", "HEAD"]);
		if (!head) return undefined;
		const branch = optionalGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]) ?? "(detached)";
		const upstream = optionalGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
		const upstreamHead = upstream ? optionalGit(cwd, ["rev-parse", upstream]) : undefined;
		const { root, commonDir } = identity;
		return { root, commonDir, head, branch, ...(upstream ? { upstream } : {}), ...(upstreamHead ? { upstreamHead } : {}) };
	} catch {
		// Confirmed unsuitable metadata must not be reopened by a synchronous Git fallback.
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

function leaseName(state: WorkspaceGitState, sessionId: string): string {
	const key = createHash("sha256").update(`${state.root}\0${sessionId}`).digest("hex").slice(0, 32);
	return `session-${key}.json`;
}

function leaseFile(state: WorkspaceGitState, sessionId: string): string {
	return path.join(leaseDir(state), leaseName(state, sessionId));
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
			.flatMap((entry) => {
				const lease = readLeaseFile(path.join(leaseDir(state), entry.name));
				// Worktrees share the directory. The existing filename already
				// identifies its checkout, including for leases written by older versions.
				return lease && entry.name === leaseName(state, lease.sessionId) && processAlive(lease.pid)
					? [lease] : [];
			});
	} catch {
		return [];
	}
}

function writeLease(file: string, lease: WorkspaceWriterLease): void {
	const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(lease), { flag: "wx", mode: 0o600 });
		fs.renameSync(tmp, file);
	} finally {
		try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
	}
}

const ownedLeaseFiles = new Map<string, string>();

function removeOwnedLease(file: string): void {
	if (readLeaseFile(file)?.pid !== process.pid) return;
	try { fs.rmSync(file, { force: true }); } catch { /* advisory only */ }
}

function refreshLease(state: WorkspaceGitState, cwd: string, sessionId: string, touchedPath?: string): WorkspaceWriterLease | undefined {
	try { fs.mkdirSync(leaseDir(state), { recursive: true, mode: 0o700 }); } catch { return undefined; }
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
		paths: existing?.paths ?? [],
	};
	if (touchedPath !== undefined) lease.paths = [...lease.paths.filter((entry) => entry !== touchedPath), touchedPath];
	lease.paths = lease.paths.slice(-MAX_PATHS);
	try { writeLease(file, lease); } catch { return undefined; }
	const key = `${lease.cwd}\0${sessionId}`;
	const previous = ownedLeaseFiles.get(key);
	if (previous && previous !== file) removeOwnedLease(previous);
	ownedLeaseFiles.set(key, file);
	return lease;
}

export function acquireWorkspaceWriterLease(cwd: string, sessionId: string): { state?: WorkspaceGitState; lease?: WorkspaceWriterLease; conflicts: WorkspaceLeaseOwner[] } {
	const state = readWorkspaceGitState(cwd);
	if (!state || !sessionId) return { conflicts: [] };
	const lease = refreshLease(state, cwd, sessionId);
	return {
		state,
		lease,
		conflicts: activeLeases(state).filter((other) => other.sessionId !== sessionId).map(toOwner),
	};
}

export function releaseWorkspaceWriterLease(cwd: string, sessionId: string): void {
	if (!sessionId) return;
	const key = `${path.resolve(cwd)}\0${sessionId}`;
	const owned = ownedLeaseFiles.get(key);
	ownedLeaseFiles.delete(key);
	if (owned) removeOwnedLease(owned);
	else {
		const state = readWorkspaceGitState(cwd);
		if (state) removeOwnedLease(leaseFile(state, sessionId));
	}
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
	refreshLease(resolved.state, cwd, sessionId, resolved.relative);
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
	// Shell-made changes (sed -i, generators, cp) never name paths in a lease.
	// When this session is the only active writer in the checkout, they are its
	// own: saying "unattributed" there only hides the owner from the gates.
	if (leases.some((lease) => lease.sessionId === sessionId)) return { status: "current_session", sessionId, detail: "sole active writer in this checkout" };
	return { status: "unattributed", detail: "no writer lease named this path" };
}
