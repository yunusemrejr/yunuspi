/**
 * Worktree checkpoints and the deterministic exit fallback summary.
 *
 * A killed long run (SIGTERM/SIGHUP, crash) must never lose uncommitted work
 * or leave the next session without a summary. Before each run and at
 * shutdown, a dirty git worktree is snapshotted into a private ref
 * (refs/yunuspi/checkpoints/<session>) through a TEMPORARY index: the user's
 * branch, index, stash and working tree are never touched. Snapshots are
 * idempotent (an unchanged tree reuses the previous commit) and bounded in
 * time; refs older than RETAIN_MS are pruned.
 *
 * exitFallbackSummary() composes a >300-character summary from session state
 * alone (no model call) for when the model-written exit summary cannot finish.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const CHECKPOINT_REF_PREFIX = "refs/yunuspi/checkpoints/";
const GIT_TIMEOUT_MS = 8_000;
const MAX_CHANGED = 5_000;
const RETAIN_MS = 14 * 24 * 60 * 60_000;
const REUSE_MS = 5_000;
export const FALLBACK_SUMMARY_MIN_CHARS = 300;

export interface WorktreeCheckpoint {
	ref: string;
	commit: string;
	changedCount: number;
	changed: string[];
	reused: boolean;
}

/** Structured checkpoint result. `undefined` used to conflate a verified
 * clean tree with not-a-repo, git failures, timeouts, oversized trees and
 * snapshot errors — and the exit summary then claimed "none detected" for
 * all of them. Only `clean` (git status established no changes) or
 * `snapshotted` may retire the uncommitted-work question. */
export type CheckpointStatus = "snapshotted" | "clean" | "not-git" | "skipped" | "failed";
export interface CheckpointOutcome {
	status: CheckpointStatus;
	ref?: string;
	commit?: string;
	changedCount?: number;
	changed?: string[];
	reused?: boolean;
	/** Bounded single-line reason for skipped/failed/not-git. */
	reason?: string;
}
export const isSnapshotted = (outcome: CheckpointOutcome): outcome is CheckpointOutcome & WorktreeCheckpoint & { status: "snapshotted" } =>
	outcome.status === "snapshotted" && typeof outcome.ref === "string" && typeof outcome.commit === "string";
const isCheckpointOutcome = (value: unknown): value is CheckpointOutcome =>
	!!value && typeof value === "object" && typeof (value as { status?: unknown }).status === "string";

const IDENTITY = {
	GIT_AUTHOR_NAME: "YunusPi checkpoint",
	GIT_AUTHOR_EMAIL: "checkpoint@yunuspi.invalid",
	GIT_COMMITTER_NAME: "YunusPi checkpoint",
	GIT_COMMITTER_EMAIL: "checkpoint@yunuspi.invalid",
};

function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", args, {
			cwd,
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: 16 * 1024 * 1024,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...env },
		}, (error, stdout) => error ? reject(error) : resolve(String(stdout)));
	});
}

const optional = (work: Promise<string>): Promise<string | undefined> => work.then(s => s.trim() || undefined, () => undefined);

/** Session ids become ref components: keep only a safe, bounded token. */
export function checkpointRef(sessionId: string): string {
	const token = String(sessionId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "session";
	return CHECKPOINT_REF_PREFIX + token;
}

/** Paths from `git status --porcelain=v1 -z` (renames carry the new path first). */
export function parsePorcelainZ(output: string): string[] {
	const fields = output.split("\0");
	const paths: string[] = [];
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i];
		if (field.length < 4) continue;
		paths.push(field.slice(3));
		if (field[0] === "R" || field[0] === "C") i++;
	}
	return paths;
}

const recent = new Map<string, { at: number; work: Promise<CheckpointOutcome> }>();

const boundReason = (value: unknown, fallback: string): string => {
	const flat = (value instanceof Error ? value.message : String(value ?? "")).replace(/\s+/g, " ").trim();
	return (flat || fallback).slice(0, 160);
};

/** Snapshot a dirty worktree into the session's private ref. Never throws;
 * every failure mode returns a classified outcome instead of undefined. */
export function checkpointWorktree(cwd: string, sessionId: string, reason: string): Promise<CheckpointOutcome> {
	const key = `${cwd}\0${sessionId}`;
	const cached = recent.get(key);
	if (cached && Date.now() - cached.at < REUSE_MS) return cached.work;
	const work = snapshot(cwd, sessionId, reason).catch((error) => ({ status: "failed" as const, reason: boundReason(error, "checkpoint failed") }));
	recent.set(key, { at: Date.now(), work });
	return work;
}

async function snapshot(cwd: string, sessionId: string, reason: string): Promise<CheckpointOutcome> {
	let top: string;
	try {
		top = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
	} catch (error) {
		// Only git's own not-a-repository verdict classifies as not-git; a
		// timeout, missing binary or signal is a failed inspection, not an
		// established fact about the directory. execFile keeps stderr off
		// the message, so classify from both.
		const detail = `${error instanceof Error ? error.message : ""} ${(error as { stderr?: unknown })?.stderr ?? ""}`;
		if (/not a git repository/i.test(detail)) return { status: "not-git", reason: "not a git worktree" };
		return { status: "failed", reason: boundReason((error as { stderr?: unknown })?.stderr || error, "git rev-parse failed") };
	}
	if (!top) return { status: "not-git", reason: "not a git worktree" };
	let changed: string[];
	try {
		changed = parsePorcelainZ(await git(top, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
	} catch (error) {
		return { status: "failed", reason: boundReason((error as { stderr?: unknown })?.stderr || error, "git status failed") };
	}
	if (!changed.length) return { status: "clean" };
	if (changed.length > MAX_CHANGED) return { status: "skipped", reason: `${changed.length} changed paths exceed the ${MAX_CHANGED}-path snapshot bound` };
	const ref = checkpointRef(sessionId);
	const head = await optional(git(top, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]));
	const previous = await optional(git(top, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]));
	const realIndex = path.resolve(top, (await git(top, ["rev-parse", "--git-path", "index"])).trim());
	const tempIndex = path.join(os.tmpdir(), `yunuspi-checkpoint-${process.pid}-${randomUUID()}.index`);
	try {
		// Seeding from the real index keeps its stat cache, so only changed files are re-hashed.
		if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tempIndex);
		const env = { GIT_INDEX_FILE: tempIndex };
		await git(top, ["add", "-A", "--", "."], env);
		const tree = (await git(top, ["write-tree"], env)).trim();
		if (previous && (await optional(git(top, ["rev-parse", `${previous}^{tree}`]))) === tree) {
			return { status: "snapshotted", ref, commit: previous, changedCount: changed.length, changed: changed.slice(0, 50), reused: true };
		}
		const parent = previous ?? head;
		const message = `YunusPi checkpoint (${reason.slice(0, 40)}): ${changed.length} changed path(s)`;
		const commit = (await git(top, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], IDENTITY)).trim();
		await git(top, ["update-ref", "-m", message, ref, commit]);
		await pruneOldCheckpoints(top, ref);
		return { status: "snapshotted", ref, commit, changedCount: changed.length, changed: changed.slice(0, 50), reused: false };
	} finally {
		fs.rmSync(tempIndex, { force: true });
	}
}

async function pruneOldCheckpoints(top: string, keep: string): Promise<void> {
	const listing = await optional(git(top, ["for-each-ref", "--format=%(refname) %(committerdate:unix)", CHECKPOINT_REF_PREFIX]));
	const cutoff = (Date.now() - RETAIN_MS) / 1000;
	for (const line of listing?.split("\n") ?? []) {
		const [name, stamp] = line.split(" ");
		if (name && name !== keep && Number(stamp) < cutoff) await optional(git(top, ["update-ref", "-d", name]));
	}
}

type BranchEntry = { type?: string; message?: { role?: string; content?: unknown } };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (part && typeof part === "object" && (part as any).type === "text" ? String((part as any).text ?? "") : "")).join(" ");
}

const oneLine = (text: string, max: number) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export interface ExitFallbackInput {
	sessionId: string;
	reason: string;
	branch: BranchEntry[];
	todos?: { pending: number; inProgress: number };
	checkpoint?: WorktreeCheckpoint | CheckpointOutcome;
}

/** Deterministic summary for a session whose model-written summary could not
 * finish. Returns undefined when the session never received a user demand. */
export function exitFallbackSummary(input: ExitFallbackInput): string | undefined {
	const messages = input.branch.filter(e => e?.type === "message" && e.message).map(e => e.message!);
	const users = messages.filter(m => m.role === "user").map(m => textOf(m.content)).filter(t => t.trim());
	if (!users.length) return undefined;
	const lastAssistant = [...messages].reverse().find(m => m.role === "assistant" && textOf(m.content).trim());
	const lines = [
		`Fallback exit summary (${input.reason}): the model-written summary did not complete, so this record was composed from session state without inference.`,
		`Latest user demand (${users.length} prompt${users.length === 1 ? "" : "s"} in session): ${oneLine(users[users.length - 1], 500)}`,
	];
	if (users.length > 1) lines.push(`First demand: ${oneLine(users[0], 300)}`);
	if (input.todos) lines.push(`Todos at exit: ${input.todos.inProgress} in progress, ${input.todos.pending} pending${input.todos.inProgress + input.todos.pending ? " — the work was NOT finished" : ""}.`);
	const checkpoint = input.checkpoint;
	if (checkpoint && (isCheckpointOutcome(checkpoint) ? checkpoint.status === "snapshotted" : true)) {
		const snap = checkpoint as WorktreeCheckpoint;
		const shown = (snap.changed ?? []).slice(0, 12).join(", ");
		const count = snap.changedCount ?? 0;
		const more = count > 12 ? ` (+${count - 12} more)` : "";
		lines.push(`Uncommitted work: ${count} changed path(s): ${shown}${more}. Snapshot ${snap.ref} @ ${String(snap.commit).slice(0, 12)}; inspect with \`git diff HEAD ${snap.ref}\`, restore a file with \`git checkout ${snap.ref} -- <path>\`.`);
	} else if (isCheckpointOutcome(checkpoint) && checkpoint.status === "clean") {
		lines.push("Uncommitted work: none — git status verified a clean tree.");
	} else if (isCheckpointOutcome(checkpoint)) {
		const what = checkpoint.status === "not-git" ? "the directory is not a git worktree" : `the worktree snapshot ${checkpoint.status}: ${checkpoint.reason ?? "no reason recorded"}`;
		lines.push(`Uncommitted work: UNKNOWN — ${what}, so no snapshot exists. Inspect the working tree directly; do not assume it is clean.`);
	} else lines.push("Uncommitted work: UNKNOWN — no worktree inspection ran for this session. Inspect the working tree directly; do not assume it is clean.");
	if (lastAssistant) lines.push(`Last assistant output: ${oneLine(textOf(lastAssistant.content), 400)}`);
	lines.push("Next session: verify the working tree against this record before continuing; do not assume the last demand was completed.");
	// The fixed header, worktree and next-session lines alone exceed FALLBACK_SUMMARY_MIN_CHARS.
	return lines.join("\n");
}
