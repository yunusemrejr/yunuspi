/**
 * Code structure — import-graph health for a source tree.
 *
 * Finds import cycles, modules nothing imports, fan-in/fan-out hotspots, very
 * large files and dependency drift (imported but undeclared, declared but never
 * imported). JS/TS and Python by lexical import scanning: no execution, no
 * resolver plugins, so aliases and dynamic paths are skipped rather than
 * guessed. Findings are evidence for a human decision, not defects.
 */
import path from "node:path";
import { builtinModules } from "node:module";
import type { SourceFile } from "./code-quality.ts";

export interface StructureReport {
	files: number;
	edges: number;
	cycles: Array<{ files: string[]; size: number }>;
	orphans: string[];
	fanIn: Array<{ file: string; importers: number }>;
	fanOut: Array<{ file: string; imports: number }>;
	large: Array<{ file: string; lines: number }>;
	dependencies?: { undeclared: string[]; unused: string[]; note: string };
}

const JS = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i;
const PY = /\.py$/i;
const JS_SPEC = [
	// Statement position only: an `import '…'` inside a string or template is not an edge.
	// `import type` is erased at compile time, so it never forms a runtime cycle.
	/(?:^|[;{}])[ \t]*(?:import|export)\s+(?!type\b)(?:[\w*${}\s,]+?\s+from\s+)?["']([^"']+)["']/gm,
	/(?<![\w.$"'`])require\(\s*["']([^"']+)["']\s*\)/g,
	/(?<![\w.$"'`])import\(\s*["']([^"']+)["']\s*\)/g,
];
/** Modules that are legitimately not imported by anything: entry points, tests, configs and scripts. */
const ENTRY = /(?:^|\/)(?:index|main|cli|app|server|setup|conftest|__main__|__init__|manage)\.[a-z]+$|(?:^|\/)(?:tests?|__tests__|spec|e2e|scripts?|bin|examples?|fixtures?|docs?|migrations?)\/|[._-](?:test|spec|config|stories)\.[a-z]+$|(?:^|\/)[\w.-]*\.config\.[cm]?[jt]s$/i;
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const MAX_LARGE = 600;

const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

function jsSpecifiers(source: string): string[] {
	const text = stripComments(source), found = new Set<string>();
	for (const pattern of JS_SPEC) { pattern.lastIndex = 0; for (let m = pattern.exec(text); m; m = pattern.exec(text)) found.add(m[1]); }
	return [...found];
}

function pySpecifiers(source: string): string[] {
	const found = new Set<string>();
	for (const line of source.split("\n")) {
		const from = /^\s*from\s+(\.*[\w.]*)\s+import\b/.exec(line);
		if (from) { found.add(from[1]); continue; }
		const plain = /^\s*import\s+([\w.,\s]+?)(?:\s+as\s+\w+)?\s*$/.exec(line);
		if (plain) for (const name of plain[1].split(",")) found.add(name.trim().split(/\s+/)[0]);
	}
	return [...found].filter(Boolean);
}

/** Resolve a relative specifier to a scanned file: exact, extension, index, and the TS `.js` → `.ts` convention. */
function resolveRelative(from: string, specifier: string, known: Set<string>): string | undefined {
	const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
	const stem = base.replace(/\.[cm]?jsx?$/, "");
	const candidates = [base, ...["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "vue", "svelte", "py"].map((ext) => `${stem}.${ext}`),
		...["ts", "tsx", "js", "jsx", "mjs", "py"].map((ext) => `${base}/index.${ext}`), `${base}/__init__.py`];
	return candidates.find((candidate) => known.has(candidate));
}

function resolvePython(from: string, specifier: string, known: Set<string>): string | undefined {
	const dots = /^\.*/.exec(specifier)![0].length, rest = specifier.slice(dots).split(".").filter(Boolean).join("/");
	const dir = dots ? path.posix.join(path.posix.dirname(from), ...Array(dots - 1).fill("..")) : "";
	for (const root of dots ? [dir] : ["", "src"]) {
		const base = path.posix.join(root, rest);
		const hit = [`${base}.py`, `${base}/__init__.py`].find((candidate) => known.has(candidate));
		if (hit) return hit;
	}
	return undefined;
}

const packageName = (specifier: string) => specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];

/** Tarjan's strongly connected components; components with more than one file (or a self-import) are cycles. */
function cycles(graph: Map<string, Set<string>>): string[][] {
	let index = 0;
	const indexOf = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], onStack = new Set<string>(), out: string[][] = [];
	const visit = (node: string) => {
		indexOf.set(node, index); low.set(node, index); index++; stack.push(node); onStack.add(node);
		for (const next of graph.get(node) ?? []) {
			if (!indexOf.has(next)) { visit(next); low.set(node, Math.min(low.get(node)!, low.get(next)!)); }
			else if (onStack.has(next)) low.set(node, Math.min(low.get(node)!, indexOf.get(next)!));
		}
		if (low.get(node) === indexOf.get(node)) {
			const component: string[] = [];
			for (let member = stack.pop()!; ; member = stack.pop()!) { onStack.delete(member); component.push(member); if (member === node) break; }
			if (component.length > 1 || graph.get(node)?.has(node)) out.push(component.sort());
		}
	};
	for (const node of graph.keys()) if (!indexOf.has(node)) visit(node);
	return out.sort((a, b) => b.length - a.length);
}

export function analyzeStructure(files: SourceFile[], manifest?: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; name?: string }, wholeWorkspace = true, limit = 25): StructureReport {
	const sources = files.filter((file) => JS.test(file.path) || PY.test(file.path));
	const known = new Set(sources.map((file) => file.path.split(path.sep).join("/")));
	const graph = new Map<string, Set<string>>(), importers = new Map<string, Set<string>>(), bare = new Set<string>();
	for (const file of sources) {
		const id = file.path.split(path.sep).join("/"), edges = new Set<string>();
		graph.set(id, edges);
		const python = PY.test(id);
		for (const specifier of python ? pySpecifiers(file.source) : jsSpecifiers(file.source)) {
			if (python ? specifier.startsWith(".") || known.has(`${specifier.replaceAll(".", "/")}.py`) || known.has(`src/${specifier.replaceAll(".", "/")}.py`) || known.has(`${specifier.replaceAll(".", "/")}/__init__.py`)
				: specifier.startsWith(".")) {
				const target = python ? resolvePython(id, specifier, known) : resolveRelative(id, specifier, known);
				if (target && target !== id) { edges.add(target); (importers.get(target) ?? importers.set(target, new Set()).get(target)!).add(id); }
				else if (target === id) edges.add(id);
			} else if (!python && !specifier.startsWith("/") && !/^[#~@]\//.test(specifier) && !specifier.startsWith("#") && !BUILTINS.has(specifier)) bare.add(packageName(specifier));
		}
	}
	const rows = (map: Map<string, Set<string>>, count: string) => [...map].filter(([, set]) => set.size).sort((a, b) => b[1].size - a[1].size).slice(0, 10).map(([file, set]) => ({ file, [count]: set.size }));
	const report: StructureReport = {
		files: sources.length,
		edges: [...graph.values()].reduce((sum, set) => sum + set.size, 0),
		cycles: cycles(graph).slice(0, limit).map((files) => ({ files: files.slice(0, 12), size: files.length })),
		orphans: sources.map((file) => file.path.split(path.sep).join("/")).filter((id) => !importers.has(id) && !ENTRY.test(id)).sort().slice(0, limit * 2),
		fanIn: rows(importers, "importers") as StructureReport["fanIn"],
		fanOut: rows(graph, "imports") as StructureReport["fanOut"],
		large: sources.map((file) => ({ file: file.path, lines: file.source.split("\n").length })).filter((row) => row.lines > MAX_LARGE).sort((a, b) => b.lines - a.lines).slice(0, 10),
	};
	if (manifest && wholeWorkspace) {
		const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})]);
		report.dependencies = {
			undeclared: [...bare].filter((name) => !declared.has(name) && name !== manifest.name && !declared.has(`@types/${name.replace(/^@/, "").replace("/", "__")}`)).sort().slice(0, limit),
			unused: [...declared].filter((name) => !bare.has(name) && !name.startsWith("@types/")).sort().slice(0, limit),
			note: "Lexical import scan of the scanned files. Declared packages used only by config files, CLIs, plugins or scripts show as unused; undeclared names may come from workspaces or hoisting.",
		};
	}
	return report;
}
