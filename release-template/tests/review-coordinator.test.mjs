import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const repo = path.resolve(import.meta.dirname, "..");
const agent = [path.join(repo, "agent"), path.resolve(repo, "..")].find((p) =>
	fs.existsSync(path.join(p, "extensions/lib/review-coordinator.ts")),
);
if (!agent) throw new Error("Review coordinator source is missing");
const lib = pathToFileURL(path.join(agent, "extensions/lib/")).href;
const coordinator = await import(lib + "review-coordinator.ts");

test("every review kind has a distinct purpose, owner and workflow", () => {
	for (const kind of ["quality", "project", "error", "council", "swarm", "fusion"]) {
		const spec = coordinator.REVIEW_KINDS[kind];
		assert.ok(spec.purpose.length > 20, kind);
		assert.ok(spec.owner.length > 10, kind);
		assert.ok(spec.workflow.length > 20, kind);
		assert.ok(spec.invoke.length > 20, kind);
	}
	const purposes = Object.values(coordinator.REVIEW_KINDS).map((s) => s.purpose);
	assert.equal(new Set(purposes).size, purposes.length);
	assert.match(coordinator.describeReviewKind("quality"), /implementation quality/);
});

test("trivial formatting/lint work is detected, real work is not", () => {
	assert.equal(coordinator.isTrivialChangeRequest("format this file with prettier"), true);
	assert.equal(coordinator.isTrivialChangeRequest("run eslint and fix lint errors"), true);
	assert.equal(coordinator.isTrivialChangeRequest("trivial cleanup of whitespace"), true);
	assert.equal(coordinator.isTrivialChangeRequest("refactor the auth module"), false);
	assert.equal(coordinator.isTrivialChangeRequest("fix the login regression"), false);
	assert.equal(coordinator.isTrivialChangeRequest("format the code and refactor the API"), false);
	assert.equal(coordinator.isTrivialChangeRequest(""), false);
	assert.equal(coordinator.isTrivialChangeRequest("redesign this animation because it is distracting"), false);
});

test("stuck signals fire only on strong patterns", () => {
	assert.equal(coordinator.evaluateStuckSignal({ consecutiveErrors: 1, sameFixRepeats: 1 }).kind, "none");
	assert.equal(
		coordinator.evaluateStuckSignal({ consecutiveErrors: 5, sameFixRepeats: 1, transientOnly: true }).kind,
		"none",
	);
	assert.equal(
		coordinator.evaluateStuckSignal({ consecutiveErrors: 5, sameFixRepeats: 1, errorKinds: ["capacity", "budget"] }).kind,
		"none",
	);
	assert.equal(
		coordinator.evaluateStuckSignal({ consecutiveErrors: 2, sameFixRepeats: 4 }).kind,
		"error",
	);
	assert.equal(
		coordinator.evaluateStuckSignal({ consecutiveErrors: 4, sameFixRepeats: 1, errorKinds: ["input", "output"] }).kind,
		"error",
	);
	assert.equal(
		coordinator.evaluateStuckSignal({ consecutiveErrors: 4, sameFixRepeats: 0, errorKinds: ["input"], debuggingLoop: true }).kind,
		"error",
	);
	assert.equal(
		coordinator.evaluateStuckSignal({ consecutiveErrors: 6, sameFixRepeats: 0, errorKinds: ["input"], meaningfulWork: false }).kind,
		"none",
	);
});

test("suggestion gating honors cooldowns, caps and recent runs", () => {
	const now = Date.now();
	assert.equal(coordinator.shouldSuggestReview("error", undefined, now), true);
	assert.equal(coordinator.shouldSuggestReview("nope", undefined, now), false);
	assert.equal(coordinator.shouldSuggestReview("error", { suggestionsThisSession: 2 }, now), false);
	assert.equal(coordinator.shouldSuggestReview("error", { lastSuggestedAt: now - 1000 }, now), false);
	assert.equal(coordinator.shouldSuggestReview("error", { lastSuggestedAt: now - 31 * 60_000 }, now), true);
	assert.equal(coordinator.shouldSuggestReview("error", { lastReviewAt: now - 1000 }, now), false);
	assert.equal(coordinator.shouldSuggestReview("error", { lastReviewAt: now - 11 * 60_000 }, now), true);
});
