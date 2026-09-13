// First-prompt harness orientation: fixed, optional, persisted, and main-session only.
// No provider, child inference, or network call is used.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")]
	.find(dir => fs.existsSync(path.join(dir, "extensions/reminders.ts")));
assert.ok(agent);
const extension = name => pathToFileURL(path.join(agent, "extensions", name));

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-discovery-reminders-"));
process.env.HOME = home;
delete process.env.PI_SUBAGENT_CHILD;

const { default: reminders } = await import(extension("reminders.ts"));
const {
	defaultRemindersState,
	writeRemindersState,
} = await import(extension("lib/reminders-state.ts"));
const {
	hasOrientationReceipt,
	orientationReceiptFile,
} = await import(extension("lib/harness-orientation.ts"));

const makeFixture = (sid, names = ["read", "tool_search", "skill_review"]) => {
	const hooks = new Map();
	let active = [...names];
	const entries = [];
	const ctx = {
		cwd: home,
		sessionManager: {
			getSessionId: () => sid,
			getEntries: () => entries,
			getBranch: () => entries,
		},
		ui: { setStatus() {}, notify() {} },
	};
	const pi = {
		on(name, handler) {
			const list = hooks.get(name) ?? [];
			list.push(handler);
			hooks.set(name, list);
		},
		getActiveTools: () => active,
		setActiveTools: (next) => { active = [...next]; },
		getAllTools: () => active.map((name) => ({ name, description: name })),
		registerTool() {},
		registerCommand() {},
		appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
		sendMessage() {},
	};
	return {
		ctx,
		async emit(name, event = {}) {
			let result;
			for (const handler of hooks.get(name) ?? []) {
				const next = await handler(event, ctx);
				if (next !== undefined) result = next;
			}
			return result;
		},
		install() { reminders(pi); },
	};
};

const start = async (fixture, prompt, source = "interactive") => {
	await fixture.emit("input", { source, text: prompt });
	return fixture.emit("before_agent_start", { prompt });
};

try {
	const first = makeFixture("orientation-session-a");
	first.install();
	await first.emit("session_start", { reason: "new" });
	const firstResult = await start(first, "Implement the requested change");
	assert.match(firstResult?.message?.content ?? "", /Quick orientation/);
	assert.match(firstResult.message.content, /tool_search/);
	assert.match(firstResult.message.content, /skill_review/);
	assert.equal(hasOrientationReceipt("orientation-session-a"), true);
	assert.equal(fs.existsSync(orientationReceiptFile("orientation-session-a")), true);
	const coldReceipts = await import(`${extension("lib/harness-orientation.ts")}?cold-resume`);
	assert.equal(coldReceipts.hasOrientationReceipt("orientation-session-a"), true,
		"a fresh module reads the durable receipt without in-memory state");

	const delayed = makeFixture("orientation-session-delayed");
	delayed.install();
	await delayed.emit("session_start", { reason: "new" });
	for (let i = 0; i < 3; i++) {
		const wake = await start(delayed, "continue", "extension");
		assert.doesNotMatch(wake?.message?.content ?? "", /Quick orientation/);
	}
	assert.match((await start(delayed, "Implement the change"))?.message?.content ?? "", /Quick orientation/);

	const optedOut = makeFixture("orientation-session-opt-out");
	optedOut.install();
	assert.doesNotMatch((await start(optedOut, "No tools please"))?.message?.content ?? "", /Quick orientation/);
	assert.equal(hasOrientationReceipt("orientation-session-opt-out"), true);
	assert.doesNotMatch((await start(optedOut, "Continue the task"))?.message?.content ?? "", /Quick orientation/);

	// A continuation wake has no preceding human input and cannot repeat it.
	const continuation = await first.emit("before_agent_start", {
		source: "extension",
		prompt: "continue",
	});
	assert.equal(continuation, undefined);

	// Reload/resume with the same session id reads the persisted receipt.
	const resumed = makeFixture("orientation-session-a");
	resumed.install();
	await resumed.emit("session_start", { reason: "startup" });
	const resumedResult = await start(resumed, "Continue the requested change");
	assert.equal(resumedResult, undefined);

	// A different session gets its own first-prompt orientation.
	const fresh = makeFixture("orientation-session-b");
	fresh.install();
	await fresh.emit("session_start", { reason: "new" });
	const freshResult = await start(fresh, "Start a new task");
	assert.match(freshResult?.message?.content ?? "", /Quick orientation/);

	// Existing user reminder content remains in the same message.
	const manualSid = "orientation-session-manual";
	const state = defaultRemindersState();
	state.manual.push({
		id: "manual-1",
		text: "Keep the user's existing reminder",
		createdAt: Date.now() - 180_000,
		nextFireAt: Date.now() - 1,
		active: true,
		delivered: 0,
	});
	writeRemindersState(manualSid, state);
	const manual = makeFixture(manualSid);
	manual.install();
	await manual.emit("session_start", { reason: "new" });
	const manualResult = await start(manual, "Continue the task");
	assert.match(manualResult?.message?.content ?? "", /Quick orientation/);
	assert.match(manualResult.message.content, /Keep the user's existing reminder/);

	// Discovery names are omitted when those surfaces are unavailable.
	const limited = makeFixture("orientation-session-limited", ["read"]);
	limited.install();
	await limited.emit("session_start", { reason: "new" });
	const limitedResult = await start(limited, "Do the task");
	assert.match(limitedResult?.message?.content ?? "", /Quick orientation/);
	assert.doesNotMatch(limitedResult.message.content, /tool_search|skill_review/);

	console.log("PASS discovery-reminders: first prompt, resume, new session, continuation, merge, and availability");
} finally {
	fs.rmSync(home, { recursive: true, force: true });
}
