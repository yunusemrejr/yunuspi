import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-quota-journal-"));
const repo = path.resolve(import.meta.dirname, "..");
const agent = [path.join(repo, "agent"), path.resolve(repo, "..")].find((p) =>
	fs.existsSync(path.join(p, "extensions/pi-subagents/src/runs/shared/quota-journal.ts")),
);
if (!agent) throw new Error("Quota journal source is missing");
const shared = pathToFileURL(path.join(agent, "extensions/pi-subagents/src/runs/shared/")).href;

const { mapJournalLinesToQuotaEvents, readJournalQuotaEvents } = await import(shared + "quota-journal.ts");

const line = (obj) => JSON.stringify(obj);

test("missing or unreadable journal yields no events, never throws", () => {
	assert.deepEqual(readJournalQuotaEvents(path.join(root, "no-such-journal.jsonl")), []);
	assert.deepEqual(readJournalQuotaEvents(path.join(root, "no-such-dir", "j.jsonl")), []);
});

test("journal lines map to ok/error/quota-exhausted; unknown lines skipped", () => {
	const file = path.join(root, "journal.jsonl");
	fs.writeFileSync(file, [
		line({ provider: "openrouter", ts: "2026-09-21T00:00:00.000Z", status: "end_turn" }),
		line({ provider: "deepseek", ts: "2026-09-21T00:01:00.000Z", status: "error" }),
		line({ provider: "orcarouter", ts: "2026-09-21T00:02:00.000Z", status: "quota_exceeded" }),
		line({ provider: "friendli", ts: "2026-09-21T00:03:00.000Z", quota: true }),
		"not json",
		line({ provider: "openrouter", ts: "2026-09-21T00:04:00.000Z", status: "something-else" }),
		line({ ts: "2026-09-21T00:05:00.000Z", status: "error" }),
		"",
	].join("\n"));
	assert.deepEqual(readJournalQuotaEvents(file).map((e) => [e.provider, e.kind]), [
		["openrouter", "ok"],
		["deepseek", "error"],
		["orcarouter", "quota-exhausted"],
		["friendli", "quota-exhausted"],
	]);
});

test("only the bounded tail window is honored on large journals", () => {
	const file = path.join(root, "big.jsonl");
	const head = line({ provider: "head-provider", ts: "2026-09-21T00:00:00.000Z", status: "quota_exceeded" });
	const filler = line({ provider: "tail-provider", ts: "2026-09-21T00:00:00.000Z", status: "end_turn" });
	const lines = [head];
	while (Buffer.byteLength(lines.join("\n"), "utf8") < 128 * 1024) lines.push(filler);
	fs.writeFileSync(file, lines.join("\n"));
	const events = readJournalQuotaEvents(file);
	assert.ok(events.length > 0 && events.length <= 64);
	assert.ok(events.every((e) => e.provider === "tail-provider"), "head marker outside the tail window is not honored");
});

test("empty journal yields no events", () => {
	const file = path.join(root, "empty.jsonl");
	fs.writeFileSync(file, "");
	assert.deepEqual(readJournalQuotaEvents(file), []);
	assert.deepEqual(mapJournalLinesToQuotaEvents([]), []);
});
