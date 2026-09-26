import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const agent = [path.join(root, "agent"), path.resolve(root, "..")].find((p) =>
	fs.existsSync(path.join(p, "extensions/lib/session-hooks.ts")),
);
const load = (p) => import(pathToFileURL(path.join(agent, "extensions", p)));
const { HOOK_RULES, matchHook } = await load("lib/session-hooks.ts");
const { createRelevantGuidance } = await load("lib/relevant-guidance.ts");

function registeredTools() {
	const metadata = JSON.parse(
		fs.readFileSync(path.join(root, "docs/CAPABILITIES.json"), "utf8"),
	);
	const names = new Set(metadata.tools.nativeCore);
	for (const row of [
		...metadata.tools.literalRegistrations,
		...metadata.tools.stableRegistrations,
	])
		names.add(row.name);
	for (const owner of metadata.tools.dynamicOwners)
		for (const name of owner.knownNames ?? []) names.add(name);
	return names;
}

test("session-hook rules bind only to registered tools", () => {
	const known = registeredTools();
	assert.ok(known.size > 100, "inventory names the tool universe");
	for (const rule of HOOK_RULES) {
		assert.ok(rule.key && rule.line, "rule has a key and a line");
		assert.ok(rule.tools.length, `${rule.key} binds to at least one tool`);
		for (const tool of rule.tools)
			assert.ok(
				known.has(tool),
				`${rule.key} binds to ${tool}, which is not a registered tool or native core tool`,
			);
	}
});

test("session-hook guidance never names the retired context_code tool", () => {
	for (const rule of HOOK_RULES)
		assert.ok(
			!rule.line.includes("context_code"),
			`${rule.key} guides the agent to context_code, which is not a registered tool`,
		);
	const fuzzy = HOOK_RULES.find((rule) => rule.key === "search-fuzzy");
	assert.ok(fuzzy, "search-fuzzy rule survives the cleanup");
	assert.match(fuzzy.line, /symbol_search/);
	assert.equal(matchHook("grep", {})?.key, "search-fuzzy");
	assert.equal(matchHook("find", {})?.key, "search-fuzzy");
	assert.equal(fuzzy.needsEmptyResult, true);
});

test("repeated-read guidance never offers the retired context_code tool", () => {
	const entries = [];
	const ctx = { cwd: "/hook/tools", sessionManager: { getBranch: () => entries } };
	const g = createRelevantGuidance({
		getActiveTools: () => ["context_code", "read"],
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
	});
	g.restore(ctx);
	g.userInput();
	g.start({ prompt: "fix the bug", systemPrompt: "" }, ctx);
	for (const file of ["src/a.ts", "src/b.ts"]) {
		g.record({
			toolName: "read",
			input: { path: file },
			content: [{ type: "text", text: `// ${file}\n` + "x".repeat(9000) }],
			isError: false,
		});
	}
	for (const hint of g.candidates()) {
		assert.ok(!hint.text.includes("context_code"), hint.text.slice(0, 120));
		assert.notEqual(hint.tool, "context_code");
	}
});

test("semantic packet guidance requires a matching task and an active helper", () => {
 for (const [prompt, active, expected] of [
  ["Rank candidates and categorize the findings", true, true],
  ["Rank candidates and categorize the findings", false, false],
  ["Explain what ranking means", true, false],
  ["Do not use tools to compare options", true, false],
 ]) {
  const ctx = { cwd: "/hook/tools", sessionManager: { getBranch: () => [] } };
  const g = createRelevantGuidance({ getActiveTools: () => active ? ["micro_task"] : [], appendEntry() {} });
  g.restore(ctx); g.userInput(); g.start({ prompt, systemPrompt: "" }, ctx);
  assert.equal(g.candidates().some(hint => hint.tool === "micro_task"), expected, prompt);
 }
});

console.log(
	"PASS hook-guidance-tools: hook rules and guidance name only registered tools",
);
