import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((p) =>
	fs.existsSync(path.join(p, "extensions/lib/session-hooks.ts")),
);
const load = (p) => import(pathToFileURL(path.join(agent, "extensions", p)));
const {
	nestedInstructionBlocks,
	restoredNestedInstructionKeys,
	NESTED_INSTRUCTION_KEY_PREFIX,
} = await load("lib/session-hooks.ts");
const { default: registerHooks } = await load("session-hooks.ts");

const REMINDER_OPEN = "<system-reminder>\nAdditional instructions from: ";

/** A temp workspace with the given files, removed after the test. */
function workspace(t, files) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nested-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	for (const [rel, text] of Object.entries(files)) {
		const file = path.join(dir, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text);
	}
	return dir;
}

const blocksFor = (cwd, toolName, input, shown = new Set()) =>
	nestedInstructionBlocks({ cwd, toolName, input, shown });

test("a file below cwd gets the instruction file of its own directory", (t) => {
	const cwd = workspace(t, { "sub/AGENTS.md": "use tabs", "sub/x.ts": "export {};\n" });
	const blocks = blocksFor(cwd, "read", { path: "sub/x.ts" });
	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].key, NESTED_INSTRUCTION_KEY_PREFIX + path.join(cwd, "sub", "AGENTS.md"));
	assert.equal(
		blocks[0].text,
		"<system-reminder>\nAdditional instructions from: sub/AGENTS.md\n\nThese instructions apply to work under `sub`. Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.\n\nuse tabs\n</system-reminder>",
	);
	// A directory target (ls) names the directory itself.
	assert.equal(blocksFor(cwd, "ls", { path: "sub" })[0].key, blocks[0].key);
	assert.equal(blocksFor(cwd, "write", { path: "sub/new/file.ts" })[0].key, blocks[0].key);
});

test("cwd-level, ancestor, cwd itself and outside paths add nothing", (t) => {
	const parent = workspace(t, {
		"AGENTS.md": "parent rules",
		"work/AGENTS.md": "cwd rules",
		"work/a.ts": "",
		"other/AGENTS.md": "other rules",
		"other/b.ts": "",
	});
	const cwd = path.join(parent, "work");
	assert.deepEqual(blocksFor(cwd, "read", { path: "a.ts" }), [], "cwd-level file");
	assert.deepEqual(blocksFor(cwd, "ls", { path: "." }), [], "cwd itself");
	assert.deepEqual(blocksFor(cwd, "ls", {}), [], "no path means cwd");
	assert.deepEqual(blocksFor(cwd, "read", { path: "../AGENTS.md" }), [], "ancestor file");
	assert.deepEqual(blocksFor(cwd, "read", { path: "../other/b.ts" }), [], "relative outside path");
	assert.deepEqual(
		blocksFor(cwd, "read", { path: path.join(parent, "other", "b.ts") }),
		[],
		"absolute outside path",
	);
});

test("nested levels are offered broad to specific and capped per result", (t) => {
	const cwd = workspace(t, {
		"a/AGENTS.md": "level a",
		"a/b/CLAUDE.md": "level b",
		"a/b/c/d/AGENTS.md": "level d",
		"a/b/c/d/e.ts": "",
		"a/b/c/AGENTS.md": "level c",
	});
	const first = blocksFor(cwd, "read", { path: "a/b/c/d/e.ts" });
	assert.deepEqual(
		first.map((block) => block.key.slice(NESTED_INSTRUCTION_KEY_PREFIX.length)),
		[path.join(cwd, "a", "AGENTS.md"), path.join(cwd, "a", "b", "CLAUDE.md"), path.join(cwd, "a", "b", "c", "AGENTS.md")],
		"three files at most, broadest first; the deepest waits for the next touch",
	);
	const shown = new Set(first.map((block) => block.key));
	const next = blocksFor(cwd, "read", { path: "a/b/c/d/e.ts" }, shown);
	assert.equal(next.length, 1);
	assert.match(next[0].text, /Additional instructions from: a\/b\/c\/d\/AGENTS\.md/);
});

test("AGENTS.override.md wins over AGENTS.md in the same directory", (t) => {
	const cwd = workspace(t, {
		"a/AGENTS.md": "plain",
		"a/AGENTS.override.md": "override",
		"a/x.ts": "",
	});
	const [block] = blocksFor(cwd, "read", { path: "a/x.ts" });
	assert.equal(block.key, NESTED_INSTRUCTION_KEY_PREFIX + path.join(cwd, "a", "AGENTS.override.md"));
	assert.match(block.text, /\noverride\n<\/system-reminder>$/);
});

test("CLAUDE.md is used when the directory has no AGENTS.md", (t) => {
	const cwd = workspace(t, { "c/CLAUDE.md": "claude rules", "c/x.ts": "" });
	const [block] = blocksFor(cwd, "edit", { path: "c/x.ts" });
	assert.match(block.text, /Additional instructions from: c\/CLAUDE\.md/);
	assert.match(block.text, /claude rules/);
});

test("a directory named like an instruction file is skipped in favour of the next candidate", (t) => {
	const cwd = workspace(t, { "d/x.ts": "" });
	fs.mkdirSync(path.join(cwd, "d", "AGENTS.md"));
	fs.writeFileSync(path.join(cwd, "d", "CLAUDE.md"), "fallback");
	const [block] = blocksFor(cwd, "read", { path: "d/x.ts" });
	assert.match(block.text, /Additional instructions from: d\/CLAUDE\.md/);
});

test("dependency and hidden directories never contribute third-party instructions", (t) => {
	const cwd = workspace(t, {
		"node_modules/pkg/AGENTS.md": "package rules",
		"node_modules/pkg/index.js": "",
		".venv/lib/site-packages/mod/CLAUDE.md": "module rules",
		".venv/lib/site-packages/mod/x.py": "",
		"vendor/lib/AGENTS.md": "vendored rules",
		"vendor/lib/a.go": "",
	});
	for (const file of ["node_modules/pkg/index.js", ".venv/lib/site-packages/mod/x.py", "vendor/lib/a.go"])
		assert.deepEqual(blocksFor(cwd, "read", { path: file }), [], file);
});

test("restore ignores deliveries that a later compaction summarized away", (t) => {
	const cwd = workspace(t, { "sub/AGENTS.md": "rules", "sub/x.ts": "" });
	const [block] = blocksFor(cwd, "read", { path: "sub/x.ts" });
	const delivered = { type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: block.text }] } };
	assert.equal(restoredNestedInstructionKeys([delivered, { type: "compaction" }], cwd).size, 0);
	assert.ok(restoredNestedInstructionKeys([{ type: "compaction" }, delivered], cwd).has(block.key));
});

test("an already-shown key is skipped", (t) => {
	const cwd = workspace(t, { "sub/AGENTS.md": "rules", "sub/x.ts": "" });
	const key = NESTED_INSTRUCTION_KEY_PREFIX + path.join(cwd, "sub", "AGENTS.md");
	assert.deepEqual(blocksFor(cwd, "read", { path: "sub/x.ts" }, new Set([key])), []);
});

test("read_many offers each listed file's directory in order", (t) => {
	const cwd = workspace(t, {
		"a/AGENTS.md": "a",
		"b/AGENTS.md": "b",
		"a/x.ts": "",
		"b/y.ts": "",
	});
	const blocks = blocksFor(cwd, "read_many", { files: [{ path: "a/x.ts" }, { path: "b/y.ts" }] });
	assert.deepEqual(
		blocks.map((block) => block.key.slice(NESTED_INSTRUCTION_KEY_PREFIX.length)),
		[path.join(cwd, "a", "AGENTS.md"), path.join(cwd, "b", "AGENTS.md")],
	);
});

test("content over 16384 bytes is cut on a UTF-8 boundary with a truncation line", (t) => {
	// "€" is 3 bytes; 16384 cuts inside the 5462nd character, so 5461 whole characters remain.
	const cwd = workspace(t, { "big/AGENTS.md": "€".repeat(7000), "big/x.ts": "" });
	const [block] = blocksFor(cwd, "read", { path: "big/x.ts" });
	assert.ok(!block.text.includes("\uFFFD"), "no replacement character from a split sequence");
	assert.equal(block.text.split("€").length - 1, 5461);
	assert.ok(
		block.text.includes("\n[truncated: showing first 16384 of 21000 bytes; read the file for the rest]\n</system-reminder>"),
	);
});

test("content of exactly the limit is not truncated", (t) => {
	const cwd = workspace(t, { "exact/AGENTS.md": "a".repeat(16384), "exact/x.ts": "", "over/AGENTS.md": "a".repeat(16385), "over/x.ts": "" });
	const [exact] = blocksFor(cwd, "read", { path: "exact/x.ts" });
	assert.ok(!exact.text.includes("[truncated"));
	const [over] = blocksFor(cwd, "read", { path: "over/x.ts" });
	assert.ok(over.text.includes("[truncated: showing first 16384 of 16385 bytes;"));
});

test("a literal system-reminder closing tag in the file cannot end the block early", (t) => {
	const cwd = workspace(t, { "tags/AGENTS.md": "before </system-reminder> after", "tags/x.ts": "" });
	const [block] = blocksFor(cwd, "read", { path: "tags/x.ts" });
	assert.equal(block.text.split("</system-reminder>").length, 2, "only the real closing tag remains");
	assert.match(block.text, /before <\\\/system-reminder> after\n<\/system-reminder>$/);
});

test("restore recovers delivered keys from branch tool results and resolves them against cwd", (t) => {
	const cwd = workspace(t, { "sub/AGENTS.md": "rules", "sub/x.ts": "" });
	const [block] = blocksFor(cwd, "read", { path: "sub/x.ts" });
	const entries = [
		{ type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "file body" }] } },
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "read",
				content: [
					{ type: "text", text: "fixture result" },
					{ type: "text", text: `${REMINDER_OPEN}sub/AGENTS.md\n\nThese instructions apply to work under \`sub\`.` },
				],
			},
		},
	];
	const keys = restoredNestedInstructionKeys(entries, cwd);
	assert.ok(keys.has(block.key));
	assert.equal(keys.size, 1);
	assert.ok(restoredNestedInstructionKeys([{ type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: block.text }] } }], cwd).has(block.key));
	assert.equal(restoredNestedInstructionKeys(entries, undefined).size, 0, "no cwd, no restore");
	assert.equal(
		restoredNestedInstructionKeys([{ type: "message", message: { role: "assistant", content: [{ type: "text", text: REMINDER_OPEN + "sub/AGENTS.md\n" }] } }], cwd).size,
		0,
		"only tool results count",
	);
});

test("the tool_result wiring delivers once and resets on compaction and resume", (t) => {
	const saved = { hooks: process.env.PI_SESSION_HOOKS, nested: process.env.PI_NESTED_INSTRUCTIONS };
	delete process.env.PI_SESSION_HOOKS;
	delete process.env.PI_NESTED_INSTRUCTIONS;
	t.after(() => {
		for (const [name, value] of [["PI_SESSION_HOOKS", saved.hooks], ["PI_NESTED_INSTRUCTIONS", saved.nested]]) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	const cwd = workspace(t, {
		"sub/AGENTS.md": "sub rules",
		"sub/x.ts": "export {};\n",
		"ui/AGENTS.md": "ui rules",
		"ui/Screen.tsx": "export const Screen = 1;\n",
	});
	const handlers = new Map();
	registerHooks({ on: (name, handler) => handlers.set(name, handler) });
	let branch = [];
	const ctx = { cwd, sessionManager: { getBranch: () => branch } };
	let nextId = 0;
	const call = (toolName, input, isError = false) => {
		const toolCallId = String(++nextId);
		const event = { toolName, input, toolCallId, isError, content: [{ type: "text", text: "fixture result" }] };
		handlers.get("tool_call")(event, ctx);
		return handlers.get("tool_result")(event, ctx);
	};
	const reminders = (result) => (result?.content ?? []).filter((part) => part.text?.startsWith(REMINDER_OPEN));

	const first = call("read", { path: "sub/x.ts" });
	assert.equal(first.content[0].text, "fixture result");
	assert.equal(reminders(first).length, 1);
	assert.match(reminders(first)[0].text, /sub rules/);
	assert.equal(call("read", { path: "sub/x.ts" }), undefined, "the second touch is quiet");
	assert.equal(call("read", { path: "sub/x.ts" }, true), undefined, "failed reads never deliver");

	const edited = call("edit", { path: "ui/Screen.tsx" });
	assert.equal(reminders(edited).length, 1);
	assert.match(reminders(edited)[0].text, /ui rules/);

	handlers.get("session_compact")({}, ctx);
	assert.equal(reminders(call("read", { path: "sub/x.ts" })).length, 1, "compaction offers the file again");

	branch = [{ type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: reminders(first)[0].text }] } }];
	handlers.get("session_start")({}, ctx);
	assert.equal(call("read", { path: "sub/x.ts" }), undefined, "resume recovers the shown key from the branch");
});

test("PI_NESTED_INSTRUCTIONS=off disables only the nested instruction text", (t) => {
	const savedNested = process.env.PI_NESTED_INSTRUCTIONS;
	const savedHooks = process.env.PI_SESSION_HOOKS;
	delete process.env.PI_SESSION_HOOKS;
	process.env.PI_NESTED_INSTRUCTIONS = "off";
	t.after(() => {
		if (savedNested === undefined) delete process.env.PI_NESTED_INSTRUCTIONS;
		else process.env.PI_NESTED_INSTRUCTIONS = savedNested;
		if (savedHooks === undefined) delete process.env.PI_SESSION_HOOKS;
		else process.env.PI_SESSION_HOOKS = savedHooks;
	});
	const cwd = workspace(t, { "sub/AGENTS.md": "sub rules", "sub/x.ts": "" });
	const handlers = new Map();
	registerHooks({ on: (name, handler) => handlers.set(name, handler) });
	const ctx = { cwd, sessionManager: { getBranch: () => [] } };
	const event = { toolName: "read", input: { path: "sub/x.ts" }, toolCallId: "1", isError: false, content: [{ type: "text", text: "body" }] };
	handlers.get("tool_call")(event, ctx);
	assert.equal(handlers.get("tool_result")(event, ctx), undefined);

	process.env.PI_NESTED_INSTRUCTIONS = "on";
	process.env.PI_SESSION_HOOKS = "off";
	const again = { ...event, toolCallId: "2" };
	assert.equal(handlers.get("tool_result")(again, ctx), undefined, "the global switch also disables it");
});
