import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, opendirSync, readSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

/**
 * Deterministic profile of the project at hand, in the same vocabulary as
 * github_search's repository fact sheet (languages, license, layout signals,
 * README digest), so another product can be compared with this codebase
 * without a model guessing what either one contains. Read-only: a bounded walk
 * plus the head of a few well-known files; no network, no writes, never `.env`.
 */

const MAX_FILES = 5000;
const MAX_ENTRIES = 10000;
const MAX_DEPTH = 6;
const HEAD_BYTES = 64 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "target", "vendor", ".venv", "venv", "__pycache__", ".next", ".nuxt", ".cache", "coverage", ".turbo", "release-template"]);

const LANGUAGES: Record<string, string> = {
	".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
	".py": "Python", ".rs": "Rust", ".go": "Go", ".java": "Java", ".kt": "Kotlin", ".cs": "C#", ".cpp": "C++", ".cc": "C++", ".c": "C", ".h": "C/C++ header", ".hpp": "C++",
	".rb": "Ruby", ".php": "PHP", ".swift": "Swift", ".sh": "Shell", ".bash": "Shell", ".lua": "Lua", ".ex": "Elixir", ".exs": "Elixir", ".zig": "Zig", ".html": "HTML", ".css": "CSS", ".scss": "CSS", ".vue": "Vue", ".svelte": "Svelte", ".sql": "SQL",
};

const SIGNALS: ReadonlyArray<{ key: string; pattern: RegExp }> = [
	{ key: "tests", pattern: /^(?:tests?|__tests__|spec|specs|e2e)$/i },
	{ key: "ci", pattern: /^(?:\.github|\.gitlab-ci\.yml|\.circleci|azure-pipelines\.yml|\.travis\.yml|jenkinsfile)$/i },
	{ key: "docs", pattern: /^(?:docs?|documentation|website|wiki)$/i },
	{ key: "changelog", pattern: /^(?:changelog|changes|history|releases?)(?:\.[a-z]+)?$/i },
	{ key: "contributing", pattern: /^contributing(?:\.[a-z]+)?$/i },
	{ key: "container", pattern: /^(?:dockerfile|docker-compose\.ya?ml|compose\.ya?ml|\.devcontainer)$/i },
	{ key: "examples", pattern: /^(?:examples?|samples?|demo|demos)$/i },
	{ key: "license", pattern: /^(?:licen[sc]e|copying)(?:\.[a-z]+)?$/i },
];
export const MANIFESTS = /^(?:package\.json|pyproject\.toml|setup\.py|requirements\.txt|cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|composer\.json|gemfile|mix\.exs|deno\.json|cmakelists\.txt|makefile)$/i;
const LICENSE_HINTS: ReadonlyArray<[RegExp, string]> = [
	[/\bMIT License\b/i, "MIT"], [/\bApache License,? Version 2\.0\b/i, "Apache-2.0"], [/\bGNU AFFERO GENERAL PUBLIC LICENSE\b/i, "AGPL-3.0"], [/\bGNU LESSER GENERAL PUBLIC LICENSE\b/i, "LGPL"],
	[/\bGNU GENERAL PUBLIC LICENSE\b[\s\S]{0,200}\bVersion 3\b/i, "GPL-3.0"], [/\bGNU GENERAL PUBLIC LICENSE\b[\s\S]{0,200}\bVersion 2\b/i, "GPL-2.0"], [/\bMozilla Public License\b/i, "MPL-2.0"],
	[/\bBSD 3-Clause\b|Redistribution and use in source and binary forms[\s\S]{0,900}Neither the name/i, "BSD-3-Clause"], [/\bThe Unlicense\b|unencumbered software released into the public domain/i, "Unlicense"], [/\bISC License\b/i, "ISC"],
];

/** Presence signals read off a root listing; the shared vocabulary of the local profile and github_search's fact sheet. */
export function layoutSignals(names: readonly string[]): Record<string, boolean> {
	return Object.fromEntries(SIGNALS.map(({ key, pattern }) => [key, names.some((name) => pattern.test(name))]));
}

export interface ProjectProfile {
	name: string;
	description?: string;
	/** Share of recognised source files by language. */
	languages: Array<{ name: string; files: number; percent: number }>;
	sourceFiles: number;
	filesScanned: number;
	truncated: boolean;
	manifests: string[];
	declared: { scripts: string[]; bins: string[]; dependencies: string[]; devDependencies: number };
	license?: string;
	signals: Record<string, boolean>;
	root: string[];
	/** README title and first paragraph. */
	tagline?: string;
	/** README section headings: the closest cheap proxy for what the product claims to do. */
	capabilityHeadings: string[];
	latestTag?: string;
}

function head(file: string): string {
	let fd: number | undefined;
	try {
		fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
		if (!fstatSync(fd).isFile()) return "";
		const bytes = Buffer.alloc(HEAD_BYTES);
		let used = 0;
		while (used < bytes.length) {
			const count = readSync(fd, bytes, used, bytes.length - used, used);
			if (!count) break;
			used += count;
		}
		return bytes.subarray(0, used).toString("utf8");
	} catch { return ""; }
	finally { if (fd !== undefined) closeSync(fd); }
}

function readJson(path: string): Record<string, any> | undefined {
	try {
		const parsed = JSON.parse(head(path));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
	} catch { return undefined; }
}

const oneLine = (value: unknown, limit: number): string => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim().slice(0, limit) : "";

function detectLicense(root: string, rootNames: readonly string[], manifest?: Record<string, any>): string | undefined {
	const declared = oneLine(typeof manifest?.license === "string" ? manifest.license : manifest?.license?.type, 40);
	if (declared) return declared;
	const file = rootNames.find((name) => SIGNALS.find((signal) => signal.key === "license")!.pattern.test(name));
	if (!file) return undefined;
	const text = head(join(root, file)).slice(0, 4000);
	return LICENSE_HINTS.find(([pattern]) => pattern.test(text))?.[1];
}

function readmeSummary(root: string, rootNames: readonly string[]): { tagline?: string; headings: string[] } {
	const file = rootNames.find((name) => /^readme(?:\.[a-z]+)?$/i.test(name));
	if (!file) return { headings: [] };
	let title = "", paragraph = "", paragraphDone = false, fence = false;
	const headings: string[] = [];
	for (const raw of head(join(root, file)).split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith("```")) { fence = !fence; continue; }
		if (fence) continue;
		if (!line) { if (paragraph) paragraphDone = true; continue; }
		const heading = /^(#{1,3})\s+(.+?)\s*#*$/.exec(line);
		if (heading) {
			const text = oneLine(heading[2].replace(/[*_`[\]]/g, ""), 80);
			if (heading[1] === "#" && !title) title = text;
			else if (text && headings.length < 24) headings.push(text);
			continue;
		}
		if (!paragraphDone && !/^(?:\[!\[|!\[|<)/.test(line)) paragraph += `${paragraph ? " " : ""}${oneLine(line.replace(/[*_`]/g, ""), 300)}`.slice(0, 400);
	}
	const text = [title, paragraph.trim()].filter(Boolean).join(" — ");
	return { ...(text ? { tagline: text.slice(0, 420) } : {}), headings };
}

function latestTag(root: string): string | undefined {
	const tags: string[] = [];
	try {
		if (!lstatSync(join(root, '.git')).isDirectory()) return undefined;
		const refs = join(root, ".git", "refs", "tags");
		if (existsSync(refs) && !lstatSync(join(root, '.git', 'refs')).isSymbolicLink() && !lstatSync(refs).isSymbolicLink()) {
			const dir = opendirSync(refs);
			try { for (let entry = dir.readSync(); entry && tags.length < 500; entry = dir.readSync()) if (entry.isFile()) tags.push(entry.name); }
			finally { dir.closeSync(); }
		}
		const packed = head(join(root, ".git", "packed-refs"));
		for (const match of packed.matchAll(/refs\/tags\/(\S+)/g)) tags.push(match[1]);
	} catch { /* A project without readable tags simply has none to report. */ }
	const version = (tag: string) => tag.replace(/^v/i, "").split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
	return [...new Set(tags)].filter((tag) => /\d/.test(tag)).sort((a, b) => {
		const [x, y] = [version(a), version(b)];
		for (let index = 0; index < Math.max(x.length, y.length); index++) if ((x[index] ?? 0) !== (y[index] ?? 0)) return (y[index] ?? 0) - (x[index] ?? 0);
		return 0;
	})[0];
}

export function profileProject(directory: string): ProjectProfile {
	const root = resolve(directory);
	if (!statSync(root).isDirectory()) throw new Error("profile path must be a directory");
	const rootNames: string[] = [];
	let truncated = false;
	const listing = opendirSync(root);
	try {
		let entries = 0;
		for (let entry = listing.readSync(); entry; entry = listing.readSync()) {
			if (++entries > MAX_ENTRIES) { truncated = true; break; }
			if (entry.name !== '.env' && !entry.name.startsWith('.env.')) rootNames.push(entry.name);
		}
	} finally { listing.closeSync(); }
	rootNames.sort();
	const counts = new Map<string, number>();
	let scanned = 0, visited = 0, sourceFiles = 0, exhausted = false;
	const walk = (dir: string, depth: number) => {
		if (exhausted) return;
		let entries: ReturnType<typeof opendirSync>;
		try { entries = opendirSync(dir); } catch { truncated = true; return; }
		try {
			const names: import('node:fs').Dirent[] = [];
			for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
				if (names.length >= MAX_ENTRIES - visited) { truncated = true; break; }
				names.push(entry);
			}
			for (const entry of names.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
				if (exhausted || ++visited > MAX_ENTRIES) { exhausted = true; truncated = true; break; }
				if (entry.isSymbolicLink()) continue;
				if (entry.isDirectory()) {
					if (!SKIP_DIRS.has(entry.name)) { if (depth < MAX_DEPTH) walk(join(dir, entry.name), depth + 1); else truncated = true; }
					continue;
				}
				if (!entry.isFile()) continue;
				if (++scanned > MAX_FILES) { exhausted = true; truncated = true; break; }
				const language = LANGUAGES[extname(entry.name).toLowerCase()];
				if (language) { counts.set(language, (counts.get(language) ?? 0) + 1); sourceFiles++; }
			}
		} finally { entries.closeSync(); }
	};
	walk(root, 0);

	const manifestNames = rootNames.filter((name) => MANIFESTS.test(name));
	const pkg = rootNames.includes("package.json") ? readJson(join(root, "package.json")) : undefined;
	const bins = pkg?.bin && typeof pkg.bin === "object" ? Object.keys(pkg.bin) : typeof pkg?.bin === "string" ? [oneLine(pkg.name, 80)] : [];
	const readme = readmeSummary(root, rootNames);
	const description = oneLine(pkg?.description, 240) || undefined;
	const license = detectLicense(root, rootNames, pkg);
	const tag = latestTag(root);
	return {
		name: oneLine(pkg?.name, 80) || basename(root),
		...(description ? { description } : {}),
		languages: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, files]) => ({ name, files, percent: Math.round((files / Math.max(1, sourceFiles)) * 100) })),
		sourceFiles,
		filesScanned: Math.min(scanned, MAX_FILES),
		truncated,
		manifests: manifestNames,
		declared: {
			scripts: pkg?.scripts && typeof pkg.scripts === "object" ? Object.keys(pkg.scripts).slice(0, 30) : [],
			bins: bins.filter(Boolean).slice(0, 10),
			dependencies: Object.keys({ ...(pkg?.dependencies ?? {}), ...(pkg?.peerDependencies ?? {}) }).slice(0, 30),
			devDependencies: pkg?.devDependencies && typeof pkg.devDependencies === "object" ? Object.keys(pkg.devDependencies).length : 0,
		},
		...(license ? { license } : {}),
		signals: layoutSignals(rootNames),
		root: rootNames.slice(0, 60).map((name) => { try { return statSync(join(root, name)).isDirectory() ? `${name}/` : name; } catch { return name; } }),
		...(readme.tagline ? { tagline: readme.tagline } : {}),
		capabilityHeadings: readme.headings,
		...(tag ? { latestTag: tag } : {}),
	};
}
