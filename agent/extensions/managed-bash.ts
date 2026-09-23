/**
 * Managed Bash — optimistic foreground -> supervised background execution.
 *
 * WHY: the builtin bash tool blocks the agent for the full `timeout` (default
 * 120s injected by timeout-guard, sometimes minutes when the model passes a
 * large explicit timeout). A long command therefore froze the whole session:
 * no partial output, no kill, no parallel work. This extension replaces the
 * bash tool (extension-registered tools override built-ins by name in pi's
 * tool registry) with the SAME builtin tool definition — schema, rendering,
 * truncation, exit-code errors, commandPrefix and PI_* env semantics are all
 * inherited — but keeps the execution layer supervised:
 *
 *   - the user-facing bash tool keeps ordinary blocking/sequential semantics;
 *   - bounded internal captures run under a 4s foreground grace period;
 *   - an internal capture still running -> detached to an in-process job
 *     registry, agent gets a handle and stays in control via `process`;
 *   - `timeout` is a DEADLINE on the managed job (kill at expiry, status
 *     timed_out), never an agent-blocking wait.
 *
 * Jobs are ephemeral to the pi process (no on-disk state anywhere, so no
 * cwd-relative store litter): session_shutdown terminates them, a crashed pi
 * leaves them bounded by their deadline via a per-job watchdog that kills the
 * process group when pi dies. killProcessTree-equivalent kills the whole
 * detached process group, so child trees die with the job.
 */

import { spawn } from "node:child_process";
import { guardedCommand } from "./lib/self-mutation-guard.ts";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import type { ExtensionAPI } from "@yunuspi/coding-agent";
import {
	createBashToolDefinition,
	getShellConfig,
} from "@yunuspi/coding-agent";
import { Type } from "typebox";
import { setTimeout as delay } from "node:timers/promises";

/** Foreground grace period used by bounded internal capture helpers. */
const GRACE_MS = 4000;
/** Node setTimeout() upper bound; delays above this clamp to 1ms (see resolveTimeoutMs). */
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
/** Bounded stdout/stderr tail kept per job (a noisy process cannot blow up memory or context). */
const TAIL_CAP = 16 * 1024;
/** SIGTERM -> SIGKILL escalation delay for agent-initiated kills. */
const KILL_TERM_GRACE_MS = 3000;
/** Finished jobs retained for later inspection; oldest finished job is dropped beyond this. */
const MAX_FINISHED_JOBS = 32;
/** Hard bound for live managed helper processes; finished-job retention is a separate limit. */
export const MAX_ACTIVE_JOBS = 8;

type JobState = "running" | "completed" | "failed" | "timed_out" | "killed";

interface Job {
	id: string;
	pid: number | undefined;
	command: string;
	cwd: string;
	state: JobState;
	startedAt: number;
	endedAt?: number;
	/** Absolute deadline (ms epoch) when a timeout was supplied; undefined = no deadline. */
	deadline?: number;
	/** Requested timeout in seconds, when one exists. */
	timeoutSeconds?: number;
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	out: Tail;
	err: Tail;
}

/** Fixed-capacity byte tail: keeps the most recent `cap` bytes per stream. */
class Tail {
	private buf: Buffer = Buffer.alloc(0);
	private readonly cap: number;
	constructor(cap: number) {
		this.cap = cap;
	}
	append(chunk: Buffer) {
		this.buf =
			this.buf.length === 0
				? Buffer.from(chunk)
				: Buffer.concat([this.buf, chunk]);
		if (this.buf.length > this.cap)
			this.buf = this.buf.subarray(this.buf.length - this.cap);
	}
	text(maxBytes = this.cap): string {
		const b =
			this.buf.length <= maxBytes
				? this.buf
				: this.buf.subarray(this.buf.length - maxBytes);
		return b.toString("utf8");
	}
	get bytes(): number {
		return this.buf.length;
	}
}

const jobs = new Map<string, Job>();
let jobSeq = 0;

function newJobId(): string {
	return (
		randomBytes(3).toString("hex") + (++jobSeq % 100).toString().padStart(2, "0")
	);
}

/** WHY: detached POSIX children are session+group leaders, so a negative-pid kill reaps the whole tree (same contract as pi's killProcessTree). */
function killTree(pid: number) {
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			/* already dead */
		}
	}
}

function fmtDuration(ms: number): string {
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	return `${m}m${Math.round(s % 60)}s`;
}

function oneLine(cmd: string, max = 120): string {
	const line = cmd.split("\n")[0].trim();
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

function stateLabel(job: Job): string {
	const elapsed = fmtDuration((job.endedAt ?? Date.now()) - job.startedAt);
	switch (job.state) {
		case "running":
			return `running (${elapsed} elapsed)`;
		case "completed":
			return `completed, exit 0, ran ${elapsed}`;
		case "failed":
			return job.signal
				? `failed, terminated by signal ${job.signal} after ${elapsed}`
				: `failed, exit code ${job.exitCode}, ran ${elapsed}`;
		case "timed_out":
			return `timed out (deadline ${job.timeoutSeconds}s), killed after ${elapsed}`;
		case "killed":
			return `killed by agent after ${elapsed}`;
	}
}

function jobSummary(job: Job): string {
	return `${job.id}  ${job.state.padEnd(10)}  pid ${job.pid ?? "?"}  ${fmtDuration((job.endedAt ?? Date.now()) - job.startedAt)}  ${oneLine(job.command, 80)}`;
}

/** Terminate a running job: SIGTERM the group, escalate to SIGKILL, record `killed`. */
function killJob(job: Job, force: boolean): void {
	if (job.state !== "running" || !job.pid) return;
	job.state = "killed";
	job.endedAt = Date.now();
	if (force) {
		killTree(job.pid);
		return;
	}
	try {
		process.kill(-job.pid, "SIGTERM");
	} catch {
		killTree(job.pid);
		return;
	}
	const pid = job.pid;
	setTimeout(() => {
		if (job.state === "killed" && hasLiveProcess(job)) killTree(pid);
	}, KILL_TERM_GRACE_MS).unref();
}

/** Crash backstop: if pi dies while the job runs, kill the job's process group. Bounded by deadline + 600s so it can never linger forever. */
function spawnWatchdog(job: Job, timeoutSeconds: number): void {
	if (process.platform === "win32") return; // no detached-group contract here; graceful shutdown still applies
	const cap = Math.ceil((timeoutSeconds + 600) / 2);
	const script =
		`n=0; while kill -0 ${process.pid} 2>/dev/null && kill -0 ${job.pid} 2>/dev/null; do ` +
		`sleep 2; n=$((n+1)); [ $n -ge ${cap} ] && exit 0; done; ` +
		`kill -0 ${job.pid} 2>/dev/null && kill -9 -${job.pid} 2>/dev/null; exit 0`;
	try {
		spawn("/bin/bash", ["-c", script], {
			stdio: "ignore",
			detached: true,
			windowsHide: true,
		}).unref();
	} catch {
		/* watchdog is best-effort; graceful shutdown and the in-process deadline still apply */
	}
}

function forgetOldestFinished(): void {
	for (const job of jobs.values()) {
		if (jobs.size <= MAX_FINISHED_JOBS) break;
		// A kill/timeout marks the outcome before the child emits `close`. Keep
		// that entry until its exit code is observed so a live process cannot be
		// evicted and then bypass the active-job bound.
		if (!hasLiveProcess(job)) jobs.delete(job.id);
	}
}

function hasLiveProcess(job: Job): boolean {
	return job.pid !== undefined && job.exitCode === undefined;
}

function activeJobCount(): number {
	let count = 0;
	for (const job of jobs.values()) if (hasLiveProcess(job)) count++;
	return count;
}

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	const timeoutMs = timeout * 1000;
	// WHY parity with pi's resolveTimeoutMs: setTimeout() clamps any delay above
	// 2^31-1 ms down to 1ms, so an un-capped model-supplied timeout would make
	// the deadline fire ~immediately and kill a healthy job. Fail visibly instead.
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

/**
 * Managed replacement for pi's local shell operations. Spawns with the same
 * shell config / env / cwd contract. A finite `graceMs` gives a bounded helper
 * a short foreground period before it detaches; `Infinity` preserves the
 * builtin bash tool's ordinary blocking semantics.
 */
function createManagedBashOperations(graceMs = GRACE_MS, cancelGraceMs = 0) {
	return {
		async exec(command, cwd, { onData, signal, timeout, env }) {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) throw new Error("aborted");
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(
					`Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
				);
			}
			// A stop accepted during cwd admission must not launch a new process.
			if (signal?.aborted) throw new Error("aborted");
			const active = activeJobCount();
			if (active >= MAX_ACTIVE_JOBS) {
				throw new Error(
					`Managed bash active-job limit reached (${String(MAX_ACTIVE_JOBS)}); ` +
					`inspect or stop a helper with process, or use bg_run for explicit background work.`,
				);
			}
			const shellConfig = getShellConfig();
			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const guarded = guardedCommand(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command]);
			const child = spawn(
				guarded.command,
				guarded.args,
				{
					cwd,
					detached: process.platform !== "win32",
					env: env ?? process.env,
					stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
					windowsHide: true,
				},
			);
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}

			const job: Job = {
				id: newJobId(),
				pid: child.pid,
				command,
				cwd,
				state: "running",
				startedAt: Date.now(),
				timeoutSeconds: timeout,
				deadline: timeoutMs === undefined ? undefined : Date.now() + timeoutMs,
				out: new Tail(TAIL_CAP),
				err: new Tail(TAIL_CAP),
			};
			jobs.set(job.id, job);
			forgetOldestFinished(); // WHY: insertion order doubles as recency; keeps the store bounded
			// Internal captures remain foreground longer; start their crash backstop now.
			if (graceMs > GRACE_MS && job.pid && timeout !== undefined)
				spawnWatchdog(job, timeout);

			let detached = false;
			let deadlineTimer: NodeJS.Timeout | undefined;
			let graceTimer: NodeJS.Timeout | undefined;
			let cancelTimer: NodeJS.Timeout | undefined;
			let pendingOutput = 0;
			let outputError: unknown;
			const forward = (data: Buffer) => {
				try {
					const pending = onData(data);
					if (!pending || typeof pending.then !== "function") return;
					pendingOutput++;
					child.stdout?.pause(); child.stderr?.pause();
					Promise.resolve(pending).catch(error => {
						outputError ??= error;
						if (child.pid) killTree(child.pid);
					}).finally(() => {
						if (--pendingOutput === 0) { child.stdout?.resume(); child.stderr?.resume(); }
					});
				} catch (error) { outputError ??= error; if (child.pid) killTree(child.pid); }
			};

			const feed = (data: Buffer) => {
				job.out.append(data);
				forward(data);
			};
			const feedErr = (data: Buffer) => {
				job.err.append(data);
				forward(data);
			};
			child.stdout?.on("data", feed);
			child.stderr?.on("data", feedErr);
			child.stdout?.on("error", () => {});
			child.stderr?.on("error", () => {});

			// WHY single handler, defined out here: the abort listener must be the SAME
			// function that detach()/onExit() remove — a shadowing duplicate would leak
			// one registered listener per bash call until the session signal fires.
			const handleAbort = () => {
				if (detached) return;
				if (child.pid) {
					if (cancelGraceMs > 0) {
						const pid = child.pid;
						try {
							process.kill(-pid, "SIGTERM");
						} catch {
							killTree(pid);
						}
						cancelTimer = setTimeout(() => killTree(pid), cancelGraceMs);
						cancelTimer.unref();
					} else killTree(child.pid);
				}
			};

			const detach = () => {
				detached = true;
				signal?.removeEventListener("abort", handleAbort);
				if (graceMs <= GRACE_MS && job.pid && timeout !== undefined)
					spawnWatchdog(job, timeout);
				const tail = (t: Tail, name: string) => {
					const text = t.text(2048);
					return `${name} (${t.bytes}B kept): ${text ? `\n${text}` : "(none yet)"}`;
				};
					onData(
					Buffer.from(
						`[managed bash] Still running — detached to background after ${fmtDuration(graceMs)} grace.\n` +
							`  job: ${job.id} · pid ${job.pid} · state: running · elapsed ${fmtDuration(Date.now() - job.startedAt)}` +
							(job.timeoutSeconds === undefined
								? " · deadline: none"
								: ` · deadline: ${job.timeoutSeconds}s`) +
							`\n  cmd: ${oneLine(command)}\n  cwd: ${job.cwd}\n` +
							`  ${tail(job.out, "stdout")}\n  ${tail(job.err, "stderr")}\n` +
							`You are in control: use the \`process\` tool (status / output / wait / kill / list) on job ${job.id}. ` +
							`Do not rerun blindly; do not idle. If the command needs interactive stdin, kill it and restructure.`,
					),
				);
			};

			return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
				let settled = false;
				const onExit = (code: number | null, sig: NodeJS.Signals | null) => {
					if (deadlineTimer) clearTimeout(deadlineTimer);
					if (graceTimer) clearTimeout(graceTimer);
					if (cancelTimer) clearTimeout(cancelTimer);
					// One removal for both the foreground and post-detach paths; after the
					// process is done, an abort must never touch a finished job.
					signal?.removeEventListener("abort", handleAbort);
					job.exitCode = code;
					job.signal = sig ?? undefined;
					job.endedAt = job.endedAt ?? Date.now();
					// Only the first finalizer names the state; killers (deadline/kill) pre-set it.
					if (job.state === "running") {
						job.state = code === 0 && !sig ? "completed" : "failed";
					}
					if (detached) return;
					settled = true;
					if (outputError) {
						reject(outputError);
					} else if (job.state === "timed_out") {
						reject(new Error(`timeout:${timeout}`));
					} else if (job.state === "killed") {
						reject(new Error(`Command killed (signal ${sig ?? "unknown"})`));
					} else if (signal?.aborted) {
						reject(new Error("aborted"));
					} else {
						resolve({ exitCode: code });
					}
				};
				if (signal) {
					if (signal.aborted) handleAbort();
					else signal.addEventListener("abort", handleAbort, { once: true });
				}
				child.once("exit", () => {
					// Shell exit is not process-tree completion (e.g. `sleep 600 &`).
					// Kill only its owned POSIX group, then drain pipes before finalizing.
					// Intentional persistent work belongs in bg_run, not an orphaned `&`.
					// Explicit kill/shutdown already owns SIGTERM → SIGKILL escalation;
					// do not cut short a descendant's promised cleanup grace.
					if (
						child.pid &&
						process.platform !== "win32" &&
						job.state !== "killed" &&
						!(signal?.aborted && cancelGraceMs > 0)
					) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							/* group already gone */
						}
					}
				});
				child.once("close", onExit);
				child.once("error", (err) => {
					if (deadlineTimer) clearTimeout(deadlineTimer);
					if (graceTimer) clearTimeout(graceTimer);
					// WHY a failed spawn must not leave a live job: reject AND settle the job
					// so `process list` can't show an unkillable "running" job (no pid, no
					// exit event ever) and `process remove` will accept it.
					if (job.state === "running") {
						job.state = "failed";
						job.endedAt = Date.now();
					}
					signal?.removeEventListener("abort", handleAbort);
					settled = true;
					reject(err);
				});

				if (timeoutMs !== undefined) {
					deadlineTimer = setTimeout(() => {
						if (job.state !== "running") return;
						job.state = "timed_out";
						job.endedAt = Date.now();
						if (child.pid) killTree(child.pid);
					}, timeoutMs);
				}
				// WHY setTimeout not Promise.race: detach has side effects (listener removal, watchdog) and must run exactly once.
				if (Number.isFinite(graceMs)) {
					graceTimer = setTimeout(() => {
						if (settled) return; // exit already won
						detached = true;
						detach();
						// A detached process has not produced a terminal exit code yet.
						// `null` is accepted by the builtin bash contract and prevents a
						// still-running build from being reported as successful.
						resolve({ exitCode: null });
					}, graceMs);
				}
			});
		},
	} satisfies import("@yunuspi/coding-agent").BashOperations;
}

/** Internal bounded helpers share the bash job registry, shutdown and process-tree cleanup. */
export async function runManagedCommand(
	command: string,
	cwd: string,
	timeout: number,
	signal?: AbortSignal,
	foregroundMs = GRACE_MS,
	cancelGraceMs = 0,
) {
	let output = "";
	const result = await createManagedBashOperations(
		foregroundMs,
		cancelGraceMs,
	).exec(command, cwd, {
		timeout,
		signal,
		onData(data) {
			output = (output + data.toString()).slice(-16384);
		},
	});
	return { ...result, output };
}

const processSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("list"),
			Type.Literal("status"),
			Type.Literal("output"),
			Type.Literal("wait"),
			Type.Literal("kill"),
			Type.Literal("remove"),
		],
		{
			description:
				"list: internal managed helper jobs. status: one helper's state. output: tail stdout/stderr. wait: block briefly for exit. kill: terminate (SIGTERM→SIGKILL; force=true skips TERM). remove: forget a finished helper. Explicit bg_run tasks use bg_status/bg_logs/bg_kill.",
		},
	),
	id: Type.Optional(
		Type.String({ description: "Job id (required for everything except list)" }),
	),
	force: Type.Optional(
		Type.Boolean({
			description: "kill: immediate SIGKILL instead of TERM→KILL escalation",
		}),
	),
	seconds: Type.Optional(
		Type.Number({ description: "wait: max seconds to wait (default 5, max 30)" }),
	),
	bytes: Type.Optional(
		Type.Number({
			description: "output: max bytes per stream (default 4096, max 16384)",
		}),
	),
});

function getJob(id: string | undefined): Job {
	if (!id) throw new Error("process: job id required");
	const job = jobs.get(id);
	if (!job)
		throw new Error(`Unknown job: ${id}. Use action "list" for current jobs.`);
	return job;
}

function jobStatusText(job: Job): string {
	const lines = [
		`job ${job.id}: ${stateLabel(job)}`,
		`  cmd: ${oneLine(job.command, 160)}`,
		`  pid: ${job.pid ?? "?"} · cwd: ${job.cwd}`,
	];
	if (job.exitCode !== undefined)
		lines.push(
			`  exit: ${job.exitCode ?? "-"}${job.signal ? ` (signal ${job.signal})` : ""}`,
		);
	if (job.deadline !== undefined) {
		lines.push(
			`  deadline: ${job.timeoutSeconds}s total${job.state === "running" ? ` (${fmtDuration(job.deadline - Date.now())} remaining)` : ""}`,
		);
	}
	return lines.join("\n");
}

function jobDetails(job: Job) {
	return {
		managedJob: {
			id: job.id,
			state: job.state,
			exitCode: job.exitCode ?? null,
			startedAt: job.startedAt,
			endedAt: job.endedAt ?? null,
		},
	};
}

function jobTailText(job: Job, bytes: number, includeStatus = true): string {
	const out = job.out.text(bytes);
	const err = job.err.text(bytes);
	return (
		(includeStatus ? `job ${job.id}: ${stateLabel(job)}\n` : "") +
		`--- stdout (last ${bytes}B of ${job.out.bytes}B kept) ---\n${out || "(empty)"}\n` +
		`--- stderr (last ${bytes}B of ${job.err.bytes}B kept) ---\n${err || "(empty)"}`
	);
}

export default function (pi: ExtensionAPI) {
	// Keep the user-facing builtin bash sequential. Internal bounded helpers
	// call runManagedCommand and intentionally opt into the supervised registry.
	const operations = createManagedBashOperations(Number.POSITIVE_INFINITY);
	const register = (cwd: string) => {
		const def = createBashToolDefinition(cwd, { operations });
		def.description =
			"Execute a bash command in the current working directory with ordinary sequential shell semantics; it waits for the command's terminal result, bounded by `timeout`. For explicit background work use `bg_run` and manage it with bg_status/bg_logs/bg_kill. Internal helper commands such as wait_for may return a supervised managed-job handle for the `process` tool. Stdout+stderr are returned; default last 2000 lines or 50KB. For verbose checks use maxOutputBytes:8192 and outputMode:head-tail. Truncated full output is saved privately; capture failures are explicit.";
		pi.registerTool(def);
	};
	register(process.cwd());
	pi.on("session_start", (_event, ctx) => {
		const cwd = (ctx as { cwd?: unknown }).cwd;
		register(typeof cwd === "string" ? cwd : process.cwd());
	});
	pi.on("session_shutdown", () => {
		for (const job of jobs.values()) {
			if (job.state === "running" && job.pid) {
				job.state = "killed";
				job.endedAt = Date.now();
				try {
					process.kill(-job.pid, "SIGTERM");
				} catch {
					/* gone */
				}
				const pid = job.pid;
				setTimeout(() => {
					if (job.state === "killed" && hasLiveProcess(job)) killTree(pid);
				}, 800).unref();
			}
		}
	});

	pi.registerTool({
		name: "process",
		label: "process",
		description:
			"Manage supervised helper commands created by wait_for or other internal managed-bash captures. These jobs use the process registry; explicit bg_run tasks belong to bg_status/bg_logs/bg_kill and never appear here. Use this tool to inspect, wait for, or terminate a helper instead of rerunning commands blindly.",
		parameters: processSchema,
		async execute(_id, args, signal) {
			signal?.throwIfAborted();
			const { action, id, force, seconds, bytes } = args;
			if (action === "list") {
				const all = [...jobs.values()];
				if (all.length === 0)
					return {
						content: [{ type: "text", text: "No managed jobs." }],
						details: {},
					};
				const running = all.filter((j) => j.state === "running");
				const finished = all.filter((j) => j.state !== "running").reverse();
				const lines = [...running, ...finished].map(jobSummary);
				return {
					content: [{ type: "text", text: `Managed jobs:\n${lines.join("\n")}` }],
					details: {},
				};
			}
			const job = getJob(id);
			switch (action) {
				case "status":
					return {
						content: [{ type: "text", text: jobStatusText(job) }],
						details: jobDetails(job),
					};
				case "output": {
					const limit = Math.min(Math.max(bytes ?? 4096, 1), TAIL_CAP);
					return {
						content: [{ type: "text", text: jobTailText(job, limit) }],
						details: jobDetails(job),
					};
				}
				case "wait": {
					const max = Math.min(Math.max(seconds ?? 5, 0.1), 30);
					const until = Date.now() + max * 1000;
					while (hasLiveProcess(job) && Date.now() < until) {
						await delay(200, undefined, { signal: signal ?? undefined });
					}
					const live = hasLiveProcess(job);
					return {
						content: [
							{
								type: "text",
								text:
									live
										? `${jobStatusText(job)}\nStill running — use output to inspect progress or kill to stop it.`
										: `${jobStatusText(job)}\n--- tail ---\n${jobTailText(job, 4096, false)}`,
							},
						],
						details: jobDetails(job),
					};
				}
				case "kill": {
					if (job.state !== "running")
						return {
							content: [
								{ type: "text", text: `Job ${job.id} already finished: ${job.state}.` },
							],
							details: {},
						};
					killJob(job, force === true);
					// WHY wait on exitCode, not `job.state === "killed"`: killJob mutates
					// state through a call TS control flow can't see through, so the state
					// comparison was a false TS2367. exitCode is the actual "process exited"
					// signal we're polling for; runtime behavior is unchanged.
					const until = Date.now() + 2000;
					while (job.exitCode === undefined && Date.now() < until) {
						await delay(100, undefined, { signal: signal ?? undefined });
					}
					return {
						content: [{ type: "text", text: jobStatusText(job) }],
						details: {},
					};
				}
				case "remove": {
					if (hasLiveProcess(job))
						throw new Error(`Job ${job.id} is still live — wait for its process to exit before removing it.`);
					jobs.delete(job.id);
					return {
						content: [
							{
								type: "text",
								text: `Removed job ${job.id} (${job.state}, exit ${job.exitCode ?? "-"}).`,
							},
						],
						details: {},
					};
				}
				default:
					throw new Error(`process: unknown action "${action as string}"`);
			}
		},
	});
}
