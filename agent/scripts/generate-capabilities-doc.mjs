#!/usr/bin/env node
/**
 * Build the public capability inventory from the sanitized source tree.
 *
 * The exporter runs this after it has copied the public source and release
 * template.  It intentionally reads only manifest/catalog/source files under
 * that tree; it never consults settings, sessions, credentials, or the live
 * tool registry.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { collectToolSourceInventory } from "./lib/tool-source-inventory.mjs";

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKILL_FILE = "SKILL.md";

function parseArgs(argv) {
	let root;
	let output;
	let metadata;
	let check = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--root" && argv[i + 1]) root = path.resolve(argv[++i]);
		else if (arg === "--output" && argv[i + 1]) output = path.resolve(argv[++i]);
		else if (arg === "--metadata" && argv[i + 1]) metadata = path.resolve(argv[++i]);
		else if (arg === "--check") check = true;
		else throw new Error("Usage: generate-capabilities-doc.mjs --root ROOT [--output FILE] [--metadata FILE] [--check]");
	}
	return { root: root ?? process.cwd(), output, metadata, check };
}

function locateLayout(inputRoot) {
	const root = path.resolve(inputRoot);
	const liveManifest = path.join(root, "extensions", "manifest.json");
	if (fs.existsSync(liveManifest)) {
		const templateRoot = fs.existsSync(path.join(root, "public-template"))
			? path.join(root, "public-template")
			: path.join(root, "release-template");
		return { projectRoot: path.dirname(root), agentRoot: root, templateRoot };
	}
	const agentRoot = path.join(root, "agent");
	if (fs.existsSync(path.join(agentRoot, "extensions", "manifest.json"))) {
		const templateRoot = fs.existsSync(path.join(root, "release-template"))
			? path.join(root, "release-template")
			: path.join(root, "public-template");
		return { projectRoot: root, agentRoot, templateRoot };
	}
	throw new Error(`Cannot find extensions/manifest.json below ${root}`);
}

function walkFiles(directory) {
	if (!fs.existsSync(directory)) return [];
	const result = [];
	const visit = (current) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			if (["node_modules", ".git", "sessions", "logs", "memory", "backups", "artifacts", "worktrees"].includes(entry.name)) continue;
			const absolute = path.join(current, entry.name);
			if (entry.isDirectory()) visit(absolute);
			else if (entry.isFile()) result.push(absolute);
		}
	};
	visit(directory);
	return result.sort((a, b) => a.localeCompare(b));
}

function rel(from, absolute) {
	return path.relative(from, absolute).replaceAll(path.sep, "/");
}

function canonicalAgentPath(agentRoot, absolute) {
	return `agent/${rel(agentRoot, absolute)}`;
}

function canonicalTemplatePath(docsRoot, absolute) {
	return `docs/${rel(docsRoot, absolute)}`;
}

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function importCatalog(catalogPath) {
	// The public source catalog is TypeScript.  Use Node's built-in type
	// stripping in a short child process so this generator stays dependency
	// free and works in a sanitized export.
	const source = [
		"import { pathToFileURL } from 'node:url';",
		"const module = await import(pathToFileURL(process.argv[1]).href);",
		"process.stdout.write(JSON.stringify(module.HARNESS_CAPABILITIES));",
	].join(" ");
	const result = spawnSync(process.execPath, [
		"--no-warnings",
		"--experimental-strip-types",
		"--input-type=module",
		"-e",
		source,
		catalogPath,
	], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`Unable to load harness-capabilities.ts: ${result.stderr || result.stdout}`);
	try {
		const value = JSON.parse(result.stdout);
		if (!Array.isArray(value)) throw new Error("catalog is not an array");
		return value;
	} catch (error) {
		throw new Error(`Unable to parse harness capability catalog: ${error.message}`);
	}
}

function commandSourceInventory(agentRoot) {
	const sourceFiles = walkFiles(path.join(agentRoot, "extensions"))
		.filter((file) => CODE_EXTENSIONS.has(path.extname(file).toLowerCase()));
	const commandRegistrations = [];
	const commandDynamicOwners = new Map();

	for (const file of sourceFiles) {
		const text = fs.readFileSync(file, "utf8");
		const source = canonicalAgentPath(agentRoot, file);
		const lines = text.split(/\r?\n/);
		const addDynamic = (map, signal, line) => {
			const item = map.get(source) ?? { source, signals: new Set(), lines: new Set() };
			item.signals.add(signal);
			if (line > 0) item.lines.add(line);
			map.set(source, item);
		};


		for (let index = 0; index < lines.length; index++) {
			const line = lines[index];
			const match = /\b(?:pi\.)?registerCommand\s*(?:\?\.)?\s*\(\s*(['"])([^'"\r\n]+)\1/.exec(line);
			if (match) commandRegistrations.push({ name: match[2], source, line: index + 1 });
			else if (/\b(?:pi\.)?registerCommand\s*(?:\?\.)?\s*\(/.test(line)) addDynamic(commandDynamicOwners, "registerCommand() receives a computed name", index + 1);
		}
	}

	const unique = (rows, keys) => {
		const seen = new Set();
		return rows.filter((row) => {
			const key = keys.map((field) => row[field]).join("\u0000");
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		}).sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source) || a.line - b.line);
	};
	const dynamic = (map) => [...map.values()]
		.map((item) => ({ source: item.source, signals: [...item.signals].sort(), lines: [...item.lines].sort((a, b) => a - b) }))
		.sort((a, b) => a.source.localeCompare(b.source));

	return {
		commandRegistrations: unique(commandRegistrations, ["name", "source"]),
		commandDynamicOwners: dynamic(commandDynamicOwners),
	};
}

function serviceOwners(agentRoot) {
	const files = walkFiles(path.join(agentRoot, "extensions"))
		.filter((file) => CODE_EXTENSIONS.has(path.extname(file).toLowerCase()));
	const owners = [];
	for (const file of files) {
		const source = canonicalAgentPath(agentRoot, file);
		const text = fs.readFileSync(file, "utf8");
		const signals = new Set();
		if (/(?:^|[/\\])[^/\\]*mcp[^/\\]*(?:[/\\]|$)/i.test(rel(agentRoot, file)) || /\bMCP\b|mcpConfig|mcpDirectTools|mcp-server|mcp server/i.test(text)) signals.add("MCP");
		if (/(?:wrapper|adapter|client)/i.test(path.basename(file)) || /\b(?:wrapper|adapter|client)\b/i.test(text) && /registerTool|spawn\(|fetch\(/.test(text)) signals.add("wrapper/adapter");
		if (signals.size) owners.push({ source, signals: [...signals].sort() });
	}
	return owners.sort((a, b) => a.source.localeCompare(b.source));
}

function manifestInventory(agentRoot, manifest) {
	// Manifest entries are relative to their own directory (`extensions/`, or
	// `extensions/lib/` for libraries) and to the agent root for support files;
	// resolving every list against the agent root mislabels them as missing.
	const existing = (value, base = "") => {
		const relative = String(value).replace(/^agent\//, "");
		const target = base ? path.join(base, relative) : relative;
		return {
			path: `agent/${target.replaceAll(path.sep, "/")}`,
			exists: fs.existsSync(path.join(agentRoot, target)),
		};
	};
	const list = (values, base = "") => (Array.isArray(values) ? values.map((value) => existing(value, base)).sort((a, b) => a.path.localeCompare(b.path)) : []);
	const forks = Object.entries(manifest.forks ?? {}).map(([key, packageName]) => ({
		path: `agent/${key.replace(/^agent\//, "").replaceAll(path.sep, "/")}`,
		package: packageName,
		exists: fs.existsSync(path.join(agentRoot, key.replace(/^agent\//, ""))),
	})).sort((a, b) => a.path.localeCompare(b.path));
	const patches = walkFiles(path.join(agentRoot, "scripts", "patches"))
		.map((file) => ({ path: canonicalAgentPath(agentRoot, file), kind: path.extname(file).slice(1) }))
		.sort((a, b) => a.path.localeCompare(b.path));
	return {
		extensions: list(manifest.extensions, "extensions"),
		libraries: list(manifest.lib, "extensions/lib"),
		forks,
		supportFiles: list(manifest.supportFiles),
		patchModules: patches,
		foldedMarkers: (manifest.foldedMarkers ?? []).map((item) => ({ ...item })).sort((a, b) => String(a.file).localeCompare(String(b.file))),
		vendoredDependencies: [...(manifest.vendoredDeps ?? [])].sort(),
		npmPackages: [...(manifest.npmPackages ?? [])].sort(),
		retired: (manifest.retired ?? []).map((item) => ({ name: item.name, retired: item.retired, why: item.why })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
	};
}

function skillsInventory(agentRoot) {
	return walkFiles(path.join(agentRoot, "skills"))
		.filter((file) => path.basename(file) === SKILL_FILE)
		.map((file) => ({
			name: path.basename(path.dirname(file)),
			path: canonicalAgentPath(agentRoot, file),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

function docsInventory(docsRoot) {
	return walkFiles(docsRoot)
		.filter((file) => path.extname(file).toLowerCase() === ".md" && path.basename(file) !== "CAPABILITIES.md")
		.map((file) => ({ name: path.basename(file), path: canonicalTemplatePath(docsRoot, file) }))
		.sort((a, b) => a.path.localeCompare(b.path));
}

function resolveReference(layout, reference) {
	const value = String(reference).replaceAll("\\", "/");
	if (value.startsWith("agent/public-template/docs/")) return path.join(layout.docsRoot, value.slice("agent/public-template/docs/".length));
	if (value.startsWith("agent/public-template/")) return path.join(layout.templateRoot, value.slice("agent/public-template/".length));
	if (value.startsWith("agent/")) return path.join(layout.projectRoot, value);
	if (value.startsWith("docs/")) return path.join(layout.docsRoot, value.slice("docs/".length));
	if (value.startsWith("extensions/") || value.startsWith("scripts/") || value.startsWith("skills/")) return path.join(layout.agentRoot, value);
	return path.join(layout.projectRoot, value);
}

function link(layout, output, reference, label = reference) {
	const target = resolveReference(layout, reference);
	if (!fs.existsSync(target)) return `\`${label}\` (missing from sanitized source)`;
	const href = rel(path.dirname(output), target);
	return `[\`${label}\`](${href || "."})`;
}

function listItems(values, render) {
	return values.length ? values.map((value) => `- ${render(value)}`).join("\n") : "- _None recorded in the manifest/source tree._";
}

function layoutForOutput(layout, output) {
	const rootDocs = path.join(layout.projectRoot, "docs");
	const templateDocs = path.join(layout.templateRoot, "docs");
	return {
		...layout,
		docsRoot: path.dirname(output) === rootDocs ? rootDocs : templateDocs,
	};
}

function capabilityMarkdown(layout, output, records, tools, inventory, skills, docs) {
	const groups = new Map();
	for (const record of records) {
		const list = groups.get(record.group) ?? [];
		list.push(record);
		groups.set(record.group, list);
	}
	const lines = [
		"# Capability inventory",
		"",
		"> Generated from the sanitized public source tree by `agent/scripts/generate-capabilities-doc.mjs`. This is a source inventory: it records literal registrations and named dynamic owners, while runtime availability still depends on the host, configuration, permissions, and optional dependencies.",
		"",
		"The inventory is intentionally maintainable from two public authorities: the extension manifest and the static capability catalog. The generated JSON beside this file is the machine-readable form. No session, private configuration, credential, or live registry data is read.",
		"",
		`**Source authority:** ${link(layout, output, "agent/extensions/manifest.json")} (shipped files and tombstones); ${link(layout, output, "agent/extensions/lib/harness-capabilities.ts")} (capability records).`,
		"",
		"## Contents",
		"",
		"- [Capability catalog](#capability-catalog)",
		"- [Static tool and command registrations](#static-tool-and-command-registrations)",
		"- [MCP and wrapper service owners](#mcp-and-wrapper-service-owners)",
		"- [Extension source inventory](#extension-source-inventory)",
		"- [Skills](#skills)",
		"- [Patch modules](#patch-modules)",
		"- [Public documentation](#public-documentation)",
		"- [Retired source markers](#retired-source-markers)",
		"",
		"## Capability catalog",
		"",
		"Each record below is copied from `HARNESS_CAPABILITIES`. Catalog tool names are pointers to entrypoints; the registration inventory later in this file is the independent source scan.",
		"",
	];
	for (const group of [...groups.keys()].sort()) {
		lines.push(`### ${group}`, "");
		for (const record of groups.get(group)) {
			lines.push(`#### ${record.id}`, "", record.summary, "");
			if (record.entrypoints?.length) lines.push(`**Entrypoints:** ${record.entrypoints.map((x) => `\`${x}\``).join(", ")}`, "");
			if (record.tools?.length) lines.push(`**Catalog tool pointers:** ${record.tools.map((x) => `\`${x}\``).join(", ")}`, "");
			if (record.commands?.length) lines.push(`**Commands:** ${record.commands.map((x) => `\`/${x}\``).join(", ")}`, "");
			if (record.options?.length) {
				lines.push("**Options:**", "", ...record.options.map((item) => `- \`${item.name}\`: ${item.summary}${item.values?.length ? ` Values: ${item.values.map((x) => `\`${x}\``).join(", ")}.` : ""}`), "");
			}
			if (record.related?.length) lines.push(`**Related records:** ${record.related.map((x) => `\`${x}\``).join(", ")}`, "");
			if (record.sourceFiles?.length) lines.push(`**Source:** ${record.sourceFiles.map((x) => link(layout, output, x)).join(", ")}`, "");
			if (record.doc) lines.push(`**Documentation:** ${link(layout, output, record.doc, record.doc.replace(/^agent\/public-template\/docs\//, "docs/"))}`, "");
		}
	}

	lines.push("## Static tool and command registrations", "", "Tool names come from literal registrations and source-owned factory definitions, catalogs and constants. Command names come from literal `registerCommand` calls. Computed registration names are listed as owners below; they are not guessed. Use `tool_search` for the authoritative live registry and activation state.", "", "### Native core tools", "", tools.nativeCore.map(name=>`\`${name}\``).join(", ") + ". Extensions can wrap or replace these; explicit tool selections still apply.", "", "### Stable extension tools", "");
	lines.push(listItems(tools.stableRegistrations, (item) => `\`${item.name}\` — ${link(layout, output, item.source)} (line ${item.line}; ${item.kind})`), "", "### Dynamic tool owners", "", listItems(tools.dynamicOwners, (item) => `${link(layout, output, item.source)} — ${item.signals.join("; ")}${item.knownNames?.length ? `; known tools: ${item.knownNames.map(name=>`\`${name}\``).join(", ")}` : ""}${item.lines.length ? ` (lines ${item.lines.join(", ")})` : ""}`), "", "### Literal slash commands", "", listItems(tools.commandRegistrations, (item) => `/${item.name} — ${link(layout, output, item.source)} (line ${item.line})`), "", "### Dynamic command owners", "", listItems(tools.commandDynamicOwners, (item) => `${link(layout, output, item.source)} — ${item.signals.join("; ")}${item.lines.length ? ` (lines ${item.lines.join(", ")})` : ""}`), "");

	lines.push("## MCP and wrapper service owners", "", "This section reports source owners with explicit MCP or wrapper/adapter/client evidence. It names files and evidence only; it does not claim that a service is running or that every dynamically exposed tool is available.", "");
	lines.push(listItems(inventory.serviceOwners, (item) => `${link(layout, output, item.source)} — ${item.signals.map((x) => `\`${x}\``).join(", ")}`), "");

	lines.push("## Extension source inventory", "", "The manifest is the source of truth for the shipped extension, library, fork, support-file, dependency, and folded-marker lists.", "", "### Extensions", "", listItems(inventory.extensions, (item) => `${link(layout, output, item.path)}${item.exists ? "" : " — missing from source tree"}`), "", "### Libraries", "", listItems(inventory.libraries, (item) => `${link(layout, output, item.path)}${item.exists ? "" : " — missing from source tree"}`), "", "### Local forks", "", listItems(inventory.forks, (item) => `${link(layout, output, item.path)} — package \`${item.package}\`${item.exists ? "" : " — missing from source tree"}`), "", "### Manifest support files", "", listItems(inventory.supportFiles, (item) => `${link(layout, output, item.path)}${item.exists ? "" : " — missing from source tree"}`), "", "### Folded markers", "", listItems(inventory.foldedMarkers, (item) => `\`${item.file}\` — ${item.label} (marker \`${item.marker}\`)`), "", "### Vendored runtime dependencies", "", listItems(inventory.vendoredDependencies, (item) => `\`${item}\``), "", "### Extension packages", "", listItems(inventory.npmPackages, (item) => `\`${item}\``), "");

	lines.push("## Skills", "", `The exporter includes ${skills.length} public skill directories. This list is a path inventory; skill contents remain in their linked \`SKILL.md\` files.`, "", listItems(skills, (item) => `\`${item.name}\` — ${link(layout, output, item.path)}`), "");
	lines.push("## Patch modules", "", "These modules are present under `agent/scripts/patches` in the sanitized export. Their own source and updater checks define target compatibility and activation; this inventory does not infer runtime activation.", "", listItems(inventory.patchModules, (item) => `${link(layout, output, item.path)} (source type \`${item.kind}\`)`), "");

	lines.push("## Public documentation", "", listItems(docs, (item) => link(layout, output, item.path, item.path)), "");
	lines.push("## Retired source markers", "", "The manifest tombstones retired names so the inventory can explain historical references without presenting them as available capabilities.", "", listItems(inventory.retired, (item) => `\`${item.name}\` — retired ${item.retired}: ${item.why}`), "");
	return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function build(layout, output, metadataPath) {
	const manifestPath = path.join(layout.agentRoot, "extensions", "manifest.json");
	const catalogPath = path.join(layout.agentRoot, "extensions", "lib", "harness-capabilities.ts");
	if (!fs.existsSync(manifestPath) || !fs.existsSync(catalogPath)) throw new Error("Public manifest or capability catalog is missing");
	const manifest = readJson(manifestPath);
	const records = importCatalog(catalogPath);
	const tools = commandSourceInventory(layout.agentRoot);
	const stableTools = collectToolSourceInventory(layout.agentRoot);
	tools.nativeCore = ["read", "bash", "edit", "write", "grep", "find", "ls"];
	tools.stableRegistrations = stableTools.stableRegistrations;
	tools.literalRegistrations = stableTools.stableRegistrations.filter(item => item.kind === "literal");
	tools.dynamicOwners = stableTools.dynamicOwners;
	tools.coverage = stableTools.coverage;
	const inventory = manifestInventory(layout.agentRoot, manifest);
	inventory.serviceOwners = serviceOwners(layout.agentRoot);
	const skills = skillsInventory(layout.agentRoot);
	const docs = docsInventory(layout.docsRoot ?? path.join(layout.templateRoot, "docs"));
	const metadata = {
		schemaVersion: 1,
		generatedBy: "agent/scripts/generate-capabilities-doc.mjs",
		source: {
			manifest: "agent/extensions/manifest.json",
			catalog: "agent/extensions/lib/harness-capabilities.ts",
			toolEvidence: "literal registrations, source-owned factories/catalogs/constants, native core names and explicitly named dynamic owners",
		},
		capabilities: records.map(record => ({
			...record,
			doc: record.doc.replace(/^agent\/public-template\//, ""),
			sourceFiles: record.sourceFiles.map(file => file.replace(/^agent\/public-template\//, "")),
		})),
		tools,
		inventory: { ...inventory, skills, documentation: docs },
	};
	const markdown = capabilityMarkdown(layout, output, records, tools, metadata.inventory, skills, docs);
	return { markdown, metadata: JSON.stringify(metadata, null, 2) + "\n" };
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const layout = locateLayout(args.root);
	const defaultOutput = path.join(layout.templateRoot, "docs", "CAPABILITIES.md");
	const outputs = args.output
		? [{ output: args.output, metadata: args.metadata ?? args.output.replace(/\.md$/i, ".json") }]
		: [{ output: defaultOutput, metadata: defaultOutput.replace(/\.md$/i, ".json") }];
	// A release export has two public copies: release-template/ is the mirrored
	// template and docs/ is the repository-root distribution. Generate both so
	// neither copy carries stale links or stale catalog data. The live source
	// tree has only public-template/ and therefore keeps one canonical output.
	if (!args.output && path.basename(layout.templateRoot) === "release-template") {
		const rootOutput = path.join(layout.projectRoot, "docs", "CAPABILITIES.md");
		if (!outputs.some((item) => item.output === rootOutput)) outputs.push({ output: rootOutput, metadata: rootOutput.replace(/\.md$/i, ".json") });
	}
	const generated = [];
	for (const item of outputs) {
		const targetLayout = layoutForOutput(layout, item.output);
		const { markdown, metadata } = build(targetLayout, item.output, item.metadata);
		if (args.check) {
			const actualMarkdown = fs.existsSync(item.output) ? fs.readFileSync(item.output, "utf8") : undefined;
			const actualMetadata = fs.existsSync(item.metadata) ? fs.readFileSync(item.metadata, "utf8") : undefined;
			if (actualMarkdown !== markdown || actualMetadata !== metadata) {
				console.error(`Capability inventory is stale: ${item.output}. Run: node agent/scripts/generate-capabilities-doc.mjs --root ${args.root}`);
				process.exitCode = 1;
			}
		} else {
			fs.mkdirSync(path.dirname(item.output), { recursive: true });
			fs.mkdirSync(path.dirname(item.metadata), { recursive: true });
			fs.writeFileSync(item.output, markdown);
			fs.writeFileSync(item.metadata, metadata);
		}
		generated.push({ output: item.output, metadata: item.metadata });
	}
	if (!args.check) console.log(JSON.stringify({ ok: true, generated }));
}

main();
