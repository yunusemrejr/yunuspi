import * as fs from "node:fs";
import * as path from "node:path";
import type { RetainedChild } from "../runs/background/retained-children.ts";
import type { ControlEvent } from "../shared/types.ts";
import { listMissions, refreshMissionRuns } from "./store.ts";
import type { MissionRecord, MissionStoreLocation } from "./types.ts";
import { missionStatePath } from "./workflow-state.ts";

const TERMINAL_MISSION_STATUSES = new Set(["completed", "failed", "cancelled"]);
const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "active"]);
const MAX_ACTION_LENGTH = 180;

export interface GoalContinuationNotice {
	missionId: string;
	message: string;
	event: ControlEvent;
}

function bounded(value: string): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > MAX_ACTION_LENGTH ? `${normalized.slice(0, MAX_ACTION_LENGTH - 1)}…` : normalized;
}

function readyActionFromValue(value: unknown, pathLabel = "state", depth = 0): string | undefined {
	if (depth > 8 || !value || typeof value !== "object") return undefined;
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			const found = readyActionFromValue(value[index], `${pathLabel}[${index}]`, depth + 1);
			if (found) return found;
		}
		return undefined;
	}
	const input = value as Record<string, unknown>;
	for (const key of ["nextReadyAction", "nextAction"] as const) {
		if (typeof input[key] === "string" && input[key].trim()) return bounded(input[key]);
	}
	if (input.status === "ready") {
		for (const key of ["action", "task", "title", "summary"] as const) {
			if (typeof input[key] === "string" && input[key].trim()) return bounded(input[key]);
		}
		return `Continue ready mission state at ${pathLabel}`;
	}
	for (const [key, child] of Object.entries(input)) {
		const found = readyActionFromValue(child, `${pathLabel}.${key}`, depth + 1);
		if (found) return found;
	}
	return undefined;
}

function missionStateAction(location: MissionStoreLocation, record: MissionRecord): string | undefined {
	const statePath = missionStatePath(location, record.id);
	if (fs.existsSync(statePath)) {
		const action = readyActionFromValue(JSON.parse(fs.readFileSync(statePath, "utf-8")));
		if (action) return action;
	}
	const decision = record.decisions.find((item) => item.status === "open");
	if (decision) return bounded(decision.recommendation ?? `Resolve decision: ${decision.title}`);
	return undefined;
}

function retainedResumeTarget(record: MissionRecord, retainedChildren: RetainedChild[]): RetainedChild | undefined {
	const latestRun = record.runs.at(-1);
	if (!latestRun) return undefined;
	return retainedChildren.find((child) =>
		child.resumability.state === "resumable" && (child.runId === latestRun.runId || child.parentRunId === latestRun.runId)
	);
}

function nextReadyAction(location: MissionStoreLocation, record: MissionRecord, retainedChildren: RetainedChild[]): string {
	const stateAction = missionStateAction(location, record);
	const latestRun = record.runs.at(-1);
	const action = stateAction
		?? (latestRun?.status === "failed" || latestRun?.status === "paused"
			? `Inspect linked run ${latestRun.runId} and continue the mission`
			: `Continue objective: ${record.objective}`);
	const retained = retainedResumeTarget(record, retainedChildren);
	return retained
		? `Resume retained child ${retained.runId} (${retained.agent}) for: ${bounded(action)}`
		: bounded(action);
}

export function collectGoalContinuationNotices(input: {
	location: MissionStoreLocation;
	ownerSessionId: string;
	retainedChildren: RetainedChild[];
	turnId: number;
	now?: number;
	onWarning?: (message: string) => void;
}): GoalContinuationNotice[] {
	const notices: GoalContinuationNotice[] = [];
	for (const listed of listMissions(input.location).records) {
		if (listed.ownerSessionId !== input.ownerSessionId || !listed.goal || TERMINAL_MISSION_STATUSES.has(listed.status)) continue;
		let record: MissionRecord;
		let action: string;
		try {
			const refreshed = refreshMissionRuns(input.location, listed.id);
			if (refreshed.warnings.length) {
				for (const warning of refreshed.warnings) input.onWarning?.(warning);
				continue;
			}
			record = refreshed.record;
			if (record.ownerSessionId !== input.ownerSessionId || TERMINAL_MISSION_STATUSES.has(record.status)
				|| record.goal?.status !== "active" || !record.budget || (record.usage?.tokens ?? 0) >= record.budget.tokens
				|| record.runs.some(run => ACTIVE_RUN_STATUSES.has(run.status ?? ""))) continue;
			action = nextReadyAction(input.location, record, input.retainedChildren);
		} catch (error) {
			input.onWarning?.(`Goal mission ${listed.id}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		const budget = record.budget.tokens;
		const used = record.usage?.tokens ?? 0;
		const remaining = Math.max(0, budget - used);
		const message = [
			`Goal mission needs attention: ${bounded(record.title)}`,
			`Mission: ${record.id}`,
			`Remaining budget: ${remaining} tokens (${used}/${budget} used)`,
			`Next ready action: ${action}`,
		].join("\n");
		notices.push({
			missionId: record.id,
			message,
			event: {
				type: "needs_attention",
				to: "needs_attention",
				ts: input.now ?? Date.now(),
				runId: `goal-${record.id}-turn-${input.turnId}`,
				agent: "goal mission",
				message,
				reason: "idle",
			},
		});
	}
	return notices;
}
