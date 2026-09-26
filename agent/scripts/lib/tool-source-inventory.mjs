/**
 * Static tool-registration inventory for the public capability exporter.
 *
 * This module deliberately reads source text only.  It does not import an
 * extension, start a provider, inspect settings, consult the live registry,
 * or read credentials.  Names are recorded when they are proven by a
 * literal registration object or by one of the small, source-owned catalogs
 * and factories listed below.  Computed names stay attached to their source
 * owner instead of being guessed from arbitrary `name:` properties.
 */
import fs from "node:fs";
import path from "node:path";

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRECTORIES = new Set([
	"node_modules",
	".git",
	"sessions",
	"logs",
	"memory",
	"backups",
	"artifacts",
	"worktrees",
	"dist",
	"build",
	"generated",
]);
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]*$/;

function fileExists(file) {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

function directoryExists(directory) {
	try {
		return fs.statSync(directory).isDirectory();
	} catch {
		return false;
	}
}

/** Accept a project root, an agent root, or an exported tree's project root. */
function resolveAgentRoot(inputRoot = process.cwd()) {
	const root = path.resolve(String(inputRoot));
	const candidates = [
		root,
		path.join(root, "agent"),
		path.join(root, "public-template"),
		path.join(root, "release-template"),
	];
	for (const candidate of candidates) {
		if (fileExists(path.join(candidate, "extensions", "manifest.json"))) return candidate;
	}
	throw new Error(`Cannot find extensions/manifest.json below ${root}`);
}

function walkSourceFiles(directory) {
	if (!directoryExists(directory)) return [];
	const files = [];
	const visit = (current) => {
		let entries;
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
			const absolute = path.join(current, entry.name);
			if (entry.isDirectory()) visit(absolute);
			else if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(absolute);
		}
	};
	visit(directory);
	return files.sort((a, b) => a.localeCompare(b));
}

function relative(from, absolute) {
	return path.relative(from, absolute).replaceAll(path.sep, "/");
}

function sourceLink(agentRoot, absolute) {
	return `agent/${relative(agentRoot, absolute)}`;
}

function lineAt(source, offset) {
	let line = 1;
	for (let index = 0; index < offset; index++) if (source[index] === "\n") line++;
	return line;
}

function isIdentifierCharacter(character) {
	return typeof character === "string" && /[A-Za-z0-9_$]/.test(character);
}

function isWordAt(source, index, word) {
	if (source.slice(index, index + word.length) !== word) return false;
	return !isIdentifierCharacter(source[index - 1]) && !isIdentifierCharacter(source[index + word.length]);
}

function quoteEnd(source, start) {
	const quote = source[start];
	let escaped = false;
	for (let index = start + 1; index < source.length; index++) {
		const character = source[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === quote) return index;
		// A malformed template/string is still treated as a source boundary.
		if (character === "\n" && quote !== "`") return index - 1;
	}
	return source.length - 1;
}

function skipTrivia(source, start) {
	let index = start;
	while (index < source.length) {
		if (/\s/.test(source[index])) {
			index++;
			continue;
		}
		if (source.startsWith("//", index)) {
			const end = source.indexOf("\n", index + 2);
			index = end < 0 ? source.length : end + 1;
			continue;
		}
		if (source.startsWith("/*", index)) {
			const end = source.indexOf("*/", index + 2);
			index = end < 0 ? source.length : end + 2;
			continue;
		}
		break;
	}
	return index;
}

function skipBalanced(source, start, open, close) {
	if (source[start] !== open) return start;
	let depth = 0;
	for (let index = start; index < source.length; index++) {
		const character = source[index];
		const next = source[index + 1];
		if (character === "'" || character === '"' || character === "`") {
			index = quoteEnd(source, index);
			continue;
		}
		if (character === "/" && next === "/") {
			const end = source.indexOf("\n", index + 2);
			index = end < 0 ? source.length : end;
			continue;
		}
		if (character === "/" && next === "*") {
			const end = source.indexOf("*/", index + 2);
			index = end < 0 ? source.length : end + 1;
			continue;
		}
		if (character === open) depth++;
		else if (character === close) {
			depth--;
			if (depth === 0) return index;
		}
	}
	return source.length - 1;
}

function skipGenericArguments(source, start) {
	let index = skipTrivia(source, start);
	if (source[index] !== "<") return index;
	let angleDepth = 0;
	for (; index < source.length; index++) {
		const character = source[index];
		if (character === "'" || character === '"' || character === "`") {
			index = quoteEnd(source, index);
			continue;
		}
		if (character === "<") angleDepth++;
		else if (character === ">") {
			angleDepth--;
			if (angleDepth === 0) return skipTrivia(source, index + 1);
		}
	}
	return index;
}

function parseStringLiteral(source, start) {
	const quote = source[start];
	if (quote !== "'" && quote !== '"') return undefined;
	const end = quoteEnd(source, start);
	if (end < start || source[end] !== quote) return undefined;
	const raw = source.slice(start + 1, end);
	// Tool names in this tree are plain ASCII literals.  Decode only the
	// escapes needed for a source name and reject control/ambiguous strings.
	const value = raw.replaceAll(`\\${quote}`, quote).replaceAll("\\\\", "\\");
	if (!TOOL_NAME_PATTERN.test(value)) return undefined;
	return { value, end };
}

/**
 * Find a literal top-level `name` in the object passed to registerTool.
 * Nested schema/rendering objects are intentionally ignored.
 */
function literalObjectName(source, objectStart) {
	if (source[objectStart] !== "{") return undefined;
	let objectDepth = 0;
	let bracketDepth = 0;
	let parenDepth = 0;
	let found;
	let hasParameters = false;
	let hasExecute = false;
	for (let index = objectStart; index < source.length; index++) {
		const character = source[index];
		const next = source[index + 1];
		if (character === "'" || character === '"' || character === "`") {
			index = quoteEnd(source, index);
			continue;
		}
		if (character === "/" && next === "/") {
			const end = source.indexOf("\n", index + 2);
			index = end < 0 ? source.length : end;
			continue;
		}
		if (character === "/" && next === "*") {
			const end = source.indexOf("*/", index + 2);
			index = end < 0 ? source.length : end + 1;
			continue;
		}
		if (character === "{") {
			objectDepth++;
			continue;
		}
		if (character === "}") {
			objectDepth--;
			if (objectDepth === 0) return found && hasParameters && hasExecute ? found : undefined;
			continue;
		}
		if (character === "[") {
			bracketDepth++;
			continue;
		}
		if (character === "]") {
			bracketDepth--;
			continue;
		}
		if (character === "(") {
			parenDepth++;
			continue;
		}
		if (character === ")") {
			parenDepth--;
			continue;
		}
		if (objectDepth !== 1 || bracketDepth !== 0 || parenDepth !== 0 || !isIdentifierCharacter(character)) continue;
		const token = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index))?.[0];
		if (!token) continue;
		if (token === "parameters") hasParameters = true;
		if (token === "execute") hasExecute = true;
		if (token === "name") {
			const colon = skipTrivia(source, index + token.length);
			if (source[colon] === ":") {
				const parsed = parseStringLiteral(source, skipTrivia(source, colon + 1));
				if (parsed) found = { name: parsed.value, offset: index };
			}
		}
		index += token.length - 1;
	}
	return undefined;
}

/** Find registration calls while ignoring comments and quoted text. */
function scanCalls(source, identifier) {
	const calls = [];
	for (let index = 0; index < source.length;) {
		const character = source[index];
		const next = source[index + 1];
		if (character === "'" || character === '"' || character === "`") {
			index = quoteEnd(source, index) + 1;
			continue;
		}
		if (character === "/" && next === "/") {
			const end = source.indexOf("\n", index + 2);
			index = end < 0 ? source.length : end + 1;
			continue;
		}
		if (character === "/" && next === "*") {
			const end = source.indexOf("*/", index + 2);
			index = end < 0 ? source.length : end + 2;
			continue;
		}
		if (!isWordAt(source, index, identifier)) {
			index++;
			continue;
		}
		let cursor = skipGenericArguments(source, index + identifier.length);
		if (source[cursor] === "?" && source[cursor + 1] === ".") cursor = skipTrivia(source, cursor + 2);
		if (source[cursor] !== "(") {
			index += identifier.length;
			continue;
		}
		const argumentStart = skipTrivia(source, cursor + 1);
		calls.push({ index, callStart: cursor, argumentStart });
		index = cursor + 1;
	}
	return calls;
}

function firstStringArgument(source, call) {
	return parseStringLiteral(source, call.argumentStart);
}

function addStable(rows, row) {
	if (!row?.name || !TOOL_NAME_PATTERN.test(row.name)) return;
	rows.push(row);
}

function addOwner(owners, source, line, signal, knownName) {
	const owner = owners.get(source) ?? { source, signals: new Set(), lines: new Set(), knownNames: new Set() };
	if (signal) owner.signals.add(signal);
	if (line > 0) owner.lines.add(line);
	if (knownName) owner.knownNames.add(knownName);
	owners.set(source, owner);
}

function sourceRelative(agentRoot, file) {
	return relative(agentRoot, file).replaceAll("\\", "/");
}

function namesInObjectArray(source, start, end) {
	const result = [];
	const arrayStart = source.indexOf("[", start);
	if (arrayStart < 0 || arrayStart >= end) return result;
	let objectDepth = 0;
	let bracketDepth = 0;
	let parenDepth = 0;
	for (let index = arrayStart; index < end; index++) {
		const character = source[index];
		const next = source[index + 1];
		if (character === "'" || character === '"' || character === "`") {
			index = quoteEnd(source, index);
			continue;
		}
		if (character === "/" && next === "/") {
			const lineEnd = source.indexOf("\n", index + 2);
			index = lineEnd < 0 ? end : Math.min(lineEnd, end);
			continue;
		}
		if (character === "/" && next === "*") {
			const commentEnd = source.indexOf("*/", index + 2);
			index = commentEnd < 0 ? end : Math.min(commentEnd + 1, end);
			continue;
		}
		if (character === "[") {
			bracketDepth++;
			continue;
		}
		if (character === "]") {
			bracketDepth--;
			continue;
		}
		if (character === "(") {
			parenDepth++;
			continue;
		}
		if (character === ")") {
			parenDepth--;
			continue;
		}
		if (character === "{") {
			objectDepth++;
			continue;
		}
		if (character === "}") {
			objectDepth--;
			continue;
		}
		if (objectDepth !== 1 || bracketDepth !== 1 || parenDepth !== 0 || !isWordAt(source, index, "name")) continue;
		const colon = skipTrivia(source, index + "name".length);
		if (source[colon] !== ":") continue;
		const parsed = parseStringLiteral(source, skipTrivia(source, colon + 1));
		if (parsed) result.push({ name: parsed.value, offset: index });
	}
	return result;
}

function extractFactoryNames(source, identifier) {
	return scanCalls(source, identifier)
		.map((call) => {
			const parsed = firstStringArgument(source, call);
			return parsed ? { name: parsed.value, offset: call.index } : undefined;
		})
		.filter(Boolean);
}

function extractCatalogNames(source) {
	const declaration = /\b(?:export\s+)?const\s+TOOLS\s*=\s*\[/.exec(source);
	if (!declaration) return [];
	const start = declaration.index + declaration[0].length - 1;
	const end = skipBalanced(source, start, "[", "]");
	return scanCalls(source.slice(start, end + 1), "tool")
		.map((call) => {
			const parsed = firstStringArgument(source.slice(start, end + 1), call);
			return parsed ? { name: parsed.value, offset: start + call.index } : undefined;
		})
		.filter(Boolean);
}

function extractDefaultToolNames(source) {
	const declaration = /\b(?:const|let|var)\s+DEFAULT_TOOL_NAMES\s*:\s*[^=]+\s*=\s*\{/.exec(source)
		?? /\b(?:const|let|var)\s+DEFAULT_TOOL_NAMES\s*=\s*\{/.exec(source);
	if (!declaration) return [];
	const objectStart = source.indexOf("{", declaration.index);
	const objectEnd = skipBalanced(source, objectStart, "{", "}");
	const rows = [];
	for (let index = objectStart + 1; index < objectEnd;) {
		const key = /[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index));
		if (!key) {
			index++;
			continue;
		}
		const keyOffset = index + key.index;
		const colon = skipTrivia(source, keyOffset + key[0].length);
		if (source[colon] !== ":") {
			index = keyOffset + key[0].length;
			continue;
		}
		const parsed = parseStringLiteral(source, skipTrivia(source, colon + 1));
		if (parsed) rows.push({ name: parsed.value, offset: keyOffset });
		index = parsed ? parsed.end + 1 : colon + 1;
	}
	return rows;
}

function extractNamedConstant(source, constant) {
	const pattern = new RegExp(`\\b(?:export\\s+)?const\\s+${constant}\\s*=\\s*([\\\"'])([A-Za-z][A-Za-z0-9_.:-]*)\\1`);
	const match = pattern.exec(source);
	return match ? { name: match[2], offset: match.index } : undefined;
}

function extractNamedObjectProperty(source, objectVariable, property = "name") {
	const declaration = new RegExp(`\\b(?:const|let|var)\\s+${objectVariable}\\b[^=]*=\\s*\\{`).exec(source);
	if (!declaration) return undefined;
	const objectStart = source.indexOf("{", declaration.index);
	const objectEnd = skipBalanced(source, objectStart, "{", "}");
	const object = literalObjectName(source.slice(objectStart, objectEnd + 1), 0);
	return object ? { name: object.name, offset: objectStart + object.offset } : undefined;
}

function addTargetedNames({ file, source, relativePath, stable, owners }) {
	const canonicalSource = `agent/${relativePath}`;
	const addRows = (rows, kind, extra = {}) => {
		for (const row of rows) addStable(stable, {
			name: row.name,
			source: canonicalSource,
			line: lineAt(source, row.offset),
			kind,
			...extra,
		});
	};

	if (relativePath === "extensions/lib/small-tools.ts" || relativePath === "extensions/media-tools.ts" || relativePath === "extensions/video-studio.ts" || relativePath === "extensions/art-direction.ts" || relativePath === "extensions/pi-subagents/src/extension/reasoning-aids.ts") {
		addRows(extractFactoryNames(source, "register"), "factory");
	}

	if (relativePath === "extensions/pi-lens/context-tools.ts") {
		const declaration = /\bconst\s+definitions\s*=\s*\[/.exec(source);
		if (declaration) {
			const start = source.indexOf("[", declaration.index);
			const end = skipBalanced(source, start, "[", "]");
			addRows(namesInObjectArray(source, start, end + 1), "definition");
		}
	}

	if (relativePath === "extensions/lib/utility-mcp/catalog.mjs") addRows(extractCatalogNames(source), "catalog");

	if (relativePath === "extensions/pi-web-access/index.ts") {
		addRows(extractDefaultToolNames(source), "configured-default", { configurable: true });
	}

	if (relativePath === "extensions/rpiv-todo/tool/types.ts") addRows([extractNamedConstant(source, "TOOL_NAME")].filter(Boolean), "constant");

	if (relativePath === "extensions/pi-subagents/src/intercom/native-supervisor-channel.ts") {
		addRows([extractNamedConstant(source, "NATIVE_SUPERVISOR_TOOL_NAME")].filter(Boolean), "constant");
		const direct = /\bname\s*:\s*(['"])contact_supervisor\1/.exec(source);
		if (direct) addRows([{ name: "contact_supervisor", offset: direct.index }], "definition");
	}

	if (relativePath === "extensions/pi-subagents/src/runs/background/wait-tool.ts") {
		const direct = /\bname\s*:\s*(['"])bg_wait\1/.exec(source);
		if (direct) addRows([{ name: "bg_wait", offset: direct.index }], "definition");
	}

	if (relativePath === "extensions/pi-subagents/src/extension/index.ts" || relativePath === "extensions/pi-subagents/src/extension/fanout-child.ts") {
		const direct = /\bname\s*:\s*(['"])subagent\1/.exec(source);
		if (direct) addRows([{ name: "subagent", offset: direct.index }], "definition");
	}

	if (relativePath === "extensions/managed-bash.ts") {
		const factory = /\bcreateBashToolDefinition\s*\(/.exec(source);
		if (factory) addRows([{ name: "bash", offset: factory.index }], "sdk-factory", { evidence: "createBashToolDefinition() supplies the builtin bash definition" });
	}

	// Keep the dynamic owner visible even when targeted extraction discovered
	// its names.  This explains configuration, factory, and catalog boundaries.
	const calls = scanCalls(source, "registerTool");
	for (const call of calls) {
		const first = call.argumentStart;
		if (source[first] === "{") {
			const direct = literalObjectName(source, first);
			if (direct) continue;
		}
		const line = lineAt(source, call.index);
		let signal = "registerTool() receives a computed or indirect definition; the runtime name is not inferred";
		if (relativePath === "extensions/lib/small-tools.ts" || relativePath === "extensions/media-tools.ts" || relativePath === "extensions/video-studio.ts" || relativePath === "extensions/art-direction.ts" || relativePath === "extensions/pi-subagents/src/extension/reasoning-aids.ts") signal = "registration passes names through a local factory; literal factory call sites are enumerated";
		else if (relativePath === "extensions/pi-lens/context-tools.ts") signal = "registration loops over definitions; literal definition names are enumerated";
		else if (relativePath === "extensions/utility-tools.ts") signal = "registration loops over the static TOOLS catalog; catalog names are enumerated";
		else if (relativePath === "extensions/pi-web-access/index.ts") signal = "registration uses configurable toolNames; checked-in defaults are enumerated";
		else if (relativePath === "extensions/managed-bash.ts") signal = "registration receives the SDK createBashToolDefinition() for the active cwd";
		else if (relativePath === "extensions/rpiv-todo/todo.ts") signal = "registration uses the source-owned TOOL_NAME constant";
		else if (relativePath === "extensions/pi-subagents/src/runs/background/wait-tool.ts") signal = "registration receives the source-owned primaryTool definition";
		else if (relativePath === "extensions/pi-subagents/src/intercom/native-supervisor-channel.ts") signal = "registration receives source-owned supervisor tool definitions";
		else if (relativePath === "extensions/pi-subagents/src/extension/index.ts" || relativePath === "extensions/pi-subagents/src/extension/fanout-child.ts") signal = "registration receives the source-owned subagent definition";
		addOwner(owners, canonicalSource, line, signal);
	}
}

function normalizeStable(rows) {
	const seen = new Set();
	return rows
		.filter((row) => {
			const key = `${row.name}\u0000${row.source}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source) || a.line - b.line);
}

function normalizeOwners(owners) {
	return [...owners.values()]
		.map((owner) => ({
			source: owner.source,
			signals: [...owner.signals].sort(),
			lines: [...owner.lines].sort((a, b) => a - b),
			...(owner.knownNames.size ? { knownNames: [...owner.knownNames].sort() } : {}),
		}))
		.sort((a, b) => a.source.localeCompare(b.source));
}

/**
 * Return the stable source-backed tool inventory for an agent tree.
 *
 * `literalRegistrations` and `dynamicOwners` intentionally match the public
 * capability document's existing metadata shape. `stableRegistrations` is a
 * descriptive alias for callers that do not use the older field name.
 */
export function collectToolSourceInventory(inputRoot = process.cwd()) {
	const agentRoot = resolveAgentRoot(inputRoot);
	const extensionsRoot = path.join(agentRoot, "extensions");
	const files = walkSourceFiles(extensionsRoot);
	const stable = [];
	const owners = new Map();
	let registrationSites = 0;
	let indirectSites = 0;

	for (const file of files) {
		let source;
		try {
			source = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const sourcePath = sourceLink(agentRoot, file);
		const relativePath = sourceRelative(agentRoot, file);
		const calls = scanCalls(source, "registerTool");
		registrationSites += calls.length;
		for (const call of calls) {
			if (source[call.argumentStart] !== "{") {
				indirectSites++;
				continue;
			}
			const direct = literalObjectName(source, call.argumentStart);
			if (!direct) indirectSites++;
			else addStable(stable, { name: direct.name, source: sourcePath, line: lineAt(source, call.index), kind: "literal" });
		}
		addTargetedNames({ file, source, relativePath, stable, owners });
	}

	const literalRegistrations = normalizeStable(stable);
	for (const row of literalRegistrations) {
		const owner = owners.get(row.source);
		if (owner) owner.knownNames.add(row.name);
	}
	// Catalog/constant definitions intentionally live beside their registration
	// owner. Preserve that relationship in the owner preview without reading
	// imports or evaluating the module graph.
	const relatedDefinitionSources = new Map([
		["agent/extensions/utility-tools.ts", "agent/extensions/lib/utility-mcp/catalog.mjs"],
		["agent/extensions/rpiv-todo/todo.ts", "agent/extensions/rpiv-todo/tool/types.ts"],
	]);
	for (const [ownerSource, definitionSource] of relatedDefinitionSources) {
		const owner = owners.get(ownerSource);
		if (!owner) continue;
		for (const row of literalRegistrations) if (row.source === definitionSource) owner.knownNames.add(row.name);
	}
	const dynamicOwners = normalizeOwners(owners);
	const uniqueNames = [...new Set(literalRegistrations.map((row) => row.name))].sort();
	const coverage = {
		sourceFiles: files.length,
		registrationSites,
		indirectRegistrationSites: indirectSites,
		stableRegistrationRows: literalRegistrations.length,
		uniqueStableTools: uniqueNames.length,
		dynamicOwnerCount: dynamicOwners.length,
		excludedGeneratedDirectories: ["dist", "build", "generated"],
	};
	return {
		schemaVersion: 1,
		literalRegistrations,
		stableRegistrations: literalRegistrations,
		dynamicOwners,
		coverage,
	};
}

export const buildToolSourceInventory = collectToolSourceInventory;
export const sourceInventory = collectToolSourceInventory;

export default collectToolSourceInventory;
