import { execFile } from "node:child_process";
import type { ExtractedContent } from "./extract.ts";
import type { GitHubUrlInfo } from "./github-extract.ts";
import { encodeRepoPath, githubRest } from "./github-rest.ts";

const MAX_TREE_ENTRIES = 200;
const MAX_INLINE_FILE_CHARS = 100_000;

let ghAvailable: boolean | null = null;
let ghHintShown = false;

export async function checkGhAvailable(signal?: AbortSignal): Promise<boolean> {
	if (ghAvailable !== null) return ghAvailable;

	return new Promise((resolve) => {
		execFile("gh", ["--version"], { timeout: 5000, ...(signal ? { signal } : {}) }, (err) => {
			const available = !err;
			if (!signal?.aborted) ghAvailable = available;
			resolve(available);
		});
	});
}

export function showGhHint(): void {
	if (!ghHintShown) {
		ghHintShown = true;
		console.error("[pi-web-access] Install the `gh` CLI or set GITHUB_TOKEN for private repositories and higher GitHub API limits.");
	}
}

export async function checkRepoSize(owner: string, repo: string, signal?: AbortSignal): Promise<number | null> {
	const response = await githubRest<{ size?: unknown }>(`/repos/${owner}/${repo}`, { ...(signal ? { signal } : {}) }).catch(() => undefined);
	const kb = response?.ok ? response.data?.size : undefined;
	return typeof kb === "number" && Number.isFinite(kb) ? kb : null;
}

async function getDefaultBranch(owner: string, repo: string, signal?: AbortSignal): Promise<string | null> {
	const response = await githubRest<{ default_branch?: unknown }>(`/repos/${owner}/${repo}`, { ...(signal ? { signal } : {}) }).catch(() => undefined);
	const branch = response?.ok ? response.data?.default_branch : undefined;
	return typeof branch === "string" && branch ? branch : null;
}

async function fetchTreeViaApi(owner: string, repo: string, ref: string, signal?: AbortSignal): Promise<string | null> {
	const response = await githubRest<{ tree?: Array<{ path?: unknown }> }>(
		`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}`,
		{ query: { recursive: 1 }, ...(signal ? { signal } : {}) },
	).catch(() => undefined);
	const paths = (response?.ok ? response.data?.tree ?? [] : []).map((entry) => entry.path).filter((path): path is string => typeof path === "string");
	if (paths.length === 0) return null;
	const truncated = paths.length > MAX_TREE_ENTRIES;
	const display = paths.slice(0, MAX_TREE_ENTRIES).join("\n");
	return truncated ? display + `\n... (${paths.length} total entries)` : display;
}

async function fetchReadmeViaApi(owner: string, repo: string, ref: string, signal?: AbortSignal): Promise<string | null> {
	const response = await githubRest(`/repos/${owner}/${repo}/readme`, { query: { ref }, raw: true, ...(signal ? { signal } : {}) }).catch(() => undefined);
	const text = response?.ok ? response.text : undefined;
	if (!text) return null;
	return text.length > 8192 ? text.slice(0, 8192) + "\n\n[README truncated at 8K chars]" : text;
}

async function fetchFileViaApi(owner: string, repo: string, path: string, ref: string, signal?: AbortSignal): Promise<string | null> {
	const response = await githubRest(`/repos/${owner}/${repo}/contents/${encodeRepoPath(path)}`, { query: { ref }, raw: true, ...(signal ? { signal } : {}) }).catch(() => undefined);
	return response?.ok && response.text !== undefined ? response.text : null;
}

export async function fetchViaApi(
	url: string,
	owner: string,
	repo: string,
	info: GitHubUrlInfo,
	sizeNote?: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	const ref = info.ref || (await getDefaultBranch(owner, repo, signal));
	if (!ref) return null;

	const lines: string[] = [];
	if (sizeNote) {
		lines.push(sizeNote);
		lines.push("");
	}

	if (info.type === "blob" && info.path) {
		const content = await fetchFileViaApi(owner, repo, info.path, ref, signal);
		if (!content) return null;

		lines.push(`## ${info.path}`);
		if (content.length > MAX_INLINE_FILE_CHARS) {
			lines.push(content.slice(0, MAX_INLINE_FILE_CHARS));
			lines.push(`\n[File truncated at 100K chars]`);
		} else {
			lines.push(content);
		}

		return {
			url,
			title: `${owner}/${repo} - ${info.path}`,
			content: lines.join("\n"),
			error: null,
		};
	}

	const [tree, readme] = await Promise.all([
		fetchTreeViaApi(owner, repo, ref, signal),
		fetchReadmeViaApi(owner, repo, ref, signal),
	]);

	if (!tree && !readme) return null;

	if (tree) {
		lines.push("## Structure");
		lines.push(tree);
		lines.push("");
	}

	if (readme) {
		lines.push("## README.md");
		lines.push(readme);
		lines.push("");
	}

	lines.push("This is an API-only view. Clone the repo or use `read`/`bash` for deeper exploration.");

	const title = info.path ? `${owner}/${repo} - ${info.path}` : `${owner}/${repo}`;
	return {
		url,
		title,
		content: lines.join("\n"),
		error: null,
	};
}
