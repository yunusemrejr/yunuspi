import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterventionSession } from "../intervention-session.js";
import { claimsCompletion, fingerprintFailureResult, fingerprintToolCall, hasExplicitRetryDirective, isMutationCall, isVerificationCall, makeRepeatedFailureFeatures, safeToolShape } from "./guardian-features.js";
import { getGuardianKernelRuntime } from "./guardian-kernels.js";

export const GUARDIAN_REQUEST_META = Symbol.for("yunuspi.guardian.request-meta.v1");
const MAX_TASKS = 64;
// Long user requests must not silently disable all tool supervision. Retain
// complete prompts within this bound; larger inputs still get observation
// receipts and chunked retry checks, without manufacturing constraint authority.
const MAX_RAW_PROMPT = 131_072;
const MAX_ATTEMPTS = 8;
const MAX_INTERVENTION_HISTORY = 32;
const MAX_PATH_EVIDENCE_AGE_MS = 120_000;
const MAX_RELAY_BYTES = 16 * 1024;
const CHILD_ACK_TIMEOUT_MS = 3_000;
const MAX_FILE_TYPES = 12;
const MAX_SKILLS = 8;
/** Supervisory cadence: one admitted intervention per category per window, and
 * a bounded number of candidate evaluations, counted from event timestamps.
 * There is no timer and no polling loop; the window only advances when a real
 * candidate is evaluated. */
const SUPERVISORY_WINDOW_MS = 120_000;
const MAX_WINDOW_EVALUATIONS = 16;
/** Deterministic loop detectors: evidence counts that justify one reminder. */
const EDIT_MISMATCH_THRESHOLD = 3;
const READ_CHURN_THRESHOLD = 4;
const CONSECUTIVE_FAILURE_THRESHOLD = 4;
const MAX_TRACKED_PATHS = 64;
// A resumed session ID identifies a transcript, not an in-process owner. More
// than one SDK runtime can open that transcript simultaneously.
const liveGuardianSessions = new Map();
const guardianSessionOwners = new WeakMap();

export function guardianOwnerForSession(sessionId, sessionOwner) {
	const id = sessionText(sessionId);
	const owners = sessionOwner && typeof sessionOwner === "object"
		? guardianSessionOwners.get(sessionOwner)?.get(id)
		: liveGuardianSessions.get(id);
	return owners?.size === 1 ? owners.values().next().value : undefined;
}

export function tagGuardianRequestMessage(message, metadata) {
	try { Object.defineProperty(message, GUARDIAN_REQUEST_META, { value: Object.freeze({ ...metadata }), enumerable: false, configurable: true }); }
	catch { /* best effort: untaggable messages are outside Guardian provenance */ }
	return message;
}

export function guardianRequestMessages(messages) {
	const result = [];
	for (let index = 0; index < (Array.isArray(messages) ? messages.length : 0); index++) {
		const metadata = messages[index]?.[GUARDIAN_REQUEST_META];
		if (metadata?.requestId) result.push({ requestId: metadata.requestId, turnId: metadata.turnId, messageIndex: index });
	}
	return result;
}

function sha256(text) { return createHash("sha256").update(text, "utf8").digest("hex"); }
function safeId(value) { return typeof value === "string" && value.length <= 256 && /^[A-Za-z0-9._:-]+$/.test(value); }
function sessionText(sessionId) { return String(sessionId ?? "").slice(0, 256); }
function clauseAt(text, start, end) {
	let left = start;
	const boundary = (index) => /[!?\n\r]/.test(text[index]) || text[index] === "." && (index + 1 === text.length || /\s/.test(text[index + 1]));
	while (left > 0 && !boundary(left - 1)) left--;
	let right = end;
	while (right < text.length && !boundary(right)) right++;
	return text.slice(left, right);
}
function hasAmbiguousPolarity(text) {
	return /\b(?:unless|except|if|when|provided that|assuming|for example|e\.g\.|hypothetical|imagine|quoted example)\b/i.test(text);
}
function isSpanQuoted(text, start, end) {
	const before = text.slice(0, start);
	let fence;
	for (const line of before.split(/\r?\n/)) {
		const marker = line.match(/^\s*(```+|~~~+)/)?.[1];
		if (!marker) continue;
		if (!fence) fence = marker[0];
		else if (fence === marker[0]) fence = undefined;
	}
	if (fence) return true;
	const lineStart = text.lastIndexOf("\n", start - 1) + 1;
	if (/^\s*>/.test(text.slice(lineStart, end))) return true;
	const span = text.slice(start, end);
	if (/^[`"“‘].*[`"”’]$/.test(span)) return true;
	const quotePairs = [["\"", "\""], ["“", "”"], ["‘", "’"], ["`", "`"]];
	for (const [open, close] of quotePairs) {
		let inside = false;
		for (let index = 0; index < start; index++) {
			if (text[index] === open && (open !== close || !inside)) inside = true;
			else if (text[index] === close && inside) inside = false;
		}
		if (inside) return true;
	}
	// ASCII apostrophes in contractions are not quote boundaries.
	let apostropheOpen = false;
	for (let index = 0; index < start; index++) {
		if (text[index] !== "'") continue;
		if (/\w/.test(text[index - 1] ?? "") && /\w/.test(text[index + 1] ?? "")) continue;
		apostropheOpen = !apostropheOpen;
	}
	if (apostropheOpen) return true;
	return false;
}
function constraintSemantics(text, clause) {
	if (hasAmbiguousPolarity(clause) || /\b(?:do not|don't|never|must not|should not|no longer|not required)\b/i.test(clause)) return undefined;
	if (/\b(?:said|says|previously|used to|example|hypothetical)\b/i.test(clause)) return undefined;
	const fileScope = text.match(/\bonly\s+(?:write|edit|create|modify)\s+files?\s+under\s+([A-Za-z0-9_./-]+)/i)
		?? text.match(/\bkeep\s+(?:all\s+)?(?:writes|edits|changes)\s+under\s+([A-Za-z0-9_./-]+)/i);
	if (fileScope) {
		const tail = clause.slice(clause.toLowerCase().indexOf(fileScope[0].toLowerCase()) + fileScope[0].length);
		if (/^\s*(?:and|or|[,;])\s*/i.test(tail)) return undefined;
		return { key: "file-scope", value: fileScope[1].replace(/\/$/, ""), polarity: "positive" };
	}
	const choice = text.match(/\b(?:use|choose|select)\s+([A-Za-z0-9_.+-]+)(?:\s+for\s+([A-Za-z0-9_. -]+))?/i);
	if (choice && !/\b(?:do not|don't|never|must not|should not|avoid)\b/i.test(clause)) return { key: choice[2] ? `choice:${choice[2].trim().toLowerCase()}` : "tool-choice", value: choice[1].toLowerCase(), polarity: "positive" };
	return undefined;
}
function isReferentialFollowup(text) {
	return /\b(?:continue|status|update|what remains|how is|finish|same task|that task|this task|previous|earlier|also|additionally|instead|actually|correct|replace)\b/i.test(text);
}

function canonicalPathForEvidence(cwd, value) {
	if (typeof value !== "string" || !value || value.length > 1024 || value.includes("\0")) return undefined;
	try {
		const project = realpathSync(cwd);
		const candidate = resolve(project, value);
		try { return realpathSync(candidate); }
		catch {
			const parent = realpathSync(dirname(candidate));
			return resolve(parent, basename(candidate));
		}
	} catch { return undefined; }
}

function isWithinPath(root, target) {
	const pathFromRoot = relative(root, target);
	return pathFromRoot === "" || pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(pathFromRoot);
}

function stableConstraintId(item) { return `constraint:${sha256(`${item.originTaskId}:${item.start}:${item.text}`)}`; }

function readChildMetadata() {
	const env = process.env;
	const channelDir = env.PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR?.trim();
	const runId = env.PI_SUBAGENT_RUN_ID?.trim();
	const agent = env.PI_SUBAGENT_CHILD_AGENT?.trim();
	const childIndexText = env.PI_SUBAGENT_CHILD_INDEX?.trim();
	const orchestratorSessionId = env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID?.trim();
	if (!channelDir || !runId || !agent || !orchestratorSessionId || !/^\d+$/.test(childIndexText ?? "") || !isAbsolute(channelDir)) return undefined;
	return { channelDir, runId, agent, childIndex: Number(childIndexText), orchestratorSessionId };
}

function createAtomicRelay(reason, message) {
	const meta = readChildMetadata();
	if (!meta || typeof message !== "string" || !message.trim() || Buffer.byteLength(message, "utf8") > MAX_RELAY_BYTES) return undefined;
	try {
		const requests = join(meta.channelDir, "requests");
		mkdirSync(requests, { recursive: true, mode: 0o700 });
		mkdirSync(join(meta.channelDir, "replies"), { recursive: true, mode: 0o700 });
		const id = randomUUID();
		const createdAt = Date.now();
		const record = {
			type: "subagent.supervisor.request", id, createdAt, expiresAt: createdAt + CHILD_ACK_TIMEOUT_MS, reason,
			message: message.trim(), expectsReply: false, runId: meta.runId, agent: meta.agent,
			childIndex: meta.childIndex, orchestratorSessionId: meta.orchestratorSessionId,
		};
		const target = join(requests, `${id}.json`);
		const temporary = join(requests, `.${id}.${process.pid}.tmp`);
		writeFileSync(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600, flag: "wx" });
		renameSync(temporary, target);
		return { id, channelDir: meta.channelDir, expiresAt: record.expiresAt };
	} catch { return undefined; }
}

function atomicRelay(reason, message) { return Boolean(createAtomicRelay(reason, message)); }

async function waitForRelayVisibility(relay, { timeoutMs = CHILD_ACK_TIMEOUT_MS, stillCurrent = () => true } = {}) {
	if (!relay?.id || !relay.channelDir) return false;
	const deadline = Math.min(relay.expiresAt ?? Date.now() + timeoutMs, Date.now() + timeoutMs);
	const file = join(relay.channelDir, "replies", `${relay.id}.json`);
	while (Date.now() <= deadline) {
		if (!stillCurrent()) return false;
		try {
			const reply = JSON.parse(readFileSync(file, "utf8"));
			if (reply?.type === "subagent.supervisor.reply" && reply.requestId === relay.id && reply.message === "displayed") {
				try { rmSync(file, { force: true }); } catch { /* best-effort ack cleanup */ }
				return true;
			}
		} catch { /* parent UI has not acknowledged this bounded request yet */ }
		if (Date.now() >= deadline) break;
		await new Promise((resolve) => setTimeout(resolve, 40));
	}
	return false;
}

const ALLOWED_INTELLIGENCE = new Set(["JEV", "Needle3", "FuzzyML", "Kompress", "Local LM", "retrieval", "Neural ranker", "Intent classifier", "WASM source check", "Deterministic selection"]);
export function relayIntelligenceUsageFromChild(input) {
	if (!input || !ALLOWED_INTELLIGENCE.has(input.name) || typeof input.sessionId !== "string" || !liveGuardianSessions.get(input.sessionId)?.has(input.ownerId)) return false;
	const stages = { result: "result ready", cached: "cached result ready", applied: "result applied", delivered: "added to model context", returned: "returned exact excerpts", skipped: "selection unused" };
	const sources = { remote: "remote", local: "local", wasm: "local WASM" };
	const stage = Object.hasOwn(stages, input.stage) ? stages[input.stage] : "result applied";
	const source = Object.hasOwn(sources, input.source) ? sources[input.source] : undefined;
	const details = [source, stage];
	if (Number.isSafeInteger(input.count) && input.count > 1 && input.count <= 4096) details.push(`${input.count} completions`);
	if (typeof input.durationMs === "number" && Number.isFinite(input.durationMs) && input.durationMs >= 0 && input.durationMs <= 3_600_000) details.push(`${Math.round(input.durationMs)}ms`);
	if ((input.stage === "delivered" || input.stage === "returned") && Number.isSafeInteger(input.savedChars) && input.savedChars >= 0 && input.savedChars <= 1_000_000_000) details.push(`${input.savedChars} characters ${input.stage === "returned" ? "omitted" : "saved"}`);
	return atomicRelay("intelligence_used", `Internal intelligence · ${input.name} · ${details.filter(Boolean).join(" · ")}.`);
}

export class GuardianSupervisor {
	constructor({ sessionId, sessionOwner, processId = String(process.pid), cwd = process.cwd(), emit, observe, clock = Date.now, childRelay = createAtomicRelay, awaitParentVisibility = waitForRelayVisibility } = {}) {
		this.sessionId = sessionText(sessionId);
		this.ownerId = randomUUID();
		const owners = liveGuardianSessions.get(this.sessionId) ?? new Set();
		owners.add(this.ownerId);
		liveGuardianSessions.set(this.sessionId, owners);
		this._sessionOwner = sessionOwner && typeof sessionOwner === "object" ? sessionOwner : undefined;
		if (this._sessionOwner) {
			const sessions = guardianSessionOwners.get(this._sessionOwner) ?? new Map();
			const scopedOwners = sessions.get(this.sessionId) ?? new Set();
			scopedOwners.add(this.ownerId);
			sessions.set(this.sessionId, scopedOwners);
			guardianSessionOwners.set(this._sessionOwner, sessions);
		}
		this.processId = String(processId);
		this.cwd = cwd;
		this._emit = typeof emit === "function" ? emit : () => {};
		this._observe = typeof observe === "function" ? observe : () => {};
		this._clock = clock;
		this._childRelay = childRelay;
		this._awaitParentVisibility = awaitParentVisibility;
		this._enabled = true;
		this._debug = false;
		this._disposed = false;
		this._quarantined = false;
		this._quarantineReason = undefined;
		this._arbiter = createInterventionSession({ journalLimit: 128, clock });
		this._arbiterCycleId = undefined;
		this._tasks = new Map();
		this._activeTaskId = undefined;
		this._latestAcceptedTaskId = undefined;
		this._inFlight = new Map();
		this._peerReceipts = new Set();
		this._stats = { observed: 0, toolResults: 0, classifierEvaluations: 0, similarityEvaluations: 0, candidates: 0, admitted: 0, abstained: 0, quarantined: 0, constraintCandidates: 0, constraintRejected: 0, suppressedWindow: 0, suppressedHistory: 0, peerMessagesSent: 0, peerMessagesReceived: 0, editLoopCandidates: 0, readChurnCandidates: 0, completionCandidates: 0, burstCandidates: 0, verifications: 0, mutations: 0 };
		this._admittedAtByKind = new Map();
		this._window = { startedAt: this._clock(), evaluations: 0 };
		this._kernelPromise = undefined;
		this._kernelRuntime = undefined;
		this._kernelError = undefined;
		this._stateGeneration = 0;
	}

	get enabled() { return this._enabled; }
	get debug() { return this._debug; }

	/** Peer communication is diagnostic evidence, never user instruction,
	 * constraint authority, a new task, or a reason to mutate another session. */
	observePeerMessage(event) {
		if (!this._enabled || this._disposed || this._quarantined || !this._handle(this.sessionId)
			|| event?.sessionId !== this.sessionId || event.cwd !== this.cwd
			|| !["sent", "received"].includes(event.direction) || !safeId(event.messageId)
			|| !safeId(event.peerSessionId) || event.peerSessionId === this.sessionId) return false;
		const key = `${event.direction}:${event.messageId}`;
		if (this._peerReceipts.has(key)) return false;
		this._peerReceipts.add(key);
		while (this._peerReceipts.size > 128) this._peerReceipts.delete(this._peerReceipts.values().next().value);
		const counter = event.direction === "sent" ? "peerMessagesSent" : "peerMessagesReceived";
		this._stats[counter] = (this._stats[counter] ?? 0) + 1;
		return true;
	}

	_notifyObservation(evaluationsBefore) {
		try {
			const states = this._kernelRuntime ? Object.values(this._kernelRuntime.status()) : [];
			const decision = this._kernelError || states.some(({ state }) => state === "quarantined") ? "quarantined"
				: states.length ? "ready" : this._kernelPromise ? "initializing" : "lazy";
			const result = this._observe({ guardianInstanceId: this.ownerId, stats: { ...this._stats }, count: this._stats.toolResults, evaluations: this._stats.classifierEvaluations,
				similarityEvaluations: this._stats.similarityEvaluations, decision,
				promptCoverage: typeof this._tasks.get(this._activeTaskId)?.rawPrompt === "string" ? "complete" : "bounded-out",
				outcome: this._stats.classifierEvaluations > evaluationsBefore ? "evaluated" : "observed" });
			if (result?.then) void Promise.resolve(result).catch(() => {});
		} catch { /* display-only activity cannot affect supervision */ }
	}

	_handle(sessionId) {
		if (this._disposed || sessionText(sessionId) !== this.sessionId || !liveGuardianSessions.get(this.sessionId)?.has(this.ownerId)) return undefined;
		return true;
	}

	/** The arbitration plane keys every intent to a cycle it issued itself
	 * (beginRequest returns that id). Submitting a raw task id would be an
	 * unknown cycle and every intent would be rejected as invalid. */
	_arbiterRequestId() {
		const cycle = this._arbiterCycleId ?? this._arbiter.control().currentCycle();
		return typeof cycle === "string" && cycle.length ? cycle : undefined;
	}

	/** Bounded supervisory window. Returns false when this candidate must not be
	 * evaluated at all (window budget exhausted) or when the same category was
	 * already admitted inside the current window. */
	_windowAllows(kind) {
		const now = this._clock();
		if (now - this._window.startedAt >= SUPERVISORY_WINDOW_MS) this._window = { startedAt: now, evaluations: 0 };
		if (this._window.evaluations >= MAX_WINDOW_EVALUATIONS) return false;
		const last = this._admittedAtByKind.get(kind);
		if (typeof last === "number" && now - last < SUPERVISORY_WINDOW_MS) return false;
		this._window.evaluations++;
		return true;
	}

	_admitWindow(kind) { this._admittedAtByKind.set(kind, this._clock()); }

	/** Bounded observation of the files a task touches and the skills it reads.
	 * Diagnostic evidence only: neither value changes a decision on its own. */
	_noteTouchedPath(task, toolName, value) {
		const name = basename(value);
		if (/^SKILL\.md$/i.test(name) || toolName === "skill") {
			const skill = basename(dirname(value)).slice(0, 64);
			if (skill && skill !== "." && skill !== "/") {
				if (!task.skills) task.skills = new Set();
				if (task.skills.size < MAX_SKILLS) task.skills.add(skill);
			}
		}
		const dot = name.lastIndexOf(".");
		if (dot <= 0 || dot === name.length - 1) return;
		const extension = name.slice(dot + 1).toLowerCase();
		if (!/^[a-z0-9]{1,12}$/.test(extension)) return;
		if (!task.fileTypes) task.fileTypes = new Map();
		if (task.fileTypes.size >= MAX_FILE_TYPES && !task.fileTypes.has(extension)) return;
		task.fileTypes.set(extension, (task.fileTypes.get(extension) ?? 0) + 1);
	}

	_observedSignals(task = this._tasks.get(this._activeTaskId)) {
		if (!task) return undefined;
		const fileTypes = [...(task.fileTypes ?? new Map()).entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
			.slice(0, 6)
			.map(([extension, count]) => `${extension}:${count}`);
		const skills = [...(task.skills ?? [])].slice(0, 6);
		return { fileTypes, skills, toolCalls: task.toolCount };
	}

	beginRequest({ requestId, turnId = requestId, sessionId = this.sessionId, source = "rpc", originalText = "" } = {}) {
		if (!this._handle(sessionId) || !safeId(requestId) || typeof originalText !== "string") return undefined;
		// Extension-generated messages keep their explicit provenance but never
		// become authoritative Guardian tasks or replace the current user lineage.
		if (source === "extension") return { requestId, turnId, sessionId: this.sessionId, processId: this.processId, guardianOwnerId: this.ownerId };
		let task = this._tasks.get(requestId);
		if (!task) {
			const parentTaskId = this._latestAcceptedTaskId ?? this._activeTaskId;
			const rawPrompt = originalText.length <= MAX_RAW_PROMPT ? originalText : undefined;
			task = { requestId, turnId, parentTaskId, lineageIds: [requestId], source, openedAt: this._clock(), rawPromptHash: rawPrompt === undefined ? undefined : sha256(rawPrompt), rawPrompt, taskLabel: "", relation: undefined, analysisConfidence: 0, constraints: [], effectiveConstraints: [], attempts: [], episodeKey: undefined, responseEpoch: 0, evidenceVersion: 0, constraintEvidence: new Map(), emittedConstraintIds: new Set(), emittedFailureKeys: new Set(), toolCount: 0, fileTypes: new Map(), skills: new Set(), editFailures: new Map(), reads: new Map(), consecutiveFailures: 0, burstErrors: [], burstPrints: [], mutationVersion: 0, verifiedVersion: 0, verificationEpoch: 0, pendingChecks: new Map(), completionChecked: false };
			task.retryDirective = hasExplicitRetryDirective(originalText);
			this._tasks.set(requestId, task);
			while (this._tasks.size > MAX_TASKS) {
				const removedId = [...this._tasks.keys()].find((id) => id !== this._activeTaskId && id !== this._latestAcceptedTaskId && id !== requestId);
				if (!removedId) break;
				this._tasks.delete(removedId);
				if (this._latestAcceptedTaskId === removedId) this._latestAcceptedTaskId = this._activeTaskId;
			}
		}
		return { requestId, turnId, sessionId: this.sessionId, processId: this.processId, guardianOwnerId: this.ownerId };
	}

	noteInput(meta) { return this.beginRequest(meta); }

	acceptRequest(requestId) {
		const task = this._tasks.get(requestId);
		if (!task || !this._handle(this.sessionId)) return false;
		task.acceptedAt = this._clock();
		this._latestAcceptedTaskId = requestId;
		return true;
	}

	cancelRequest(requestId) {
		const task = this._tasks.get(requestId);
		if (!task || this._activeTaskId === requestId) return false;
		this._tasks.delete(requestId);
		this._inFlight.forEach((call, key) => { if (call.taskId === requestId) this._inFlight.delete(key); });
		if (this._latestAcceptedTaskId === requestId) this._latestAcceptedTaskId = task.parentTaskId && this._tasks.has(task.parentTaskId) ? task.parentTaskId : this._activeTaskId;
		return true;
	}

	observePromptAnalysis(event) {
		// Turning guardians off must stop analysis, not just hide its output.
		if (!this._enabled || this._disposed || this._quarantined) return false;
		if (event?.guardianOwnerId !== undefined && event.guardianOwnerId !== this.ownerId || event?.guardianOwnerId === undefined && (liveGuardianSessions.get(this.sessionId)?.size ?? 0) > 1) return false;
		if (!event || event.version !== 1 || event.processId !== this.processId || event.sessionId !== this.sessionId || !safeId(event.requestId) || event.turnId !== event.requestId || !this._handle(event.sessionId)) return false;
		const task = this._tasks.get(event.requestId);
		const originalText = task?.rawPrompt;
		if (!task || task.source !== "interactive" && task.source !== "rpc") return false;
		if (event.inputSource !== undefined && event.inputSource !== task.source) return false;
		if (typeof originalText !== "string" || originalText.length > MAX_RAW_PROMPT || event.promptHash !== sha256(originalText)) return false;
		if (task.rawPromptHash !== event.promptHash) return false;
		if (event.analysisSource !== "model" || typeof event.confidence !== "number" || !Number.isFinite(event.confidence) || event.confidence < 0.8 || event.confidence > 1) return false;
		const constraints = Array.isArray(event.explicitConstraints) ? event.explicitConstraints.slice(0, 32) : [];
		const accepted = [];
		for (const item of constraints) {
			if (!item || item.source !== "literal-user" || item.quoted !== false || typeof item.text !== "string" || !Number.isInteger(item.start) || !Number.isInteger(item.end) || item.start < 0 || item.end <= item.start || item.end > originalText.length) { this._stats.constraintRejected++; continue; }
			if (originalText.slice(item.start, item.end) !== item.text) { this._stats.constraintRejected++; continue; }
			const clause = clauseAt(originalText, item.start, item.end);
			if (hasAmbiguousPolarity(clause) || isSpanQuoted(originalText, item.start, item.end)) { this._stats.constraintRejected++; continue; }
			const semantics = constraintSemantics(item.text, clause);
			if (!semantics) { this._stats.constraintRejected++; continue; }
			accepted.push({ text: item.text, start: item.start, end: item.end, clause, ...semantics, originTaskId: task.requestId });
		}
		const relation = typeof event.relation === "string" ? event.relation : undefined;
		const parent = task.parentTaskId ? this._tasks.get(task.parentTaskId) : undefined;
		const lexicalFollowup = isReferentialFollowup(originalText);
		const explicitReset = /\b(?:new task|separate task|unrelated|switching topics|ignore (?:the )?(?:previous|earlier) task|start over|forget (?:the )?(?:previous|earlier) task|cancel(?:led)?(?: (?:the|that|this|previous|earlier))? (?:task|work)|(?:older|previous|earlier|another) session)\b/i.test(originalText);
		// The model relation is advisory. It may describe chronology, but cannot
		// by itself cut or join an authoritative user task lineage.
		const mayInherit = Boolean(parent && !explicitReset && lexicalFollowup);
		let inherited = mayInherit ? [...(parent.effectiveConstraints ?? parent.constraints ?? [])] : [];
		// New literal instructions supersede older values of the same key even
		// when the advisory model mislabels the follow-up relation.
		if (accepted.length) {
			const correctedKeys = new Set(accepted.map((item) => item.key));
			inherited = inherited.filter((item) => !correctedKeys.has(item.key));
		}
		const conflictingKeys = new Set(accepted.filter((item) => accepted.some((other) => other.key === item.key && other.value !== item.value)).map((item) => item.key));
		const byIdentity = new Map();
		for (const item of [...inherited, ...accepted].filter((item) => !conflictingKeys.has(item.key))) byIdentity.set(stableConstraintId(item), item);
		task.constraints = accepted;
		task.effectiveConstraints = [...byIdentity.values()].slice(-32);
		task.evidenceVersion++;
		task.lineageIds = [...new Set([task.requestId, ...(mayInherit ? parent.lineageIds ?? [parent.requestId] : [])])].slice(0, 16);
		task.relation = relation;
		task.analysisConfidence = event.confidence;
		task.taskLabel = typeof event.taskLabel === "string" ? event.taskLabel.slice(0, 180) : "";
		return true;
	}

	_handleTaskMeta(message) {
		const meta = message?.[GUARDIAN_REQUEST_META];
		if (meta?.guardianOwnerId !== undefined && meta.guardianOwnerId !== this.ownerId || meta?.guardianOwnerId === undefined && (liveGuardianSessions.get(this.sessionId)?.size ?? 0) > 1) return undefined;
		if (!meta || meta.sessionId !== this.sessionId || meta.processId !== this.processId || !this._tasks.has(meta.requestId)) return undefined;
		if (this._activeTaskId !== meta.requestId) {
			this._stateGeneration++;
			this._arbiterCycleId = this._arbiter.beginRequest(meta.requestId);
		}
		this._activeTaskId = meta.requestId;
		this._latestAcceptedTaskId = meta.requestId;
		return this._tasks.get(meta.requestId);
	}

	async observeAgentEvent(event) {
		if (this._disposed || this._quarantined || !this._handle(this.sessionId) || !event || typeof event.type !== "string") return;
		if (!this._enabled) {
			if (event.type === "message_start" && event.message?.role === "user") this._handleTaskMeta(event.message);
			return;
		}
		this._stats.observed++;
		if (event.type === "message_start" && event.message?.role === "user") {
			this._handleTaskMeta(event.message);
			return;
		}
		const task = this._tasks.get(this._activeTaskId);
		if (!task) return;
		if (event.type === "message_end" && event.message?.role === "custom" && event.message.customType === "background-task-notification") {
			this._completeBackgroundCheck(task, event.message.details);
			return;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			task.responseEpoch++;
			for (const attempt of task.attempts) if (!attempt.responseSeen && attempt.responseEpoch < task.responseEpoch) attempt.responseSeen = true;
			await this._considerUnverifiedCompletion(task, event.message);
			return;
		}
		if (event.type === "tool_execution_start") {
			task.evidenceVersion++;
			const toolName = typeof event.toolName === "string" ? event.toolName : "";
			const fingerprint = fingerprintToolCall(toolName, event.args);
			const shape = safeToolShape(toolName, event.args);
			const key = fingerprint ? `${toolName}:${fingerprint}` : undefined;
			if (!key || !shape) {
				task.episodeKey = undefined;
				task.attempts = [];
			} else if (task.episodeKey && task.episodeKey !== key) {
				// Any different action, including a successful edit or a verification run,
				// invalidates this repetition episode.
				task.attempts = [];
			}
			task.episodeKey = key;
			task.toolCount++;
			const verification = isVerificationCall(toolName, event.args);
			if (verification) { task.verifiedVersion = -1; task.verificationEpoch++; }
			const rawPath = typeof event.args?.path === "string" && event.args.path.length <= 1024 ? event.args.path : undefined;
			if (rawPath) this._noteTouchedPath(task, toolName, rawPath);
			const candidatePath = (toolName === "write" || toolName === "edit") && rawPath ? rawPath : undefined;
			const readKey = toolName === "read" && rawPath ? `${rawPath}|${Number(event.args?.offset) || 0}|${Number(event.args?.limit) || 0}` : undefined;
			this._inFlight.set(event.toolCallId ?? "active", { toolName, fingerprint, shape, taskId: task.requestId, responseEpoch: task.responseEpoch, at: this._clock(), candidatePath, rawPath, readKey,
				mutation: isMutationCall(toolName, event.args), verification, verificationEpoch: task.verificationEpoch,
				verificationVersion: task.mutationVersion, verificationEligible: ![...this._inFlight.values()].some(call => call.taskId === task.requestId && call.mutation) });
			while (this._inFlight.size > 64) this._inFlight.delete(this._inFlight.keys().next().value);
			return;
		}
		if (event.type === "tool_execution_end") {
			const key = event.toolCallId ?? "active";
			const call = this._inFlight.get(key);
			this._inFlight.delete(key);
			if (!call || call.taskId !== task.requestId) return;
			const generation = this._stateGeneration, evaluationsBefore = this._stats.classifierEvaluations;
			this._stats.toolResults++;
			try {
				const errorHash = fingerprintFailureResult(event.result, event.isError);
				await this._trackWorkingPattern(task, call, event, errorHash);
				if (!event.isError || !errorHash || !call.fingerprint || !call.shape) {
					task.evidenceVersion++;
					task.attempts = [];
					task.episodeKey = undefined;
					if (!event.isError) await this.analyzeToolActivity({ taskId: call.taskId, toolName: call.toolName, args: call.candidatePath ? { path: call.candidatePath } : undefined, toolCallId: event.toolCallId, succeeded: true });
					return;
				}
				task.evidenceVersion++;
				const attempt = { toolName: call.toolName, fingerprint: call.fingerprint, shape: call.shape, errorHash, typedFailure: true, failed: true, responseEpoch: call.responseEpoch, responseSeen: false, at: this._clock(), taskId: task.requestId };
				if (task.attempts.some((prior) => prior.fingerprint !== attempt.fingerprint || prior.errorHash !== attempt.errorHash || prior.toolName !== attempt.toolName)) task.attempts = [];
				task.attempts.push(attempt);
				if (task.attempts.length > MAX_ATTEMPTS) task.attempts.shift();
				await this._considerRepeatedFailure(task, event);
			} finally {
				if (this._enabled && !this._disposed && !this._quarantined && generation === this._stateGeneration && this._tasks.get(this._activeTaskId) === task)
					this._notifyObservation(evaluationsBefore);
			}
		}
	}

	async _considerRepeatedFailure(task, event) {
		const attempts = task.attempts.slice();
		const evidenceVersion = task.evidenceVersion;
		if (!this._enabled || attempts.length < 3 || attempts.slice(-3).filter((attempt) => attempt.responseSeen).length < 2) return;
		const dedupeKey = `repeated-failure:${sha256(`${task.requestId}:${attempts.at(-1).fingerprint}:${attempts.at(-1).errorHash}`)}`;
		if (task.emittedFailureKeys.has(dedupeKey)) { this._stats.suppressedHistory++; return; }
		const generation = this._stateGeneration;
		this._stats.candidates++;
		if (!this._windowAllows("repeated-identical-failure")) { this._stats.suppressedWindow++; return; }
		if (!this._kernelPromise) this._kernelPromise = getGuardianKernelRuntime();
		let runtime;
		try { runtime = await this._kernelPromise; this._kernelRuntime = runtime; } catch (error) { this._kernelError = error instanceof Error ? error.message : String(error); this._stats.quarantined++; return; }
		if (!this._enabled || this._disposed || this._activeTaskId !== task.requestId || this._tasks.get(task.requestId) !== task || generation !== this._stateGeneration || task.evidenceVersion !== evidenceVersion) { this._stats.abstained++; return; }
		const status = runtime.status().classifier;
		if (status.state !== "ready") { this._stats.quarantined++; return; }
		const similarity = runtime.similarity(attempts.at(-2).shape, attempts.at(-1).shape);
		if (similarity === undefined) { this._stats.quarantined++; return; }
		this._stats.similarityEvaluations++;
		const scored = runtime.evaluate(makeRepeatedFailureFeatures({ priorAttempts: attempts.slice(-3), shapeSimilarity: similarity, activeTaskId: task.requestId, now: this._clock(), userRetryDirective: task.retryDirective }));
		if (!scored) { this._stats.abstained++; return; }
		this._stats.classifierEvaluations++;
		if (scored.probability < scored.threshold) { this._stats.abstained++; this._notifyDecision("repeated-identical-failure", "abstained", { score: scored.probability / 10000, threshold: scored.threshold / 10000, tool: attempts.at(-1).toolName }); return; }
		const evidence = attempts.slice(-3).map((attempt, index) => ({ kind: "tool-failure", id: `${task.requestId}:${task.toolCount - 2 + index}`, hash: attempt.errorHash }));
		const content = "The same tool operation failed repeatedly with the same result. Verify the cause before retrying it.";
		const arbiterRequestId = this._arbiterRequestId();
		if (!arbiterRequestId) { this._stats.abstained++; return; }
		const decision = this._arbiter.enforce({
			source: "guardian-intelligence", requestId: arbiterRequestId, category: "guidance", priority: 70,
			reason: "Repeated identical tool operation returned the same typed failure across independent assistant responses.",
			stabilityKey: dedupeKey,
			contentHash: sha256(content), ttlMs: 30_000, estimatedChars: content.length, estimatedCost: 0, blocking: false,
			slot: `guardian:${sha256(dedupeKey).slice(0, 32)}`, evidence,
		});
		if (decision.outcome !== "admitted") { this._stats.abstained++; return; }
		const childMetadata = readChildMetadata();
		const child = Boolean(childMetadata);
		const detail = { version: 1, kind: "repeated-identical-failure", category: "repeated-identical-failure", requestId: task.requestId, taskId: task.requestId, turnId: task.turnId, sessionId: this.sessionId, processId: this.processId, guardianInstanceId: this.ownerId, agentId: childMetadata?.agent ?? "main", createdAt: this._clock(), dedupeKey,
			target: childMetadata ? { kind: "subagent", runId: childMetadata.runId, agentId: childMetadata.agent, childIndex: childMetadata.childIndex } : { kind: "session", sessionId: this.sessionId },
			confidenceScore: scored.probability, confidenceThreshold: scored.threshold, modelVersion: scored.modelVersion, evidence,
			...(this._observedSignals(task) ? { observedSignals: this._observedSignals(task) } : {}) };
		if (child) {
			const relay = this._childRelay("guardian_intervention", content);
			if (!relay || !(await this._awaitParentVisibility(relay, { stillCurrent: () => this._handle(this.sessionId) && this._enabled && !this._disposed && generation === this._stateGeneration && task.evidenceVersion === evidenceVersion }))) { this._stats.abstained++; return; }
		}
		if (!this._enabled || this._disposed || this._activeTaskId !== task.requestId || generation !== this._stateGeneration || task.evidenceVersion !== evidenceVersion) { this._stats.abstained++; return; }
		task.emittedFailureKeys.add(dedupeKey);
		while (task.emittedFailureKeys.size > MAX_INTERVENTION_HISTORY) task.emittedFailureKeys.delete(task.emittedFailureKeys.values().next().value);
		this._stats.admitted++;
		this._admitWindow("repeated-identical-failure");
		this._notifyDecision("repeated-identical-failure", "intervened", { score: scored.probability / 10000, threshold: scored.threshold / 10000, tool: attempts.at(-1).toolName });
		try { await this._emit({ type: "guardian_intervention", detail, content, child }); } catch { /* observability must not affect agent execution */ }
	}

	/** One visible verdict per real Guardian decision (display-only). */
	_notifyDecision(kind, outcome, extra = {}) {
		try {
			const result = this._observe({ guardianInstanceId: this.ownerId, outcome: "decision", decision: outcome, check: kind, stats: { ...this._stats }, count: this._stats.toolResults, evaluations: this._stats.classifierEvaluations, ...extra });
			if (result?.then) void Promise.resolve(result).catch(() => {});
		} catch { /* display-only */ }
	}

	/** Shared admission and delivery for deterministic detectors. The same
	 * window, arbitration plane, child relay and history rules apply as for the
	 * WASM-scored detector; a stale task or generation abstains. */
	async _intervene(task, { kind, content, reason, priority, dedupeKey, evidence, extraDetail = {} }) {
		if (task.emittedFailureKeys.has(dedupeKey)) { this._stats.suppressedHistory++; return false; }
		const generation = this._stateGeneration, evidenceVersion = task.evidenceVersion;
		if (!this._windowAllows(kind)) { this._stats.suppressedWindow++; this._notifyDecision(kind, "deferred", { reason: "window" }); return false; }
		const arbiterRequestId = this._arbiterRequestId();
		if (!arbiterRequestId) { this._stats.abstained++; return false; }
		const decision = this._arbiter.enforce({ source: "guardian-intelligence", requestId: arbiterRequestId, category: "guidance", priority, reason, stabilityKey: dedupeKey,
			contentHash: sha256(content), ttlMs: 30_000, estimatedChars: content.length, estimatedCost: 0, blocking: false, slot: `guardian:${sha256(dedupeKey).slice(0, 32)}`, evidence });
		if (decision.outcome !== "admitted") { this._stats.abstained++; this._notifyDecision(kind, "abstained", { reason: "arbitration" }); return false; }
		const childMetadata = readChildMetadata();
		const child = Boolean(childMetadata);
		const current = () => this._handle(this.sessionId) && this._enabled && !this._disposed && generation === this._stateGeneration && this._activeTaskId === task.requestId;
		if (child) {
			const relay = this._childRelay("guardian_intervention", content);
			if (!relay || !(await this._awaitParentVisibility(relay, { stillCurrent: current }))) { this._stats.abstained++; return false; }
		}
		if (!current() || task.evidenceVersion !== evidenceVersion && kind !== "unverified-completion") { this._stats.abstained++; return false; }
		task.emittedFailureKeys.add(dedupeKey);
		while (task.emittedFailureKeys.size > MAX_INTERVENTION_HISTORY) task.emittedFailureKeys.delete(task.emittedFailureKeys.values().next().value);
		this._stats.admitted++;
		this._admitWindow(kind);
		this._notifyDecision(kind, "intervened");
		try { await this._emit({ type: "guardian_intervention", content, child, detail: { version: 1, kind, category: kind, requestId: task.requestId, taskId: task.requestId, turnId: task.turnId, sessionId: this.sessionId, processId: this.processId, guardianInstanceId: this.ownerId, agentId: childMetadata?.agent ?? "main", createdAt: this._clock(), dedupeKey,
			target: childMetadata ? { kind: "subagent", runId: childMetadata.runId, agentId: childMetadata.agent, childIndex: childMetadata.childIndex } : { kind: "session", sessionId: this.sessionId }, evidence, ...extraDetail,
			...(this._observedSignals(task) ? { observedSignals: this._observedSignals(task) } : {}) } }); } catch { /* observability must not affect agent execution */ }
		return true;
	}

	_recordVerification(task, call) {
		// Completion order and millisecond timestamps cannot prove which source
		// a concurrent check saw. Only a stable mutation generation can.
		if (!call.verificationEligible || call.mutation || call.verificationEpoch !== task.verificationEpoch || call.verificationVersion !== task.mutationVersion
			|| [...this._inFlight.values()].some(active => active.taskId === task.requestId && active.mutation)) return;
		task.verifiedVersion = task.mutationVersion;
		this._stats.verifications++;
	}

	_completeBackgroundCheck(task, result) {
		if (!result || typeof result.id !== "string") return;
		const call = task.pendingChecks.get(result.id);
		if (!call || !["completed", "failed", "killed", "timed_out"].includes(result.status)) return;
		task.pendingChecks.delete(result.id);
		if (result.status === "completed" && result.exitCode === 0 && !result.signal) this._recordVerification(task, call);
	}

	/** Working-pattern evidence per task: mutations, verification runs, edit
	 * mismatches per file and repeated identical reads. Paths are hashed in
	 * evidence; nothing here stores file contents. */
	async _trackWorkingPattern(task, call, event, errorHash) {
		if (!this._enabled) return;
		// A failed check is evidence against completion, not verification of it.
		if (call.verification && event.isError === false) {
			const details = event.result?.details;
			const job = details?.task;
			if (job && typeof job.id === "string" && job.id.length <= 256) {
				task.pendingChecks.set(job.id, call);
				while (task.pendingChecks.size > 32) task.pendingChecks.delete(task.pendingChecks.keys().next().value);
				this._completeBackgroundCheck(task, job);
			} else if (call.toolName !== "bg_run" && !details?.signal
				&& (details?.exitCode ?? details?.exit_code ?? 0) === 0
				&& !event.result?.content?.some(part => part.type === "text" && /\[managed bash\] Still running/.test(part.text))) {
				this._recordVerification(task, call);
			}
		}
		if (call.toolName === "bg_status" && event.isError === false) {
			for (const job of (Array.isArray(event.result?.details?.tasks) ? event.result.details.tasks.slice(0, 64) : [])) this._completeBackgroundCheck(task, job);
		}
		// Only fingerprintable failures extend the streak: an unfingerprintable
		// failure breaks evidence continuity the way it resets attempt episodes.
		const countable = event.isError && typeof errorHash === "string" && typeof call.fingerprint === "string";
		if (countable) {
			task.consecutiveFailures = (task.consecutiveFailures ?? 0) + 1;
			task.burstErrors.push(errorHash);
			task.burstPrints.push(call.fingerprint);
			while (task.burstErrors.length > CONSECUTIVE_FAILURE_THRESHOLD) task.burstErrors.shift();
			while (task.burstPrints.length > CONSECUTIVE_FAILURE_THRESHOLD) task.burstPrints.shift();
		} else {
			task.consecutiveFailures = 0;
			task.burstErrors = [];
			task.burstPrints = [];
		}
		if (call.mutation && (!event.isError || event.result?.details?.fileMutation)) {
			task.mutationVersion++; task.completionChecked = false; this._stats.mutations++;
			// File contents may have changed: earlier reads are no longer repeats.
			task.reads.clear();
			if (call.rawPath) task.editFailures.delete(call.rawPath);
		}
		if (call.toolName === "read" && !event.isError && call.rawPath) {
			task.editFailures.delete(call.rawPath);
			if (call.readKey) {
				const seen = (task.reads.get(call.readKey) ?? 0) + 1;
				task.reads.set(call.readKey, seen);
				while (task.reads.size > MAX_TRACKED_PATHS) task.reads.delete(task.reads.keys().next().value);
				if (seen >= READ_CHURN_THRESHOLD) {
					this._stats.readChurnCandidates++;
					const pathHash = sha256(call.rawPath).slice(0, 16);
					await this._intervene(task, { kind: "repeated-identical-read", priority: 45, dedupeKey: `read-churn:${sha256(`${task.requestId}:${call.readKey}`)}`,
						content: `The same file range has now been read ${seen} times with no change to it in between. Reuse the earlier read, or read a narrower range that answers the open question.`,
						reason: "Identical read repeated without an intervening mutation.", evidence: [{ kind: "repeated-read", id: `${task.requestId}:read:${pathHash}`, hash: pathHash }] });
				}
			}
		}
		if ((call.toolName === "edit" || call.toolName === "bulk_edit") && event.isError && call.rawPath) {
			const record = task.editFailures.get(call.rawPath) ?? { count: 0, prints: new Set() };
			record.count++; if (call.fingerprint && record.prints.size < 16) record.prints.add(call.fingerprint);
			task.editFailures.set(call.rawPath, record);
			while (task.editFailures.size > MAX_TRACKED_PATHS) task.editFailures.delete(task.editFailures.keys().next().value);
			const failures = record.count;
			// Identical retries belong to the WASM repeated-failure detector; this
			// one covers varied attempts that keep missing the current content.
			if (failures >= EDIT_MISMATCH_THRESHOLD && record.prints.size >= 2) {
				this._stats.editLoopCandidates++;
				const pathHash = sha256(call.rawPath).slice(0, 16);
				if (await this._intervene(task, { kind: "edit-mismatch-loop", priority: 60, dedupeKey: `edit-loop:${sha256(`${task.requestId}:${call.rawPath}:${Math.floor(failures / EDIT_MISMATCH_THRESHOLD)}`)}`,
					content: `Edits to the same file have failed ${failures} times without a fresh read in between. Re-read the current content of that file (the exact region) before the next edit instead of adjusting the old text from memory.`,
					reason: "Consecutive failed edits on one file with no intervening read.", evidence: [{ kind: "failed-edit", id: `${task.requestId}:edit:${pathHash}`, hash: pathHash }] })) task.editFailures.delete(call.rawPath);
			}
		}
		// Same-operation retries belong to the WASM repeated-failure detector
		// and same-file edit loops to the detector above; this one covers a
		// burst of consecutive failures across varied operations, which neither
		// of those detectors can see.
		const streak = task.consecutiveFailures ?? 0;
		const varied = new Set(task.burstPrints).size >= 2;
		if (countable && streak >= CONSECUTIVE_FAILURE_THRESHOLD && varied) {
			this._stats.burstCandidates++;
			const bucket = Math.floor(streak / CONSECUTIVE_FAILURE_THRESHOLD);
			const burstHash = sha256(task.burstErrors.join("|") || `${task.requestId}:${streak}`).slice(0, 16);
			await this._intervene(task, { kind: "consecutive-failure-burst", priority: 50, dedupeKey: `failure-burst:${sha256(`${task.requestId}:${bucket}:${task.burstErrors.join(",")}`)}`,
				content: `The last ${streak} tool calls all failed. Pause new attempts, read the actual error causes, and fix the underlying issue before retrying.`,
				reason: "Consecutive tool failures across varied operations with no success in between.", evidence: [{ kind: "failed-tool-burst", id: `${task.requestId}:burst:${bucket}`, hash: burstHash }] });
		}
	}

	/** A final reply that presents changed work as finished while no
	 * verification ran after the last change. At most once per change set. */
	async _considerUnverifiedCompletion(task, message) {
		if (!this._enabled || !task.mutationVersion || task.completionChecked || message?.stopReason !== "stop") return;
		const parts = Array.isArray(message.content) ? message.content : [];
		if (parts.some((part) => part?.type === "toolCall")) return;
		if (task.verifiedVersion === task.mutationVersion) return;
		const text = parts.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
		if (!claimsCompletion(text)) return;
		task.completionChecked = true;
		this._stats.completionCandidates++;
		await this._intervene(task, { kind: "unverified-completion", priority: 55, dedupeKey: `unverified-completion:${sha256(`${task.requestId}:${task.mutationVersion}`)}`,
			content: "Files changed after the last verification run, and this reply presents the work as finished. Run the check that proves the change (tests, build, syntax check or a rendered view) or state plainly which parts remain unverified before finishing.",
			reason: "Completion claim with mutations newer than any verification run.", evidence: [{ kind: "completion-claim", id: `${task.requestId}:${task.responseEpoch}`, hash: sha256(text.slice(-400)) }] });
	}

	async analyzeToolActivity(activity) {
		// A literal, verified allow-root is the only supported path rule. The
		// project root and target resolve through real paths; if either cannot be
		// canonicalized (including an unresolved/suspicious symlink), abstain.
		if (!this._enabled || this._quarantined || !this._handle(this.sessionId)) return false;
		const task = this._tasks.get(activity?.taskId ?? this._activeTaskId);
		if (!task || task.requestId !== this._activeTaskId || !activity || activity.toolName !== "write" && activity.toolName !== "edit") return false;
		const generation = this._stateGeneration;
		const pathValue = activity.args?.path;
		const now = this._clock();
		const observedAt = activity.observedAt ?? now;
		if (typeof pathValue !== "string" || pathValue.length > 1024 || !activity.succeeded || !Number.isFinite(observedAt) || observedAt > now || now - observedAt > MAX_PATH_EVIDENCE_AGE_MS) return false;
		const target = canonicalPathForEvidence(this.cwd, pathValue);
		if (!target) return false;
		const toolCallId = typeof activity.toolCallId === "string" && activity.toolCallId.length <= 256 ? activity.toolCallId : undefined;
		if (!toolCallId) return false;
		for (const constraint of task.effectiveConstraints) {
			if (constraint.key !== "file-scope") continue;
			const root = canonicalPathForEvidence(this.cwd, constraint.value);
			if (!root || isWithinPath(root, target)) continue;
			const constraintId = stableConstraintId(constraint);
			const currentEvidence = task.constraintEvidence.get(constraintId) ?? new Map();
			currentEvidence.set(toolCallId, { path: target, at: observedAt });
			while (currentEvidence.size > 32) currentEvidence.delete(currentEvidence.keys().next().value);
			task.constraintEvidence.set(constraintId, currentEvidence);
			const allEvidence = new Map();
			for (const lineageId of task.lineageIds) {
				const lineageTask = this._tasks.get(lineageId);
				const lineageEvidence = lineageTask?.constraintEvidence.get(constraintId);
				for (const [callId, record] of lineageEvidence ?? []) {
					if (!Number.isFinite(record.at) || record.at > now || now - record.at > MAX_PATH_EVIDENCE_AGE_MS) lineageEvidence.delete(callId);
					else allEvidence.set(callId, record);
				}
			}
			// Retain one fresh successful call per distinct path, so the selected
			// evidence itself (not just the collection) proves independent changes.
			const distinctPaths = new Map();
			for (const [id, record] of [...allEvidence.entries()].sort((a, b) => a[1].at - b[1].at)) distinctPaths.set(record.path, { id, ...record });
			if (distinctPaths.size < 2 || task.lineageIds.some((id) => this._tasks.get(id)?.emittedConstraintIds.has(constraintId))) continue;
			this._stats.constraintCandidates++;
			if (!this._windowAllows("verified-constraint-drift")) { this._stats.suppressedWindow++; continue; }
			const content = "Two successful file changes appear to cross a verified user-requested path boundary. Verify their scope before continuing.";
			const evidence = [
				{ kind: "verified-user-constraint", id: constraintId, hash: sha256(constraint.text) },
				...Array.from(distinctPaths.values()).slice(-2).map(({ id, path }) => ({ kind: "successful-file-change", id, hash: sha256(path) })),
			];
			const arbiterRequestId = this._arbiterRequestId();
			if (!arbiterRequestId) { this._stats.abstained++; return false; }
			const decision = this._arbiter.enforce({ source: "guardian-intelligence", requestId: arbiterRequestId, category: "guidance", priority: 65,
				reason: "A literal user path constraint and two independent successful file operations indicate possible scope drift.",
				stabilityKey: `constraint-drift:${constraintId}`, contentHash: sha256(content), ttlMs: 30_000,
				estimatedChars: content.length, estimatedCost: 0, blocking: false, slot: `guardian:${sha256(constraintId).slice(0, 32)}`, evidence });
			if (decision.outcome !== "admitted" || !this._enabled || this._disposed || this._activeTaskId !== task.requestId) return false;
			const childMetadata = readChildMetadata();
			const child = Boolean(childMetadata);
			if (child) {
				const relay = this._childRelay("guardian_intervention", content);
				if (!relay || !(await this._awaitParentVisibility(relay, { stillCurrent: () => this._handle(this.sessionId) && this._enabled && !this._disposed && generation === this._stateGeneration && this._activeTaskId === task.requestId }))) { this._stats.abstained++; return false; }
			}
			if (!this._enabled || this._disposed || generation !== this._stateGeneration || this._activeTaskId !== task.requestId) { this._stats.abstained++; return false; }
			for (const lineageId of task.lineageIds) {
				const history = this._tasks.get(lineageId)?.emittedConstraintIds;
				if (!history) continue;
				history.add(constraintId);
				while (history.size > MAX_INTERVENTION_HISTORY) history.delete(history.values().next().value);
			}
			this._stats.admitted++;
			this._admitWindow("verified-constraint-drift");
			const dedupeKey = `constraint-drift:${constraintId}`;
			try { await this._emit({ type: "guardian_intervention", content, child, detail: { version: 1, kind: "verified-constraint-drift", category: "verified-constraint-drift", requestId: task.requestId, taskId: task.requestId, turnId: task.turnId, sessionId: this.sessionId, processId: this.processId, guardianInstanceId: this.ownerId, agentId: childMetadata?.agent ?? "main", createdAt: this._clock(), dedupeKey,
				target: childMetadata ? { kind: "subagent", runId: childMetadata.runId, agentId: childMetadata.agent, childIndex: childMetadata.childIndex } : { kind: "session", sessionId: this.sessionId }, evidence } }); } catch { /* keep core execution isolated */ }
			return true;
		}
		return false;
	}

	handleCommand(text) {
		if (typeof text !== "string") return undefined;
		const match = text.trim().match(/^\/guardian(?:\s+(on|off|status|stats|debug))?\s*$/i);
		if (!match) return undefined;
		const command = (match[1] ?? "status").toLowerCase();
		if (command === "on") { this._enabled = true; this._stateGeneration++; }
		else if (command === "off") {
			this._enabled = false; this._stateGeneration++; this._inFlight.clear(); this._arbiter.releaseAll();
			for (const task of this._tasks.values()) { task.attempts = []; task.episodeKey = undefined; task.consecutiveFailures = 0; task.burstErrors = []; task.burstPrints = []; task.evidenceVersion++; task.constraintEvidence.clear(); task.editFailures.clear(); task.reads.clear(); task.pendingChecks.clear(); task.verifiedVersion = task.mutationVersion; task.completionChecked = false; }
		}
		else if (command === "debug") this._debug = !this._debug;
		return { command, enabled: this._enabled, debug: this._debug, stats: { ...this._stats }, activeTaskId: this._debug ? this._activeTaskId : undefined, taskCount: this._tasks.size, guardianInstanceId: this.ownerId, debugInfo: this._debug ? { relation: this._tasks.get(this._activeTaskId)?.relation, analysisConfidence: this._tasks.get(this._activeTaskId)?.analysisConfidence, verifiedConstraints: this._tasks.get(this._activeTaskId)?.effectiveConstraints.length ?? 0, observedSignals: this._observedSignals(), recentDecisions: this._arbiter.journal().slice(-8) } : undefined, kernel: this._quarantined ? `quarantined:${this._quarantineReason}` : this._kernelError ? `quarantined:${this._kernelError}` : this._kernelRuntime ? Object.entries(this._kernelRuntime.status()).map(([name, status]) => `${name}:${status.state}${status.error ? `:${status.error}` : ""}`).join(",") : this._kernelPromise ? "initializing" : "lazy" };
	}

	quarantine(error) {
		this._quarantined = true;
		this._quarantineReason = error instanceof Error ? `${error.name}:${error.message}`.slice(0, 256) : String(error).slice(0, 256);
		this._stats.quarantined++;
		this._stateGeneration++;
	}

	dispose() {
		this._disposed = true;
		this._stateGeneration++;
		const owners = liveGuardianSessions.get(this.sessionId);
		owners?.delete(this.ownerId);
		if (owners?.size === 0) liveGuardianSessions.delete(this.sessionId);
		const sessions = this._sessionOwner ? guardianSessionOwners.get(this._sessionOwner) : undefined;
		const scopedOwners = sessions?.get(this.sessionId);
		scopedOwners?.delete(this.ownerId);
		if (scopedOwners?.size === 0) sessions.delete(this.sessionId);
		if (sessions?.size === 0) guardianSessionOwners.delete(this._sessionOwner);
		this._kernelRuntime = undefined; this._kernelPromise = undefined;
		this._tasks.clear(); this._inFlight.clear(); this._activeTaskId = undefined; this._latestAcceptedTaskId = undefined;
		this._peerReceipts.clear();
		this._arbiterCycleId = undefined;
		this._arbiter.releaseAll();
	}
}
