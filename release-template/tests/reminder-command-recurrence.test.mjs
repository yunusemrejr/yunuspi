// Slash-command reminder lifecycle: immediate full delivery, active-turn
// repeats, persistence across compaction/reload, and explicit clearing.
// Offline and deterministic; no provider or child inference.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");

const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((dir) =>
	fs.existsSync(path.join(dir, "extensions/reminders.ts")),
);
assert.ok(agent);
const extension = (name) => pathToFileURL(path.join(agent, "extensions", name));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-reminder-command-"));
const oldHome = process.env.HOME;
const oldNow = Date.now;
process.env.HOME = home;
let now = 1_900_000_000_000;
Date.now = () => now;

const { default: reminders } = await import(extension("reminders.ts"));
const { readRemindersState, MANUAL_INTERVAL_MS } = await import(
	extension("lib/reminders-state.ts")
);
const T = MANUAL_INTERVAL_MS;

function fixture(sid, { reject = false, rejectNotify = false } = {}) {
	const hooks = new Map();
	const commands = new Map();
	const sent = [];
	const notices = [];
	let shouldReject = reject;
	const ctx = {
		cwd: home,
		sessionManager: { getSessionId: () => sid, getBranch: () => [] },
		ui: {
			notify: (message, level) => {
				if (rejectNotify) throw new Error("UI closed");
				notices.push({ message, level });
			},
		},
	};
	const pi = {
		on: (name, handler) => hooks.set(name, handler),
		registerCommand: (name, definition) => commands.set(name, definition.handler),
		getActiveTools: () => [],
		sendMessage: (message, options) => {
			if (shouldReject) throw new Error("queue unavailable");
			sent.push({ message, options });
		},
	};
	reminders(pi);
	return {
		ctx,
		sent,
		notices,
		command: (args) => commands.get("reminder")(args, ctx),
		setReject: (value) => {
			shouldReject = value;
		},
		emit: (name, event = {}) => hooks.get(name)?.(event, ctx),
	};
}

try {
	const text = `${"Preserve this whole reminder. ".repeat(16)}FINAL-VERIFICATION-CLAUSE`;
	const first = fixture("command-recurrence");
	await first.emit("session_start", { reason: "new" });
	await first.command(text);
	assert.equal(
		first.sent.length,
		1,
		"slash command sends the first reminder immediately",
	);
	assert.equal(first.sent[0].options.deliverAs, "steer");
	assert.equal(
		first.sent[0].options.triggerTurn,
		true,
		"explicit command may wake an idle agent once",
	);
	assert.equal(first.sent[0].message.display, true);
	assert.ok(
		first.sent[0].message.content.includes(text),
		"immediate delivery preserves the complete accepted text",
	);
	assert.match(first.sent[0].message.content, /FINAL-VERIFICATION-CLAUSE/);
	let state = readRemindersState("command-recurrence");
	assert.equal(state.manual[0].delivered, 1);
	assert.equal(state.manual[0].nextFireAt, 1_900_000_000_000 + T);

	// Repeats occur only at active lifecycle opportunities, never before the
	// anchored five-minute point and never from a final/idle turn.
	await first.emit("turn_end", {
		message: { role: "assistant", stopReason: "toolUse" },
		toolResults: [{ toolCallId: "tool-early" }],
	});
	assert.equal(first.sent.length, 1);
	now += T;
	await first.emit("turn_end", {
		message: { role: "assistant", stopReason: "toolUse" },
		toolResults: [{ toolCallId: "tool-1" }],
	});
	assert.equal(
		first.sent.length,
		2,
		"first scheduled repeat reaches an active tool turn",
	);
	assert.ok(
		first.sent[1].message.content.includes(text),
		"scheduled repeat preserves the complete accepted text",
	);
	assert.match(first.sent[1].message.content, /FINAL-VERIFICATION-CLAUSE/);
	state = readRemindersState("command-recurrence");
	assert.equal(state.manual[0].delivered, 2);
	assert.equal(state.manual[0].nextFireAt, 1_900_000_000_000 + 2 * T);
	now += T;
	await first.emit("turn_end", {
		message: { role: "assistant", stopReason: "toolUse" },
		toolResults: [{ toolCallId: "tool-2" }],
	});
	assert.equal(
		first.sent.length,
		3,
		"second scheduled repeat remains available",
	);
	assert.match(first.sent[2].message.content, /FINAL-VERIFICATION-CLAUSE/);

	// Compaction/reload reads the same durable schedule and continues on-grid.
	await first.emit("session_compact", {});
	now += T;
	const resumed = fixture("command-recurrence");
	await resumed.emit("session_start", { reason: "startup" });
	const resumedStart = await resumed.emit("before_agent_start", {
		prompt: "Continue the task",
	});
	assert.equal(
		resumed.sent.length,
		0,
		"resume injects through before_agent_start without a wake",
	);
	assert.match(
		resumedStart?.message?.content ?? "",
		/FINAL-VERIFICATION-CLAUSE/,
	);
	state = readRemindersState("command-recurrence");
	assert.equal(state.manual[0].delivered, 4);

	await resumed.command("clear 1");
	state = readRemindersState("command-recurrence");
	assert.equal(
		state.manual[0].active,
		false,
		"clear completes the retained reminder",
	);
	const afterClear = resumed.sent.length;
	now += T;
	await resumed.emit("turn_end", {
		message: { role: "assistant", stopReason: "toolUse" },
		toolResults: [{ toolCallId: "tool-after-clear" }],
	});
	assert.equal(resumed.sent.length, afterClear, "cleared reminder never recurs");

	// A rejected immediate queue remains durable and visible as a failed
	// delivery; a later active opportunity can still deliver it.
	const rejected = fixture("command-rejected", { reject: true });
	await rejected.emit("session_start", { reason: "new" });
	const rejectedAt = now;
	await rejected.command("Deliver this after a transient queue failure");
	assert.equal(rejected.sent.length, 0);
	assert.ok(
		rejected.notices.some(
			({ message, level }) =>
				level === "warning" && /immediate delivery failed/.test(message),
		),
	);
	state = readRemindersState("command-rejected");
	assert.equal(state.manual[0].delivered, 0);
	assert.equal(
		state.manual[0].nextFireAt,
		rejectedAt,
		"failed first send is retained as due",
	);
	rejected.setReject(false);
	now += T;
	const retry = await rejected.emit("before_agent_start", {
		prompt: "Continue",
	});
	assert.equal(
		rejected.sent.length,
		0,
		"retry uses the normal prompt injection path",
	);
	assert.match(retry?.message?.content ?? "", /transient queue failure/);
	assert.equal(readRemindersState("command-rejected").manual[0].delivered, 1);

	// A post-queue UI failure must not be mistaken for queue rejection or
	// re-arm a reminder that has already been accepted.
	const notifyFailure = fixture("command-notify-failure", {
		rejectNotify: true,
	});
	await notifyFailure.emit("session_start", { reason: "new" });
	await notifyFailure.command("Queue despite a closed notification panel");
	assert.equal(notifyFailure.sent.length, 1);
	assert.equal(
		readRemindersState("command-notify-failure").manual[0].delivered,
		1,
	);

	console.log(
		"PASS reminder-command-recurrence: immediate delivery, active-turn repeats, resume, clear, and retry",
	);
} finally {
	Date.now = oldNow;
	if (oldHome === undefined) delete process.env.HOME;
	else process.env.HOME = oldHome;
	fs.rmSync(home, { recursive: true, force: true });
}
