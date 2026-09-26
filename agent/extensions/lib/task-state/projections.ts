/**
 * Task State Graph — bounded projections.
 *
 * Pure renderers: the whole graph is never injected into context. Each
 * consumer gets a small relevance-selected slice with hard char/item budgets.
 * Unknown stays unknown; lack of evidence stays lack of evidence.
 */
import { requirementState } from "./reducer.ts";
import type { TaskEntity, TaskGraph } from "./types.ts";

export interface ProjectionBudgets {
	maxChars: number;
	maxItems: number;
}

export const DEFAULT_BUDGETS: ProjectionBudgets = { maxChars: 2000, maxItems: 12 };

const byUpdatedDesc = (a: TaskEntity, b: TaskEntity): number => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1);

const ofKind = (graph: TaskGraph, ...kinds: TaskEntity["kind"][]): TaskEntity[] =>
	Object.values(graph.entities).filter((entity) => kinds.includes(entity.kind));

const clip = (value: string, max: number): string => {
	const flat = String(value ?? "").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function fit(lines: string[], budgets: ProjectionBudgets): string {
	const kept: string[] = [];
	let chars = 0;
	for (const line of lines) {
		if (kept.length >= budgets.maxItems * 4) break;
		if (chars + line.length + 1 > budgets.maxChars) break;
		kept.push(line);
		chars += line.length + 1;
	}
	if (kept.length < lines.length) kept.push(`[… ${lines.length - kept.length} more lines omitted by budget]`);
	// Hard cap: the omission marker must never push a projection over budget.
	return kept.join("\n").slice(0, budgets.maxChars);
}

export interface RequirementRow {
	id: string;
	label: string;
	implemented: boolean;
	verified: boolean;
	status: string;
	evidence: number;
	staleEvidence: number;
}

export function requirementRows(graph: TaskGraph): RequirementRow[] {
	return ofKind(graph, "requirement")
		.sort(byUpdatedDesc)
		.map((entity) => {
			const state = requirementState(graph, entity.id);
			return {
				id: entity.refs?.requirementId ?? entity.id,
				label: clip(entity.title, 120),
				implemented: state.implemented,
				verified: state.verified,
				status: entity.status,
				evidence: state.evidence.length,
				staleEvidence: state.evidence.filter((entry) => entry.stale || entry.status === "invalidated").length,
			};
		});
}

export interface CompletionView {
	rows: RequirementRow[];
	implemented: number;
	verified: number;
	total: number;
	blockers: string[];
	complete: boolean;
}

export function projectCompletion(graph: TaskGraph): CompletionView {
	const rows = requirementRows(graph);
	const blockers: string[] = [];
	for (const row of rows) {
		if (row.status === "superseded" || row.status === "invalidated") continue;
		if (!row.implemented) blockers.push(`${row.id} not implemented (${row.status})`);
		else if (!row.verified) {
			blockers.push(row.staleEvidence > 0
				? `${row.id} implemented but verification is stale`
				: `${row.id} implemented but unverified`);
		}
	}
	const live = rows.filter((row) => row.status !== "superseded" && row.status !== "invalidated");
	return {
		rows,
		implemented: live.filter((row) => row.implemented).length,
		verified: live.filter((row) => row.verified).length,
		total: live.length,
		blockers: blockers.slice(0, 16),
		complete: live.length > 0 && blockers.length === 0,
	};
}

export interface FailureFamilyRow {
	family: string;
	count: number;
	latest: string;
}

export function failureFamilies(graph: TaskGraph): FailureFamilyRow[] {
	const groups = new Map<string, TaskEntity[]>();
	for (const entity of ofKind(graph, "failure")) {
		const family = entity.family ?? "fam-unknown";
		const list = groups.get(family) ?? [];
		list.push(entity);
		groups.set(family, list);
	}
	return [...groups.entries()]
		.map(([family, list]) => {
			list.sort(byUpdatedDesc);
			return { family, count: list.length, latest: clip(list[0]?.title ?? "", 140) };
		})
		.sort((a, b) => b.count - a.count || (a.family < b.family ? -1 : 1));
}

function section(title: string, lines: string[], empty: string): string[] {
	if (!lines.length) return [`${title}: ${empty}`];
	return [`${title}:`, ...lines.map((line) => `  ${line}`)];
}

/** Main-agent projection: current objective, work, gaps, blockers. */
export function projectMain(graph: TaskGraph, budgets: ProjectionBudgets = DEFAULT_BUDGETS): string {
	const completion = projectCompletion(graph);
	const work = ofKind(graph, "work").sort(byUpdatedDesc);
	const active = work.filter((entry) => entry.status === "active" || entry.status === "proposed");
	const decisions = ofKind(graph, "decision").sort(byUpdatedDesc).slice(0, budgets.maxItems);
	const assumptions = ofKind(graph, "assumption").filter((entry) => entry.status === "active" || entry.status === "proposed");
	const questions = ofKind(graph, "question").filter((entry) => entry.status !== "superseded" && entry.status !== "invalidated");
	const failures = ofKind(graph, "failure").sort(byUpdatedDesc).slice(0, 5);
	const evidence = ofKind(graph, "evidence").sort(byUpdatedDesc).slice(0, 6);
	const lines: string[] = [
		`Objective: ${clip(graph.objective || graph.label || "(no stated objective)", 300)}`,
		`Requirements: ${completion.verified}/${completion.total} verified, ${completion.implemented}/${completion.total} implemented`,
		...section("Unresolved requirements",
			completion.rows.filter((row) => !row.verified && row.status !== "superseded" && row.status !== "invalidated")
				.slice(0, budgets.maxItems).map((row) => `${row.id} ${row.implemented ? "implemented" : row.status} · ${row.label}`),
			"none — every live requirement is verified"),
		...section("Active work",
			active.slice(0, budgets.maxItems).map((entry) => `${entry.status} · ${clip(entry.title, 110)}`),
			"none"),
		...section("Recent failures",
			failures.map((entry) => `${entry.family ?? "?"} · ${clip(entry.title, 110)}`),
			"none recorded"),
		...section("Decisions",
			decisions.map((entry) => `${clip(entry.title, 110)} [${entry.provenance}]`),
			"none recorded"),
		...section("Open assumptions/questions",
			[...assumptions, ...questions].slice(0, budgets.maxItems).map((entry) => `${entry.kind} · ${clip(entry.title, 110)}`),
			"none"),
		...section("Recent evidence",
			evidence.map((entry) => `${entry.stale ? "STALE" : entry.status} · ${clip(entry.title, 110)} [${entry.provenance}]`),
			"none recorded"),
		...section("Completion blockers", completion.blockers.slice(0, budgets.maxItems), "none"),
	];
	if (graph.health.degraded) lines.push("Graph health: DEGRADED — projections may be incomplete; verify against sources.");
	return fit(lines, budgets);
}

/** Reviewer projection: what Observer needs without transcript archaeology. */
export function projectObserver(graph: TaskGraph, budgets: ProjectionBudgets = DEFAULT_BUDGETS): string {
	const completion = projectCompletion(graph);
	const stale = ofKind(graph, "evidence").filter((entry) => entry.stale);
	const decisions = ofKind(graph, "decision").sort(byUpdatedDesc).slice(0, 6);
	const assumptions = ofKind(graph, "assumption").filter((entry) => entry.status === "active" || entry.status === "proposed").slice(0, 6);
	const failures = failureFamilies(graph).slice(0, 4);
	const children = ofKind(graph, "child").sort(byUpdatedDesc).slice(0, 5);
	const claims = ofKind(graph, "completion-claim").sort(byUpdatedDesc).slice(0, 3);
	const contradictions = findContradictions(graph).slice(0, 4);
	const lines: string[] = [
		`Task state (shared graph, ${Object.keys(graph.entities).length} entities):`,
		...section("Requirements",
			completion.rows.slice(0, budgets.maxItems).map((row) =>
				`${row.id} implemented ${row.implemented ? "✓" : "✗"} verified ${row.verified ? "✓" : "✗"} · ${row.label}`),
			"none tracked"),
		...section("Incomplete verification",
			completion.rows.filter((row) => row.implemented && !row.verified).slice(0, 6)
				.map((row) => `${row.id} has no current verification evidence`),
			"none"),
		...section("Recent decisions", decisions.map((entry) => `${clip(entry.title, 110)} [${entry.provenance}]`), "none"),
		...section("Unresolved assumptions", assumptions.map((entry) => clip(entry.title, 110)), "none"),
		...section("Repeated failures", failures.map((entry) => `${entry.family} ×${entry.count} · ${entry.latest}`), "none"),
		...section("Child findings",
			children.map((entry) => `${entry.status} · ${clip(entry.title, 100)} — ${clip(entry.detail ?? "no summary", 120)} (unverified until checked)`),
			"none"),
		...section("Completion claims", claims.map((entry) => `${entry.status} · ${clip(entry.title, 100)}`), "none"),
		...section("Contradictions", contradictions, "none detected"),
		...section("Stale evidence", stale.slice(0, 6).map((entry) => `${clip(entry.title, 110)} (file changed after evidence)`), "none"),
	];
	return fit(lines, budgets);
}

/** Progress projection: what Watchmaker needs to spot wasted effort. */
export function projectWatchmaker(graph: TaskGraph, budgets: ProjectionBudgets = DEFAULT_BUDGETS): string {
	const work = ofKind(graph, "work").sort(byUpdatedDesc);
	const active = work.find((entry) => entry.status === "active") ?? work.find((entry) => entry.status === "proposed");
	const attempts = ofKind(graph, "attempt").length;
	const failures = failureFamilies(graph);
	const top = failures[0];
	const blocked = ofKind(graph, "work").filter((entry) => entry.status === "blocked");
	const done = ofKind(graph, "work").filter((entry) => entry.status === "implemented");
	const children = ofKind(graph, "child");
	const lines: string[] = [
		"Task progress (shared graph):",
		`Active work: ${active ? `${clip(active.title, 140)} [${active.status}]` : "none"}`,
		`Attempts: ${attempts} · failures: ${ofKind(graph, "failure").length} · repeated families: ${failures.filter((entry) => entry.count > 1).length}`,
		...(top && top.count > 1 ? [`Top repeat: ${top.family} ×${top.count} · ${top.latest}`] : []),
		...section("Blocked dependencies", blocked.slice(0, 6).map((entry) => clip(entry.title, 120)), "none"),
		...section("Completed investigations",
			done.slice(0, 6).map((entry) => clip(entry.title, 120)),
			"none yet"),
		`Child runs: ${children.length} (${children.filter((entry) => entry.status === "failed").length} failed)`,
	];
	return fit(lines, budgets);
}

export interface SubagentSliceInput {
	/** Focus hints: requirement ids, file paths, or keywords. */
	focus?: string[];
	maxChars?: number;
}

/** Bounded child slice: goal, relevant requirements/decisions/files/failures/evidence. */
export function projectSubagentSlice(graph: TaskGraph, input: SubagentSliceInput = {}): string {
	const budgets: ProjectionBudgets = { maxChars: input.maxChars ?? 1500, maxItems: 8 };
	const focus = new Set((input.focus ?? []).map((entry) => String(entry).toLowerCase()));
	const relevant = (entity: TaskEntity): boolean => {
		if (!focus.size) return true;
		const haystack = `${entity.id} ${entity.title} ${entity.detail ?? ""} ${entity.refs?.file ?? ""} ${entity.refs?.requirementId ?? ""}`.toLowerCase();
		for (const term of focus) if (term && haystack.includes(term)) return true;
		return false;
	};
	const reqs = ofKind(graph, "requirement").filter((entry) => entry.status !== "superseded" && relevant(entry)).slice(0, 6);
	const decisions = ofKind(graph, "decision").sort(byUpdatedDesc).filter(relevant).slice(0, 5);
	const files = [...new Set(ofKind(graph, "artifact").filter(relevant).map((entry) => entry.refs?.file ?? entry.title))].slice(0, 10);
	const failures = failureFamilies(graph).slice(0, 3);
	const evidence = ofKind(graph, "evidence").sort(byUpdatedDesc).filter((entry) => !entry.stale && relevant(entry)).slice(0, 4);
	const lines: string[] = [
		`Goal: ${clip(graph.objective || graph.label || "(no stated objective)", 300)}`,
		...section("Relevant requirements",
			reqs.map((entry) => {
				const state = requirementState(graph, entry.id);
				return `${entry.refs?.requirementId ?? entry.id} [${entry.status}] impl ${state.implemented ? "✓" : "✗"} ver ${state.verified ? "✓" : "✗"} · ${clip(entry.title, 100)}`;
			}), "none in focus"),
		...section("Known decisions", decisions.map((entry) => `${clip(entry.title, 100)} [${entry.provenance}]`), "none"),
		...section("Relevant files", files, "none listed"),
		...section("Known failures (do not repeat blindly)", failures.map((entry) => `${entry.family} ×${entry.count} · ${entry.latest}`), "none"),
		...section("Existing evidence", evidence.map((entry) => `${clip(entry.title, 100)} [${entry.provenance}]`), "none"),
		"Required output: bounded findings with file/line references. Required verification: state what you actually checked; unverified claims stay unverified.",
	];
	return fit(lines, budgets);
}

/** Cheap contradiction signals: active requirements challenged by blockers, stale-only verification. */
export function findContradictions(graph: TaskGraph): string[] {
	const out: string[] = [];
	const challenges = graph.links.filter((link) => link.kind === "challenges");
	for (const link of challenges.slice(0, 16)) {
		const target = graph.entities[link.to];
		const finding = graph.entities[link.from];
		if (!target || !finding) continue;
		if (target.status !== "superseded" && target.status !== "invalidated" && finding.status === "blocked") {
			out.push(`${clip(target.title, 80)} is challenged by blocker: ${clip(finding.title, 80)}`);
		}
	}
	for (const row of requirementRows(graph).slice(0, 16)) {
		if (row.verified) continue;
		if (row.evidence > 0 && row.staleEvidence === row.evidence) {
			out.push(`${row.id} reads implemented but all ${row.evidence} evidence bindings are stale`);
		}
	}
	return [...new Set(out)];
}

export interface GraphDiagnostics {
	counts: Record<string, number>;
	danglingLinks: number;
	duplicateTitles: Array<{ title: string; ids: string[] }>;
	staleEvidence: number;
	contradictions: string[];
	impossibleTransitions: number;
	orphanedChildren: string[];
	unlinkedVerification: string[];
	claimsWithoutCoverage: string[];
	degraded: boolean;
	quarantined: boolean;
	warnings: string[];
	errors: string[];
}

/** Graph-health diagnostics for /task-state and tests. */
export function collectDiagnostics(graph: TaskGraph): GraphDiagnostics {
	const entities = Object.values(graph.entities);
	const counts: Record<string, number> = {};
	for (const entity of entities) counts[entity.kind] = (counts[entity.kind] ?? 0) + 1;
	let dangling = 0;
	for (const link of graph.links) {
		if (!graph.entities[link.from] || !graph.entities[link.to]) dangling += 1;
	}
	const byTitle = new Map<string, string[]>();
	for (const entity of entities) {
		if (entity.kind !== "requirement" && entity.kind !== "decision") continue;
		const key = entity.title.toLowerCase().slice(0, 120);
		const list = byTitle.get(key) ?? [];
		list.push(entity.id);
		byTitle.set(key, list);
	}
	const duplicateTitles = [...byTitle.entries()]
		.filter(([, ids]) => ids.length > 1)
		.slice(0, 8)
		.map(([title, ids]) => ({ title, ids: ids.slice(0, 4) }));
	const staleEvidence = entities.filter((entity) => entity.kind === "evidence" && entity.stale).length;
	const linkedTargets = new Set(graph.links.map((link) => link.to));
	const linkedSources = new Set(graph.links.map((link) => link.from));
	const orphanedChildren = entities
		.filter((entity) => entity.kind === "child" && !linkedSources.has(entity.id) && !linkedTargets.has(entity.id))
		.map((entity) => entity.id)
		.slice(0, 16);
	const unlinkedVerification = entities
		.filter((entity) => entity.kind === "evidence" && !entity.stale
			&& !graph.links.some((link) => link.from === entity.id && (link.kind === "verified-by" || link.kind === "evidences")))
		.map((entity) => entity.id)
		.slice(0, 16);
	const claimsWithoutCoverage = entities
		.filter((entity) => entity.kind === "completion-claim" && entity.status === "active"
			&& !graph.links.some((link) => link.from === entity.id))
		.map((entity) => entity.id)
		.slice(0, 8);
	return {
		counts,
		danglingLinks: dangling,
		duplicateTitles,
		staleEvidence,
		contradictions: findContradictions(graph).slice(0, 8),
		impossibleTransitions: graph.health.impossibleTransitions.length,
		orphanedChildren,
		unlinkedVerification,
		claimsWithoutCoverage,
		degraded: graph.health.degraded,
		quarantined: graph.health.quarantined,
		warnings: [...graph.health.warnings],
		errors: [...graph.health.errors],
	};
}

/** /task-state summary rendering. */
export function renderSummary(graph: TaskGraph): string {
	const completion = projectCompletion(graph);
	const work = ofKind(graph, "work");
	const evidence = ofKind(graph, "evidence");
	const failures = ofKind(graph, "failure");
	const findings = ofKind(graph, "finding");
	const lines = [
		`Task: ${clip(graph.label || graph.taskId, 120)}${graph.health.degraded ? " [DEGRADED]" : ""}${graph.health.quarantined ? " [REBUILT FROM EVENTS]" : ""}`,
		"",
		"Requirements",
		`  ${completion.total} tracked · ${completion.verified} verified · ${completion.implemented - completion.verified} implemented/unverified · ${completion.total - completion.implemented} unresolved`,
		...completion.rows.slice(0, 12).map((row) => `  ${row.implemented ? "✓" : "·"}${row.verified ? "✓" : "·"} ${row.id} [${row.status}] ${row.label}`),
		"",
		"Work",
		`  ${work.filter((entry) => entry.status === "implemented").length} complete · ${work.filter((entry) => entry.status === "active").length} active · ${work.filter((entry) => entry.status === "blocked").length} blocked`,
		"",
		"Evidence",
		`  ${evidence.filter((entry) => !entry.stale).length} current · ${evidence.filter((entry) => entry.stale).length} stale`,
		"",
		"Failures",
		`  ${ofKind(graph, "attempt").length} attempts · ${failures.length} failures · ${failureFamilies(graph).filter((entry) => entry.count > 1).length} repeated families`,
		"",
		"Reviews",
		`  ${findings.length} findings (${findings.filter((entry) => entry.status === "blocked").length} blockers)`,
	];
	return lines.join("\n");
}
