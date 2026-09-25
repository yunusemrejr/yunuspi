import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { Tokenizer } from "htmlparser2";
import type { AcceptanceFileContract, AcceptanceRuntimeCheck } from "../../shared/types.ts";

const MAX_FILES = 32;
const MAX_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * MAX_BYTES;
const CONTAINERS = new Set(["div", "main", "section", "article", "aside", "header", "footer", "nav", "form", "button", "h1"]);
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
type HtmlShape = { h1: number; orphan: Record<string, number>; unclosed: Record<string, number>; scripts: string[]; incompleteScripts: number };
type FileState = { exists: boolean; hash?: string; html?: HtmlShape; error?: string };
export type FileVerificationBaseline = { contract: AcceptanceFileContract; cwd: string; files: Record<string, FileState> };

export function validateFileContract(value: unknown, label = "acceptance.files"): string[] {
	if (value === undefined) return [];
	if (!value || typeof value !== "object" || Array.isArray(value)) return [`${label} must be an object with exact file paths in scope, unchanged, or unchangedScripts.`];
	const errors: string[] = [];
	const paths = new Set<string>();
	for (const [key, list] of Object.entries(value)) {
		if (!["scope", "unchanged", "unchangedScripts"].includes(key)) { errors.push(`${label}.${key} is not supported.`); continue; }
		if (!Array.isArray(list)) { errors.push(`${label}.${key} must be an array of exact cwd-relative paths.`); continue; }
		for (const file of list) {
			if (typeof file !== "string" || !file.trim() || file.length > 1024 || /[\x00-\x1f*?\[\]]/.test(file) || path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) errors.push(`${label}.${key} contains an invalid path; use exact cwd-relative files without globs or traversal.`);
			else paths.add(file);
		}
	}
	if (paths.size === 0 || paths.size > MAX_FILES) errors.push(`${label} requires 1-${MAX_FILES} distinct files.`);
	return errors;
}

/** Blank PHP code while keeping template text. A PHP block ends at `?>` or at
 * end of file (the closing tag is conventionally omitted); heredoc/nowdoc
 * bodies inside it are HTML templates and stay visible. Without the EOF case
 * the tokenizer read `<?php … <<<'HTML' <div …>` as one processing
 * instruction, swallowed the first container and rejected balanced files. */
export function maskPhpCode(source: string): string {
	const blank = (value: string) => value.replace(/[^\n]/g, " ");
	return source.replace(/<\?(?:php\b|=)?[\s\S]*?(?:\?>|$(?![\s\S]))/g, (block) => {
		let out = "", at = 0;
		for (const match of block.matchAll(/<<<[ \t]*(['"]?)([A-Za-z_]\w*)\1[ \t]*\r?\n/g)) {
			if (match.index! < at) continue;
			const bodyStart = match.index! + match[0].length;
			const end = new RegExp(`^[ \\t]*${match[2]}\\b`, "m").exec(block.slice(bodyStart));
			if (!end) break;
			const bodyEnd = bodyStart + end.index;
			out += blank(block.slice(at, bodyStart)) + block.slice(bodyStart, bodyEnd);
			at = bodyEnd;
		}
		return out + blank(block.slice(at));
	});
}

// Tokenizer preserves explicit closing tags (a DOM parser silently repairs them).
// Compare only definite container balances; optional HTML end tags are excluded.
export function inspectStaticHtml(source: string): HtmlShape {
	const text = maskPhpCode(source);
	const result: HtmlShape = { h1: 0, orphan: {}, unclosed: {}, scripts: [], incompleteScripts: 0 };
	let tag = "", openStart = 0, scriptStart: number | undefined;
	const noop = () => {};
	const tokenizer = new Tokenizer({ decodeEntities: false }, {
		onopentagname(start, end) { tag = text.slice(start, end).toLowerCase(); openStart = start - 1; },
		onopentagend() {
			if (tag === "h1") result.h1++;
			if (CONTAINERS.has(tag)) result.unclosed[tag] = (result.unclosed[tag] ?? 0) + 1;
			if (tag === "script") scriptStart = openStart;
		},
		onclosetag(start, end) {
			const name = text.slice(start, end).toLowerCase();
			if (CONTAINERS.has(name)) {
				if (result.unclosed[name]) result.unclosed[name]--;
				else result.orphan[name] = (result.orphan[name] ?? 0) + 1;
			}
			if (name === "script") {
				if (scriptStart === undefined) result.incompleteScripts++;
				else { result.scripts.push(digest(source.slice(scriptStart, text.indexOf(">", end) + 1))); scriptStart = undefined; }
			}
		},
		onselfclosingtag() {
			// HTML non-void <div/> does not close a div; script/style self-closing is invalid too.
			if (tag === "h1") result.h1++;
			if (CONTAINERS.has(tag)) result.unclosed[tag] = (result.unclosed[tag] ?? 0) + 1;
			if (tag === "script") result.incompleteScripts++;
		},
		onattribdata: noop, onattribentity: noop, onattribend: noop, onattribname: noop,
		oncdata: noop, oncomment: noop, ondeclaration: noop, onend: noop,
		onprocessinginstruction: noop, ontext: noop, ontextentity: noop,
	});
	tokenizer.write(text); tokenizer.end();
	if (scriptStart !== undefined) result.incompleteScripts++;
	return result;
}

function readState(cwd: string, file: string, budget: { remaining: number }, scripts: boolean): FileState {
	try {
		const target = path.resolve(cwd, file);
		const relative = path.relative(cwd, target);
		if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("path is outside the execution directory");
		let current = cwd;
		for (const part of relative.split(path.sep)) {
			current = path.join(current, part);
			try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error("symlink paths are unsupported"); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false }; throw error; }
		}
		const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		let bytes: Buffer;
		try {
			const stat = fs.fstatSync(fd);
			if (!stat.isFile()) throw new Error("not a regular file");
			if (stat.size > MAX_BYTES || stat.size > budget.remaining) throw new Error("verification byte limit exceeded (1 MiB/file, 8 MiB total)");
			// Bounded read even if a concurrent writer grows the file after fstat.
			const buffer = Buffer.alloc(Math.min(MAX_BYTES, budget.remaining) + 1);
			let length = 0, count = 0;
			do { count = fs.readSync(fd, buffer, length, buffer.length - length, null); length += count; } while (count && length < buffer.length);
			if (length > MAX_BYTES || length > budget.remaining) throw new Error("verification byte limit exceeded");
			bytes = buffer.subarray(0, length); budget.remaining -= length;
		} finally { fs.closeSync(fd); }
		const html = scripts || /\.(?:html?|php)$/i.test(file);
		let shape: HtmlShape | undefined;
		if (html) {
			const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			shape = inspectStaticHtml(source);
		}
		return { exists: true, hash: digest(bytes), html: shape };
	} catch (error) { return { exists: false, error: error instanceof Error ? error.message : String(error) }; }
}

export function captureFileVerification(contract: AcceptanceFileContract | undefined, cwd: string): FileVerificationBaseline | undefined {
	if (!contract) return undefined;
	const errors = validateFileContract(contract);
	if (errors.length) throw new Error(errors.join(" "));
	const cloned = { scope: [...(contract.scope ?? [])], unchanged: [...(contract.unchanged ?? [])], unchangedScripts: [...(contract.unchangedScripts ?? [])] };
	const files: Record<string, FileState> = Object.create(null);
	const root = fs.realpathSync(cwd), budget = { remaining: MAX_TOTAL_BYTES };
	for (const file of new Set([...cloned.scope, ...cloned.unchanged, ...cloned.unchangedScripts])) files[file] = readState(root, file, budget, cloned.unchangedScripts.includes(file));
	return { contract: cloned, cwd: root, files };
}

export function verifyFileContract(contract: AcceptanceFileContract | undefined, baseline: FileVerificationBaseline | undefined, cwd: string): AcceptanceRuntimeCheck[] {
	if (!contract) return [];
	let actualCwd: string | undefined;
	try { actualCwd = fs.realpathSync(cwd); } catch { /* Removed/unreadable cwd is a failed check, never a skipped acceptance. */ }
	if (!baseline || JSON.stringify(baseline.contract) !== JSON.stringify({ scope: [...(contract.scope ?? [])], unchanged: [...(contract.unchanged ?? [])], unchangedScripts: [...(contract.unchangedScripts ?? [])] }) || actualCwd !== baseline.cwd) return [{ id: "file-contract:baseline", status: "failed", message: "Independent file verification unavailable: matching pre-launch baseline or execution directory missing." }];
	const checks: AcceptanceRuntimeCheck[] = [], budget = { remaining: MAX_TOTAL_BYTES };
	for (const [file, before] of Object.entries(baseline.files)) {
		const after = readState(baseline.cwd, file, budget, contract.unchangedScripts?.includes(file) ?? false);
		const failures: string[] = [];
		if (before.error) failures.push(`baseline unavailable: ${before.error}`);
		if (after.error) failures.push(`current file unavailable: ${after.error}`);
		else if (!after.exists) failures.push("declared file is missing");
		if (contract.unchanged?.includes(file) && (!before.exists || before.hash !== after.hash)) failures.push("required unchanged file bytes differ or baseline is missing");
		if (contract.unchangedScripts?.includes(file) && (!before.exists || !before.html || !after.html || before.html.incompleteScripts || after.html.incompleteScripts || JSON.stringify(before.html.scripts) !== JSON.stringify(after.html.scripts))) failures.push("required unchanged script blocks differ or cannot be verified");
		if (contract.scope?.includes(file) && after.html) {
			if (after.html.h1 < (before.html?.h1 ?? 0)) failures.push(`existing h1 count decreased (${before.html!.h1} to ${after.html.h1})`);
			for (const kind of ["orphan", "unclosed"] as const) for (const [tag, count] of Object.entries(after.html[kind])) if (count > (before.html?.[kind][tag] ?? 0)) failures.push(`new ${kind} <${tag}> balance (${before.html?.[kind][tag] ?? 0} to ${count})`);
		}
		checks.push({ id: `file-contract:${file}`, status: failures.length ? "failed" : "passed", message: failures.length ? `${file}: ${failures.join("; ")}.` : `${file}: declared file checks passed${contract.scope?.includes(file) && after.html ? " (existing h1 count and static container balance)" : ""}. These bounded source checks do not establish rendered behavior or full HTML validity.` });
	}
	return checks;
}

export function hasFailedFileVerification(checks: readonly AcceptanceRuntimeCheck[]): boolean {
	return checks.some((check) => check.id.startsWith("file-contract:") && check.status === "failed");
}

/** Attribute only direct, successful native tool writes from this child's transcript. */
export function verifyObservedWriteScope(contract: AcceptanceFileContract | undefined, messages: readonly unknown[] | undefined, cwd: string): AcceptanceRuntimeCheck[] {
	if (!contract?.scope?.length) return [];
	const allowed = new Set(contract.scope.map((file) => path.resolve(cwd, file)));
	const calls = new Map<string, { name: string; target?: string }>();
	const outside = new Set<string>();
	let writes = 0, shellResults = 0;
	for (const value of messages ?? []) {
		if (!value || typeof value !== "object") continue;
		const message = value as Record<string, any>;
		if (message.role === "assistant" && Array.isArray(message.content)) for (const call of message.content) {
			if (call?.type !== "toolCall" || typeof call.id !== "string" || typeof call.name !== "string") continue;
			calls.set(call.id, { name: call.name, target: call.arguments?.path ?? call.arguments?.file_path });
		}
		if (message.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
		const call = calls.get(message.toolCallId); calls.delete(message.toolCallId);
		if (!call || message.isError === true || message.error) continue;
		if (call.name === "bash") shellResults++;
		if (!["write", "edit"].includes(call.name) || typeof call.target !== "string") continue;
		const target = path.resolve(cwd, call.target);
		const relative = path.relative(cwd, target);
		// Scope constrains the project change, not scratch: temp helpers and
		// harness-instructed artifact writes outside the tree are not project
		// edits (shell writes there are unattributed by this check too).
		if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
		// Project-scoped harness artifacts are runtime data, not edits. The
		// directory is owned by pi-subagents/src/shared/artifacts.ts
		// (PROJECT_SUBAGENTS_RELATIVE_DIR); repeated here so this light
		// verifier does not inherit that module's dependency graph.
		if (relative === ".pi/subagents" || relative.startsWith(`.pi/subagents${path.sep}`)) continue;
		writes++;
		if (!allowed.has(target)) outside.add(call.target);
	}
	return [{ id: "file-contract:write-scope", status: outside.size ? "failed" : writes ? "passed" : "not-applicable", message: outside.size
		? `Successful native write/edit calls targeted files outside declared scope: ${[...outside].slice(0, 8).join(", ")}.`
		: `Observed ${writes} successful native write/edit calls within declared scope. ${shellResults ? `${shellResults} successful shell results were observed; their file writes are not attributed by this check.` : "Shell, external processes and concurrent writers are not attributed by this check."}` }];
}

/** Delivery annotation only: never append this to structured child output. */
export function fileVerificationSummary(acceptance?: { runtimeChecks?: readonly AcceptanceRuntimeCheck[] }): string {
 const checks = acceptance?.runtimeChecks?.filter((check) => check.id.startsWith("file-contract:")) ?? [];
 if (!checks.length) return "";
 if (checks.some((check) => check.id === "file-contract:coverage")) return "Independent file checks: not requested (no declared file baseline). Worker preservation claims remain unverified.";
 const failed = checks.filter((check) => check.status === "failed").length;
 return failed ? `Independent file checks: FAILED (${failed}/${checks.length}); inspect acceptance diagnostics before using this output.` : `Independent file checks: ${checks.filter((check) => check.status === "passed").length} passed; native write scope only where observed. Shell-write attribution, rendered behavior and full HTML validity remain unverified.`;
}
