/**
 * Child Git authority: tool-layer commit=false / push=false for subagents.
 *
 * Every pi-subagents child process receives PI_GIT_AUTHORITY=read-only by
 * default (set in runs/shared/pi-args.ts regardless of prompt text). The
 * always-loaded child runtime extension (subagent-prompt-runtime) blocks
 * Git verbs that create commits or publish refs while authority is
 * read-only. Delegation is explicit per child launch (step `gitAuthority:`
 * true) and never inherited: a delegated child's own children default back
 * to read-only unless they are delegated in turn.
 *
 * Interactive parent sessions never have PI_GIT_AUTHORITY set, so this gate
 * is inert for them; their existing bash review rules still apply.
 *
 * Scan precision: only bodies the shell would EXECUTE are scanned — direct
 * git commands, $()/backtick command substitution, the script after a shell
 * -c option, and eval arguments. Plain quoted data (`echo "git push"`) is
 * not executed and is not a violation. This module is pure and
 * table-driven so the denial surface can be exercised directly by
 * scripts/bench/git-authority-test.mjs.
 */

/** Environment variable carrying the authority mode into the child. */
export const PI_GIT_AUTHORITY_ENV = "PI_GIT_AUTHORITY";

/** Modes: "read-only" (child default) or "delegate" (explicit delegation). */
export type GitAuthorityMode = "read-only" | "delegate";

/** Git verbs that create commits, rewrite history, or publish refs. */
export const GIT_MUTATION_VERBS: readonly string[] = [
	"commit",
	"push",
	"pull",
	"merge",
	"cherry-pick",
	"revert",
	"rebase",
	"am",
	"filter-branch",
];

/** Global git options that consume the next token as their value. */
const GIT_OPTION_VALUE_FLAGS: ReadonlySet<string> = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--exec-path",
]);

const GIT_MUTATING_VERBS = new Set(GIT_MUTATION_VERBS);
const SHELL_NAMES = new Set(["bash", "sh", "dash", "zsh", "ksh"]);

/** Bounded scan: a child command larger than this is itself suspect. */
const MAX_COMMAND_CHARS = 64000;

export interface GitAuthorityViolation {
	/** "git-verb": a denied git subcommand; "publish-script": known publisher. */
	kind: "git-verb" | "publish-script";
	/** Denied verb when kind is "git-verb". */
	verb?: string;
	/** Offending command segment (bounded, quoting-resolution independent). */
	segment: string;
}

/** Resolve the effective authority mode from an environment. */
export function gitAuthorityFromEnv(
	env: Record<string, string | undefined> | NodeJS.ProcessEnv,
): GitAuthorityMode | undefined {
	const raw = env[PI_GIT_AUTHORITY_ENV];
	if (raw === "read-only" || raw === "delegate") return raw;
	return undefined;
}

/** A literal token, a quoted body (data), or an executed command substitution. */
type Token = string | { quoted: string } | { exec: string };

function isQuoted(token: Token): token is { quoted: string } {
	return typeof token === "object" && "quoted" in token;
}

function isExec(token: Token): token is { exec: string } {
	return typeof token === "object" && "exec" in token;
}

function plain(token: Token): string | undefined {
	return typeof token === "string" ? token : undefined;
}

interface Cursor {
	source: string;
	index: number;
}

function readQuoted(cursor: Cursor): string {
	const quote = cursor.source[cursor.index];
	cursor.index++;
	let value = "";
	while (cursor.index < cursor.source.length) {
		const char = cursor.source[cursor.index];
		if (char === "\\" && quote === '"' && cursor.index + 1 < cursor.source.length) {
			value += cursor.source[cursor.index + 1];
			cursor.index += 2;
			continue;
		}
		if (char === quote) {
			cursor.index++;
			return value;
		}
		value += char;
		cursor.index++;
	}
	return value; // unterminated quote: take the rest, still scanned
}

/** Consume a $(...)/backtick substitution, returning its contents. */
function readCommandSubstitution(cursor: Cursor, closer: string): string {
	let depth = 1;
	let value = "";
	while (cursor.index < cursor.source.length) {
		const char = cursor.source[cursor.index];
		if (char === "(" && closer === ")") depth++;
		if (char === closer) {
			depth--;
			if (depth === 0) {
				cursor.index++;
				return value;
			}
		}
		if (char === "'" || char === '"') {
			value += char;
			cursor.index++;
			value += readQuoted(cursor);
			value += cursor.source[cursor.index - 1] ?? "";
			continue;
		}
		value += char;
		cursor.index++;
	}
	return value; // unterminated: scanned contents conservatively
}

/** Tokenize one command, stopping at a shell separator. Quoted bodies are
 *  preserved as markers so only executed payloads can be re-scanned. */
function tokenizeUntilSeparator(cursor: Cursor): Token[] {
	const tokens: Token[] = [];
	let token = "";
	const push = () => {
		if (token) tokens.push(token);
		token = "";
	};
	while (cursor.index < cursor.source.length) {
		const char = cursor.source[cursor.index];
		if (char === ";" || char === "\n" || char === "|") {
			push();
			cursor.index++;
			return tokens;
		}
		if (char === "&") {
			// "&&" separates commands; a lone "&" backgrounds the current one.
			push();
			cursor.index += cursor.source[cursor.index + 1] === "&" ? 2 : 1;
			return tokens;
		}
		if (char === "'" || char === '"') {
			push();
			tokens.push({ quoted: readQuoted(cursor) });
			continue;
		}
		if (char === "`") {
			cursor.index++;
			push();
			tokens.push({ exec: readCommandSubstitution(cursor, "`") });
			continue;
		}
		if (char === "$" && cursor.source[cursor.index + 1] === "(") {
			cursor.index += 2;
			push();
			tokens.push({ exec: readCommandSubstitution(cursor, ")") });
			continue;
		}
		if (/\s/.test(char)) {
			push();
			cursor.index++;
			continue;
		}
		token += char;
		cursor.index++;
	}
	push();
	return tokens;
}

function abbreviation(tokens: Token[]): string {
	const rendered = tokens
		.map((token) => (isQuoted(token) ? `"${token.quoted}"` : token))
		.join(" ");
	return rendered.length <= 300 ? rendered : `${rendered.slice(0, 300)}…`;
}

/** Direct git invocation: skip env assignments/wrappers, then global options
 *  (with values for -C/-c/--git-dir/…), and read the subcommand verb. */
function inspectDirectGit(tokens: Token[]): GitAuthorityViolation | undefined {
	let start = 0;
	while (
		start < tokens.length &&
		!isQuoted(tokens[start]) &&
		(/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start] as string) || ["sudo", "nohup"].includes(tokens[start] as string))
	) {
		start++;
	}
	if (start >= tokens.length || isQuoted(tokens[start])) return undefined;
	if ((tokens[start] as string).replace(/^.*\//, "") !== "git") return undefined;
	let index = start + 1;
	while (index < tokens.length && !isQuoted(tokens[index])) {
		const flag = tokens[index] as string;
		if (flag === "-" || !flag.startsWith("-")) break;
		if (GIT_OPTION_VALUE_FLAGS.has(flag)) index++; // consume the value
		index++;
	}
	const verb = plain(tokens[index] ?? "");
	if (verb === undefined) return undefined;
	if (GIT_MUTATING_VERBS.has(verb)) return { kind: "git-verb", verb };
	// git-<verb> helper spelling (e.g. hub-style dispatch aliases).
	if (verb.startsWith("git-") && GIT_MUTATING_VERBS.has(verb.slice(4))) {
		return { kind: "git-verb", verb };
	}
	return undefined;
}

function scanExecutedBodies(tokens: Token[]): GitAuthorityViolation | undefined {
	const direct = inspectDirectGit(tokens);
	if (direct) return direct;
	// Command substitution bodies ($(...) and `...`) always execute; plain
	// quoted data (echo "git push") never scans here, only shell -c/eval payloads.
	for (const token of tokens) {
		if (isExec(token)) {
			const inner = scanGitAuthorityViolation(token.exec);
			if (inner) return inner;
		}
	}
	return undefined;
}

/**
 * Scan a shell command for Git operations denied under read-only authority.
 * Recurses into command substitution, shell -c scripts and eval arguments so
 * a child cannot smuggle a commit through an inner shell, while plain data
 * in quotes stays exempt. Publish scripts that perform the remote exchange
 * themselves are denied under the same authority.
 */
export function scanGitAuthorityViolation(command: string): GitAuthorityViolation | undefined {
	if (typeof command !== "string" || command.length === 0) return undefined;
	if (command.length > MAX_COMMAND_CHARS) {
		return { kind: "git-verb", segment: "command exceeds the reviewable size bound" };
	}
	const cursor: Cursor = { source: command, index: 0 };
	while (cursor.index < cursor.source.length) {
		while (cursor.index < cursor.source.length && /\s/.test(cursor.source[cursor.index])) cursor.index++;
		if (cursor.index >= cursor.source.length) break;
		const tokens = tokenizeUntilSeparator(cursor);
		if (tokens.length === 0) continue;
		const violation = scanExecutedBodies(tokens);
		if (violation) {
			return violation.segment ? violation : { ...violation, segment: abbreviation(tokens) };
		}
		// Shell -c / eval: the following argument is the executed script.
		const head = isQuoted(tokens[0]!) || isExec(tokens[0]!) ? undefined : (tokens[0] as string);
		if (head === undefined) continue;
		const headName = head.replace(/^.*\//, "");
		if (SHELL_NAMES.has(headName) || headName === "eval") {
			const scriptIndex = headName === "eval"
				? 0
				: tokens.findIndex((token) => !isQuoted(token) && !isExec(token) && /^-[a-z]*c[a-z]*$/.test(token as string));
			const scriptToken = scriptIndex >= 0 ? tokens[scriptIndex + 1] : undefined;
			if (scriptToken !== undefined) {
				// Quoted after -c: the shell executes the quoted body verbatim.
				const script = typeof scriptToken === "string" ? scriptToken : isQuoted(scriptToken) ? scriptToken.quoted : undefined;
				if (typeof script === "string" && script) {
					const inner = scanGitAuthorityViolation(script);
					if (inner) return inner;
				}
			}
		}
	}
	// Publish path: the harness release runner commits and pushes internally.
	if (/publish-public/.test(command)) {
		return { kind: "publish-script", segment: "harness publish runner invocation" };
	}
	return undefined;
}

/** Compose the machine-readable tool-layer denial. */
export function formatGitAuthorityReason(violation: GitAuthorityViolation): string {
	if (violation.kind === "publish-script") {
		return "Blocked: child Git authority is read-only and release/publish runners internally commit and push. Finish the change, then ask the owning parent session to publish. No repository state was changed. " +
			JSON.stringify({ gitAuthority: "read-only", denial: "publish-script" });
	}
	return `Blocked: child Git authority is read-only, so 'git ${violation.verb}' (commit/publish Git state) is denied at the tool layer. Produce the source changes only; the parent session owns integration. Delegation requires an explicit launch option (gitAuthority). No repository state was changed. ` +
		JSON.stringify({ gitAuthority: "read-only", denial: violation.verb });
}

/** Tool-layer decision for bash/bg_run under the resolved authority.
 *  Undefined (allow) for every non-violating call/tool; a block result only
 *  for denied Git operations while authority is read-only. The always-loaded
 *  child runtime registers exactly this decision, so task prompts cannot
 *  bypass it and benches can exercise it without heavy runtime imports. */
export function gitAuthorityToolDecision(
	env: Record<string, string | undefined> | NodeJS.ProcessEnv,
	toolName: unknown,
	command: unknown,
): { block: true; reason: string } | undefined {
	if (gitAuthorityFromEnv(env) !== "read-only") return undefined;
	if (toolName !== "bash" && toolName !== "bg_run") return undefined;
	if (typeof command !== "string" || command.length === 0) return undefined;
	const violation = scanGitAuthorityViolation(command);
	return violation ? { block: true, reason: formatGitAuthorityReason(violation) } : undefined;
}
