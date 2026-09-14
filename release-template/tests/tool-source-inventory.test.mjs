import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const templateRoot = path.resolve(import.meta.dirname, "..");
const agentRoot = [path.join(templateRoot, "agent"), path.resolve(templateRoot, "..")].find((directory) =>
	fs.existsSync(path.join(directory, "extensions", "manifest.json")),
);
assert.ok(agentRoot, "public extension manifest is present");
const projectRoot = path.basename(agentRoot) === "agent" ? path.dirname(agentRoot) : agentRoot;
const inventoryModule = path.join(agentRoot, "scripts", "lib", "tool-source-inventory.mjs");
assert.ok(fs.existsSync(inventoryModule), "source inventory helper is present");
const { collectToolSourceInventory } = await import(pathToFileURL(inventoryModule));

const EXPECTED_STABLE_NAMES = [
	"archive_probe", "artifact_check", "ast_diff", "audio_analyze", "bash", "bg_kill", "bg_logs", "bg_run", "bg_status", "bg_wait",
	"browser_session", "bulk_edit", "checkpoint_read", "contact_supervisor", "context_score", "context_slice", "contract_diff", "coverage_probe",
	"coverage_select", "data_query", "decision_frontier", "dependency_plan", "env_audit", "evidence_cache", "fetch_content", "get_search_content",
	"git_info", "handoff_capsule", "http_request", "math_check", "media_edit", "media_info", "memory_forget", "memory_read", "memory_restore",
	"memory_search", "memory_status", "memory_write", "music_compose", "net_probe", "obs_read", "openapi_probe", "package_probe", "process",
	"project_intel", "quality_review", "render_see", "sandbox_run", "scratchpad", "session_audit", "session_coordinate", "session_self",
	"skill_review", "source_check", "sqlite_probe", "structured_output", "subagent", "subagent_supervisor", "symbol_expand", "syntax_check",
	"sys_probe", "todo", "tool_search", "value_convert", "video_frames", "wait_for", "web_probe", "web_research", "web_search", "workdir_snapshot",
];

test("inventory enumerates source-backed registrations, factories, catalogs, and defaults", () => {
	const inventory = collectToolSourceInventory(projectRoot);
	const names = new Set(inventory.literalRegistrations.map((row) => row.name));
	for (const name of EXPECTED_STABLE_NAMES) assert.ok(names.has(name), `missing stable source name: ${name}`);
	assert.ok(inventory.literalRegistrations.length >= EXPECTED_STABLE_NAMES.length);
	assert.equal(inventory.coverage.uniqueStableTools, names.size);
	assert.equal(inventory.coverage.stableRegistrationRows, inventory.literalRegistrations.length);
	assert.equal(inventory.coverage.registrationSites, inventory.coverage.indirectRegistrationSites +
		inventory.literalRegistrations.filter((row) => row.kind === "literal").length);
	assert.ok(inventory.literalRegistrations.some((row) => row.name === "math_check" && row.kind === "factory"));
	assert.ok(inventory.literalRegistrations.some((row) => row.name === "sqlite_probe" && row.kind === "catalog"));
	assert.ok(inventory.literalRegistrations.some((row) => row.name === "context_slice" && row.kind === "definition"));
	assert.ok(inventory.literalRegistrations.some((row) => row.name === "web_search" && row.kind === "configured-default" && row.configurable === true));
	assert.ok(inventory.literalRegistrations.some((row) => row.name === "bash" && row.kind === "sdk-factory"));
});

test("inventory reports indirect owners while excluding generated bundles", () => {
	const inventory = collectToolSourceInventory(agentRoot);
	const owners = new Map(inventory.dynamicOwners.map((owner) => [owner.source, owner]));
	for (const source of [
		"agent/extensions/lib/small-tools.ts",
		"agent/extensions/media-tools.ts",
		"agent/extensions/pi-lens/context-tools.ts",
		"agent/extensions/pi-subagents/src/extension/index.ts",
		"agent/extensions/pi-subagents/src/intercom/native-supervisor-channel.ts",
		"agent/extensions/pi-web-access/index.ts",
		"agent/extensions/utility-tools.ts",
	]) assert.ok(owners.has(source), `missing indirect owner: ${source}`);
	assert.ok(!inventory.dynamicOwners.some((owner) => owner.source.includes("/dist/")));
	assert.ok(owners.get("agent/extensions/utility-tools.ts").knownNames.includes("archive_probe"));
	assert.ok(owners.get("agent/extensions/rpiv-todo/todo.ts").knownNames.includes("todo"));
	for (const row of [...inventory.literalRegistrations, ...inventory.dynamicOwners]) {
		assert.match(row.source, /^agent\//);
		assert.ok(!path.isAbsolute(row.source));
		assert.ok(fs.existsSync(path.join(projectRoot, row.source)) || fs.existsSync(path.join(projectRoot, row.source.slice("agent/".length))));
	}
	assert.doesNotMatch(JSON.stringify(inventory), /\/home\/|\/Users\/|\/root\//);
});

test("inventory is deterministic and does not promote arbitrary name properties", () => {
	const first = collectToolSourceInventory(projectRoot);
	const second = collectToolSourceInventory(projectRoot);
	assert.deepEqual(first, second);

	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tool-source-inventory-"));
	try {
		const extensions = path.join(tempRoot, "extensions");
		fs.mkdirSync(extensions, { recursive: true });
		fs.writeFileSync(path.join(extensions, "manifest.json"), "{}\n");
		fs.writeFileSync(path.join(extensions, "fixture.ts"), `
const unrelated = { name: "false_positive" };
pi.registerTool({ name: "missing_shape" });
pi.registerTool({ name: "fixture_tool", parameters: {}, async execute() {} });
`);
		const fixture = collectToolSourceInventory(tempRoot);
		assert.ok(fixture.literalRegistrations.some((row) => row.name === "fixture_tool"));
		assert.ok(!fixture.literalRegistrations.some((row) => row.name === "false_positive"));
		assert.ok(!fixture.literalRegistrations.some((row) => row.name === "missing_shape"));
		assert.equal(fixture.dynamicOwners.length, 1);
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
});

console.log("PASS tool-source-inventory: deterministic source-only registrations, factories, catalogs and dynamic owners");
