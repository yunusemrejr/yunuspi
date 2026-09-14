import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const templateRoot = path.resolve(import.meta.dirname, "..");
const agentRoot = [
	path.join(templateRoot, "agent"),
	path.resolve(templateRoot, ".."),
].find((dir) => fs.existsSync(path.join(dir, "extensions", "manifest.json")));
assert.ok(agentRoot, "public manifest is present");
const projectRoot =
	path.basename(agentRoot) === "agent" ? path.dirname(agentRoot) : agentRoot;
const generator = path.join(
	agentRoot,
	"scripts",
	"generate-capabilities-doc.mjs",
);
const layoutRoot = fs.existsSync(path.join(projectRoot, "release-template"))
	? projectRoot
	: agentRoot;
const output = fs.existsSync(path.join(projectRoot, "release-template"))
	? path.join(projectRoot, "release-template", "docs", "CAPABILITIES.md")
	: path.join(agentRoot, "public-template", "docs", "CAPABILITIES.md");
const metadataPath = output.replace(/\.md$/i, ".json");
const distributionOutput = fs.existsSync(
	path.join(projectRoot, "release-template"),
)
	? path.join(projectRoot, "docs", "CAPABILITIES.md")
	: undefined;

test("capability inventory is deterministic, complete, and generated from public source", async () => {
	const check = spawnSync(
		process.execPath,
		[generator, "--root", layoutRoot, "--check"],
		{ encoding: "utf8" },
	);
	assert.equal(check.status, 0, check.stderr || check.stdout);
	assert.ok(fs.existsSync(output));
	assert.ok(fs.existsSync(metadataPath));
	if (distributionOutput) {
		assert.ok(
			fs.existsSync(distributionOutput),
			"export root inventory is generated alongside release-template",
		);
		assert.ok(fs.existsSync(distributionOutput.replace(/\.md$/i, ".json")));
	}

	const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
	const catalog = await import(
		pathToFileURL(path.join(agentRoot, "extensions/lib/harness-capabilities.ts"))
	);
	assert.equal(metadata.schemaVersion, 1);
	assert.equal(
		metadata.capabilities.length,
		catalog.HARNESS_CAPABILITIES.length,
	);
	assert.ok(
		metadata.capabilities.every(
			(record) => record.id && record.sourceFiles.length && record.doc,
		),
	);
	assert.ok(
		metadata.capabilities.every((record) => record.doc.startsWith("docs/")),
		"JSON documentation paths are relative to the public repository root",
	);
	assert.ok(
		metadata.tools.literalRegistrations.some(
			(item) => item.name === "tool_search",
		),
	);
	for (const name of [
		"data_query",
		"sqlite_probe",
		"video_frames",
		"todo",
		"context_slice",
		"subagent",
		"web_search",
	])
		assert.ok(
			metadata.tools.stableRegistrations.some((item) => item.name === name),
			`${name} is documented despite factory registration`,
		);
	assert.equal(metadata.tools.nativeCore.length, 7);
	assert.ok(
		metadata.tools.dynamicOwners.some((item) =>
			item.source.includes("utility-tools.ts"),
		),
	);
	assert.ok(
		metadata.tools.commandRegistrations.some((item) => item.name === "reminder"),
	);
	assert.ok(metadata.inventory.extensions.length >= 20);
	assert.ok(metadata.inventory.libraries.length >= 50);
	// Regression: manifest entries are relative to their own directory, so every
	// registered extension/library must resolve and render as a link. Resolving
	// them against the agent root mislabelled all 98 as "missing from source tree".
	for (const item of [
		...metadata.inventory.extensions,
		...metadata.inventory.libraries,
	])
		assert.equal(
			item.exists,
			true,
			`${item.path} must resolve from the manifest entry`,
		);
	assert.ok(metadata.inventory.forks.length >= 5);
	assert.ok(metadata.inventory.skills.length >= 100);
	assert.ok(
		metadata.inventory.patchModules.some((item) =>
			item.path.endsWith("autonomous-recovery.mjs"),
		),
	);
	assert.ok(
		metadata.inventory.serviceOwners.some((item) => item.signals.includes("MCP")),
	);

	const markdown = fs.readFileSync(output, "utf8");
	for (const record of catalog.HARNESS_CAPABILITIES)
		assert.match(markdown, new RegExp(`#### ${record.id}\\n`));
	assert.match(markdown, /Computed registration names are listed as owners/);
	assert.match(markdown, /runtime availability still depends on the host/);
	const inventorySection = markdown.slice(
		markdown.indexOf("## Extension source inventory"),
	);
	assert.doesNotMatch(
		inventorySection,
		/missing from source tree/,
		"registered source must not be reported missing",
	);
	for (const file of [
		output,
		...(distributionOutput ? [distributionOutput] : []),
	]) {
		const text = fs.readFileSync(file, "utf8");
		for (const match of text.matchAll(/\]\(([^)#]+)\)/g))
			assert.ok(
				fs.existsSync(path.resolve(path.dirname(file), match[1])),
				`${file}: ${match[1]}`,
			);
	}
});

test("inventory generator does not write outside its requested template", () => {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-capabilities-check-"));
	const customOutput = path.join(temp, "CAPABILITIES.md");
	const result = spawnSync(
		process.execPath,
		[generator, "--root", layoutRoot, "--output", customOutput],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.ok(fs.existsSync(customOutput));
	assert.ok(fs.existsSync(customOutput.replace(/\.md$/i, ".json")));
});

console.log(
	"PASS capabilities-inventory: deterministic source-backed catalog, registrations, services and manifest inventory",
);
