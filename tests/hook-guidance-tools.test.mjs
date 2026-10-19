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
	assert.ok(known.size > 80, "inventory names the tool universe");
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
});

console.log(
	"PASS hook-guidance-tools: hook rules and guidance name only registered tools",
);
