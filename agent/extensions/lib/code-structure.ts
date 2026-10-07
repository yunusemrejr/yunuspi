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
import { parseImports, resolveCodeImports } from './project-intelligence/discovery-parsers.mjs';

export interface StructureReport {
	files: number;
	edges: number;
	cycles: Array<{ files: string[]; size: number }>;
	orphans: string[];
	fanIn: Array<{ file: string; importers: number }>;
	fanOut: Array<{ file: string; imports: number }>;
	large: Array<{ file: string; lines: number }>;
	incomplete?: string[];
	dependencies?: { undeclared: string[]; unused: string[]; note: string };
}

const JS = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i;
const PY = /\.py$/i;
/** Modules that are legitimately not imported by anything: entry points, tests, configs and scripts. */
const ENTRY = /(?:^|\/)(?:index|main|cli|app|server|setup|conftest|__main__|__init__|manage)\.[a-z]+$|(?:^|\/)(?:tests?|__tests__|spec|e2e|scripts?|bin|examples?|fixtures?|docs?|migrations?)\/|[._-](?:test|spec|config|stories)\.[a-z]+$|(?:^|\/)[\w.-]*\.config\.[cm]?[jt]s$/i;
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const MAX_LARGE = 600;

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
	const graph = new Map<string, Set<string>>(), importers = new Map<string, Set<string>>(), bare = new Set<string>(), incomplete: string[] = [];
	for (const file of sources) {
		const id = file.path.split(path.sep).join("/"), edges = new Set<string>();
		graph.set(id, edges);
		const python = PY.test(id), scanned = parseImports(file.source, path.posix.extname(id), Infinity);
		if (!scanned.complete) incomplete.push(id);
		for (const item of scanned.imports) {
			if (item.typeOnly) continue;
			const targets = resolveCodeImports(id, item, known), specifier = item.specifier;
			for (const target of targets) {
				edges.add(target);
				if (target !== id) (importers.get(target) ?? importers.set(target, new Set()).get(target)!).add(id);
			}
			if (!targets.length && !python && !specifier.startsWith(".") && !specifier.startsWith("/") && !/^[#~@]\//.test(specifier) && !specifier.startsWith("#") && !/^[A-Za-z][\w+.-]*:/.test(specifier) && !BUILTINS.has(specifier)) bare.add(packageName(specifier));
		}
	}
	const rows = (map: Map<string, Set<string>>, count: string) => [...map].filter(([, set]) => set.size).sort((a, b) => b[1].size - a[1].size).slice(0, 10).map(([file, set]) => ({ file, [count]: set.size }));
	const report: StructureReport = {
		files: sources.length,
		edges: [...graph.values()].reduce((sum, set) => sum + set.size, 0),
		cycles: cycles(graph).slice(0, limit).map((files) => ({ files: files.slice(0, 12), size: files.length })),
		orphans: incomplete.length ? [] : sources.map((file) => file.path.split(path.sep).join("/")).filter((id) => !importers.has(id) && !ENTRY.test(id)).sort().slice(0, limit * 2),
		fanIn: rows(importers, "importers") as StructureReport["fanIn"],
		fanOut: rows(graph, "imports") as StructureReport["fanOut"],
		large: sources.map((file) => ({ file: file.path, lines: file.source.split("\n").length })).filter((row) => row.lines > MAX_LARGE).sort((a, b) => b.lines - a.lines).slice(0, 10),
		...(incomplete.length ? { incomplete: incomplete.slice(0, limit) } : {}),
	};
	if (manifest && wholeWorkspace) {
		const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})]);
		report.dependencies = {
			undeclared: [...bare].filter((name) => !declared.has(name) && name !== manifest.name).sort().slice(0, limit),
			unused: incomplete.length ? [] : [...declared].filter((name) => !bare.has(name) && !name.startsWith("@types/")).sort().slice(0, limit),
			note: (incomplete.length ? "Incomplete lexical scan; orphans and unused packages were not assessed. " : "") + "Lexical import scan of the scanned files. Declared packages used only by config files, CLIs, plugins or scripts show as unused; undeclared names may come from workspaces or hoisting.",
		};
	}
	return report;
}
