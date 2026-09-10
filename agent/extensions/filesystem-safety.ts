/**
 * Filesystem Safety Extension
 *
 * Blocks destructive operations that target sensitive directories outside cwd.
 * Normal project work (git, cd, reads) is allowed even under protected ancestors
 * like ~/Desktop. Writes use cwd/temp, verified repository roots, and configured
 * skills during harness work; unknown ordinary scopes need one session approval.
 * Reads and authorized API credential use are not gated by these write scopes.
 *
 * Protected directories:
 * - / (root)
 * - /root
 * - /etc, /usr, /bin, /sbin, /boot, /lib(64), /var, /sys, /proc, /dev, /run, /opt, /srv
 * - ~ (home directory root)
 * - ~/Desktop
 * - ~/Documents
 * - ~/Downloads
 * - ~/Music
 * - ~/Pictures
 * - ~/Videos
 * - ~/.ssh
 * - ~/.gnupg
 * - ~/.aws
 * - ~/.config
 * - ~/.local
 *
 * Destructive commands blocked:
 * - rm -rf, rm -r (recursive deletes; NOTE: bare `rm -f <file>` has no `r` in
 *   its flag cluster and is NOT intercepted — single-file force deletes outside
 *   cwd are only guarded via the write/edit tool path checks)
 * - mkfs, fdisk, dd
 * - chmod, chown on system dirs
 * - mv, cp with force flag on protected paths
 *
 * Shell variable targets are RESOLVED, not blanket-blocked (the old rule
 * false-positived on the standard mktemp temp-copy workflow — e.g.
 * `E2E=$(mktemp -d); cp -r . "$E2E/"; rm -rf "$E2E"` was blocked because
 * "$E2E" contained a `$`). Assignments found in the same command text are
 * collected and classified: mktemp substitutions are ephemeral (allowed),
 * literals are expanded transitively and re-checked, and truly unknown
 * variables still fail closed with an actionable message.
 *
 * Pattern gating runs on a data-stripped view of the command (see
 * stripShellData): heredoc bodies, single-quoted spans, and data-only quoted
 * spans are blanked before DESTRUCTIVE/DANGEROUS/deploy-hazard regexes run,
 * so command PAYLOADS (scripts written via heredoc, commit messages,
 * documentation text describing destructive commands) can no longer trip the
 * guard, while executable constructs ($(), backticks, shell-consumer heredoc
 * bodies) and real quoted path operands stay fully guarded.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import { selfMutationDenial, SELF_MUTATION_ALLOWED, SELF_MUTATION_GUIDANCE } from "./lib/self-mutation-guard.ts";

const HOME = os.homedir();

// Protected directories - operations blocked unless inside project
const PROTECTED_DIRS = [
	"/",
	"/root",
	"/etc",
	"/usr",
	"/bin",
	"/sbin",
	"/boot",
	"/lib",
	"/lib64",
	"/var",
	"/sys",
	"/proc",
	"/dev",
	"/run",
	"/opt",
	"/srv",
	HOME,
	path.join(HOME, "Desktop"),
	path.join(HOME, "Documents"),
	path.join(HOME, "Downloads"),
	path.join(HOME, "Music"),
	path.join(HOME, "Pictures"),
	path.join(HOME, "Videos"),
	path.join(HOME, ".ssh"),
	path.join(HOME, ".gnupg"),
	path.join(HOME, ".aws"),
	path.join(HOME, ".config"),
	path.join(HOME, ".local"),
	path.join(HOME, ".env"),
];

// Destructive command patterns
const DESTRUCTIVE_PATTERNS = [
	// Any combined flag containing r (rm -r, rm -rf, rm -fr), --recursive, --force.
	// WHY: the old class required BOTH r and f in one token, so plain `rm -r dir`
	// slipped through every guard.
	/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*|--recursive|--force)\b/i, // rm -rf, rm -r, rm -f
	/\brm[ \t]+[^;\n|&]*\*/i, // rm with wildcards
	/(?:^|[;\n|&()]|\b(?:do|then|else|exec|xargs)\s)\s*(?:(?:sudo|command|env)\s+(?:-[\w-]+\s+)*)?(?:\/[\w./-]+\/)?mkfs(?:\.[\w-]+)?(?=\s|$)/i, // executed formatter, not an inventory word
	/(?:^|[;\n|&()]|\b(?:do|then|else|exec|xargs)\s)\s*(?:(?:sudo|command|env)\s+(?:-[\w-]+\s+)*)?(?:\/[\w./-]+\/)?fdisk(?=\s|$)/i, // executed partitioner
	/\bdd\s+.*of=\/dev\b/i, // dd to device
	// WHY: `\b\/\b` can never match a slash preceded by whitespace (no word
	// boundary between ' ' and '/'), so `chmod 777 /` was never caught. Require a
	// whitespace-adjacent slash instead; the protected-path check does the rest.
	/\bchmod\s+.*\s\//i, // chmod on root/system paths
	/\bchown\s+.*\s\//i, // chown on root/system paths
	/\bmv\s+.*\s+\/\s*$/i, // mv to root
	/\bcp\s+.*\s+\/\s*$/i, // cp to root
	// find with a destructive action: the {} placeholder of -exec rm (and
	// find's built-in -delete) is unknowable, so the search ROOTS are what the
	// protected-path check below validates.
	/\bfind\s+[^;\n]*\s-exec(?:dir)?\s+rm\b/i, // find … -exec(dir) rm …
	/\bfind\s+[^;\n]*\s-delete\b/i, // find … -delete
];

// Dangerous rm patterns (always blocked regardless of directory).
// PATTERN INDEX CONTRACT: index 0 (absolute-path rm) is the only pattern the
// ephemeral carve-out in isAlwaysDangerous may relax — see rmTargetsAllEphemeral.
const DANGEROUS_RM_PATTERNS = [
	/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*|--recursive)\s+[/~]/i, // rm -rf /...
	/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*|--recursive)\s+\./i, // rm -rf .
	/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*|--recursive)\s+\*/i, // rm -rf *
];

// Deploy-hazard patterns (compiled from the SSH-git deploy wisdom): operations
// that destroy remote/working-tree state and cannot be rolled back. Always
// blocked — the doctrine module says the same thing in prose; here it is code.
const DEPLOY_HAZARD_PATTERNS = [
	/\brsync\s+.*(--delete|--del)\b/i, // rsync --delete (prod syncs)
	/\bgit\s+push\s+.*(-f|--force)\b/i, // force push
	/\bgit\s+reset\s+--hard\b/i, // discard working tree + history
	/\bgit\s+clean\s+-[a-zA-Z]*f[a-zA-Z]*d[a-zA-Z]*x/i, // clean -fdx
	/\bssh\s+.*rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive)/i, // remote rm -rf
	/\bgit\s+push\s+.*--delete\b/i, // delete remote branch
];

function isPathProtected(targetPath: string, cwd: string): boolean {
	let resolved = path.resolve(cwd, targetPath);
	// Follow symlinks: a cwd-internal symlink pointing at a protected dir must
	// not defeat the guard. Nonexistent targets (new files) keep the lexical path.
	try {
		resolved = fs.realpathSync(resolved);
	} catch {
		// ENOENT or unreadable — lexical resolution is the best we can do.
	}
	const normalizedCwd = path.resolve(cwd);

	// Project files under a protected ancestor (e.g. ~/Desktop/...) are allowed.
	if (
		resolved === normalizedCwd ||
		resolved.startsWith(normalizedCwd + path.sep)
	) {
		return false;
	}

	// Ephemeral roots: the canonical system temp locations are never protected
	// targets — their CONTENT is routine temp-workflow material (mktemp copy
	// dirs, build scratch). The exact roots (/tmp, /var/tmp) stay guarded so a
	// blanket wipe of the whole temp dir still blocks, and the bash handler's
	// absolute-path `rm -rf /...` always-dangerous rule backstops both.
	if (resolved.startsWith("/tmp/") || resolved.startsWith("/var/tmp/")) {
		return false;
	}

	for (const protectedDir of PROTECTED_DIRS) {
		if (
			resolved === protectedDir ||
			resolved.startsWith(protectedDir + path.sep)
		) {
			return true;
		}
	}

	return false;
}

function isAlwaysDangerous(
	command: string,
	targetView: string = command,
): boolean {
	for (let i = 0; i < DANGEROUS_RM_PATTERNS.length; i++) {
		if (!DANGEROUS_RM_PATTERNS[i].test(command)) continue;
		// Ephemeral carve-out applies ONLY to the absolute-path pattern (index 0,
		// per the pattern-index contract): cleanup of mktemp-style dirs created in
		// a PREVIOUS shell invocation can only arrive as a literal /tmp path, so a
		// rm whose EVERY target resolves strictly beneath /tmp/ or /var/tmp/ is
		// ordinary temp hygiene, not an always-dangerous wipe. Exact roots and
		// traversal escapes (/tmp, /tmp/.., /tmp/../etc) stay blocked.
		if (i === 0 && rmTargetsAllEphemeral(targetView)) continue;
		return true;
	}
	return false;
}

function matchesDestructivePattern(command: string): boolean {
	for (const pattern of DESTRUCTIVE_PATTERNS) {
		if (pattern.test(command)) {
			return true;
		}
	}
	return false;
}

/**
 * Shell variable resolution for destructive-command targets.
 *
 * WHY: the old guard blanket-blocked every target containing `$` ("unresolved
 * shell variables can expand to anything — block rather than guess"). That
 * turned the standard mktemp temp-copy workflow into a guaranteed false
 * positive:
 *
 *   E2E=$(mktemp -d /tmp/e2e-XXXXXX)
 *   cp -r . "$E2E/"
 *   rm -rf "$E2E"          ← blocked: "$E2E" treated as possibly-protected
 *
 * Resolution strategy (heuristic, fail-closed):
 *   1. NAME=value assignments are collected from the whole command text
 *      (export/local/readonly/declare prefixes, quoted and $(…) RHSes).
 *   2. An RHS that is an mktemp command substitution classifies the variable
 *      as EPHEMERAL — mktemp creates under $TMPDIR (/tmp by default) unless
 *      its template/-p/--tmpdir argument resolves somewhere non-ephemeral
 *      (e.g. `mktemp -p $HOME/x`), in which case it is UNKNOWN instead.
 *   3. Any other command substitution (`$(…)`, backticks) → UNKNOWN.
 *   4. Otherwise the RHS is a literal that may reference other variables;
 *      references are resolved transitively (depth-capped; cycles → UNKNOWN).
 *   5. Unassigned names with hard conventions: TMPDIR/TMP/TEMP → EPHEMERAL;
 *      HOME → the real home dir; PWD → cwd (honouring the last `cd` seen in
 *      the command). Everything else unassigned → UNKNOWN.
 *   6. Expansion: EPHEMERAL vars become a proxy path under /tmp (never
 *      protected); UNKNOWN vars leave the target unresolvable.
 *   7. Unresolvable targets still block (fail closed — same "block rather
 *      than guess" policy as before), but the reason now says how to fix it.
 *      Resolved targets run the normal protected-path check, so $HOME,
 *      /etc, the project root, etc. stay protected.
 */

type VarInfo =
	| { kind: "ephemeral" }
	| { kind: "literal"; value: string }
	| { kind: "unknown" };

interface ShellVarState {
	/** name -> raw RHS (unquoted); may itself contain $refs or $(…) */
	assignments: Map<string, string>;
	/** raw argument of the last `cd` seen ($PWD afterwards reflects it) */
	lastCd?: string;
}

// NAME=value / NAME="value" / NAME=$(cmd) / NAME=`cmd`, optionally prefixed
// with export|readonly|local|declare. The leading character class avoids
// matching --flag=value and redirections; RHS alternatives match balanced
// quotes/parens or stop at the first shell separator for bare values.
const ASSIGNMENT_RE =
	/(?:^|[\s;(&|])(?:export\s+|readonly\s+|local\s+|declare\s+(?:-[a-zA-Z]+\s+)?)?([A-Za-z_][A-Za-z0-9_]*)=((?:\$\([^)]*\))|(?:`[^`\n]*`)|(?:"[^"\n]*")|(?:'[^'\n]*')|(?:[^\s;|&]*))/g;

// A standalone mktemp invocation — not part of a larger word such as
// mktemp-utils or /usr/bin/mktemp.d.
const MKTEMP_RE = /(?<![\w./-])mktemp(?![\w-])/;

/** Ephemeral-by-convention environment variables (always temp locations). */
const EPHEMERAL_ENV_VARS = new Set(["TMPDIR", "TMP", "TEMP"]);

function collectShellAssignments(command: string): ShellVarState {
	const state: ShellVarState = { assignments: new Map() };
	for (const match of command.matchAll(ASSIGNMENT_RE)) {
		let rhs = match[2];
		if (rhs.startsWith('"') || rhs.startsWith("'")) rhs = rhs.slice(1, -1);
		if (rhs === "") continue; // empty value resolves to nothing useful
		state.assignments.set(match[1], rhs);
	}
	// Track the last `cd <target>`: $PWD afterwards reflects it, so a target
	// like "$PWD/x" must resolve against the cd destination, not the tool cwd.
	for (const m of command.matchAll(
		/(?:^|[\s;&|])cd\s+("([^"\n]*)"|'([^'\n]*)'|(\S+))/g,
	)) {
		state.lastCd = (m[2] ?? m[3] ?? m[4] ?? "").replace(/^["']|["']$/g, "");
	}
	if (
		state.lastCd === undefined &&
		/(?:^|[\s;&|])cd\s*(?=$|[;|&\n])/m.test(command)
	) {
		state.lastCd = "~"; // bare `cd` goes home
	}
	return state;
}

function classifyRhs(
	rhs: string,
	state: ShellVarState,
	cwd: string,
	depth: number,
): VarInfo {
	if (rhs.includes("$(") || rhs.includes("`")) {
		// Command substitution — only mktemp (and bare pwd) results are classifiable.
		const body = rhs
			.replace(/^\$\(/, "")
			.replace(/\)$/, "")
			.replace(/`/g, "")
			.trim();
		if (body === "pwd") return { kind: "literal", value: cwd };
		if (MKTEMP_RE.test(rhs) && mktempCreatesEphemeral(rhs, state, cwd, depth)) {
			return { kind: "ephemeral" };
		}
		return { kind: "unknown" };
	}
	return { kind: "literal", value: rhs };
}

/**
 * Is the mktemp invocation inside `rhs` guaranteed to create an ephemeral
 * location? mktemp defaults to $TMPDIR (/tmp); an explicit template argument
 * or -p/--tmpdir DIR must itself resolve to /tmp, /var/tmp, or a relative
 * (cwd-scoped) path — anything else (e.g. `mktemp -p $HOME/x`) means we
 * cannot prove ephemerality.
 */
function mktempCreatesEphemeral(
	rhs: string,
	state: ShellVarState,
	cwd: string,
	depth: number,
): boolean {
	const idx = rhs.search(MKTEMP_RE);
	if (idx < 0) return false;
	const argText = rhs
		.slice(idx + "mktemp".length)
		// Stop the argument scan at substitution/quote terminators and separators.
		.replace(/[)'`]/g, " ")
		.split(/[;&|]/)[0];
	const toks = argText.trim().split(/\s+/).filter(Boolean);
	const locationOk = (p: string | undefined): boolean => {
		if (p === undefined || p === "") return true; // default $TMPDIR (=/tmp)
		const expanded = expandVars(
			p.replace(/^["']|["']$/g, ""), // a leading quote must not hide an absolute path
			state,
			cwd,
			depth + 1,
		);
		if (expanded === undefined) return false; // cannot prove ephemeral
		if (
			expanded === "/tmp" ||
			expanded === "/var/tmp" ||
			expanded.startsWith("/tmp/") ||
			expanded.startsWith("/var/tmp/")
		) {
			return true;
		}
		// Relative template → created under cwd (cwd-scoped writes are allowed anyway).
		return !expanded.startsWith("/") && !expanded.startsWith("~");
	};
	for (let i = 0; i < toks.length; i++) {
		const tok = toks[i];
		if (tok === "-p" || tok === "--tmpdir") return locationOk(toks[i + 1]);
		if (tok.startsWith("--tmpdir="))
			return locationOk(tok.slice("--tmpdir=".length));
		if (!tok.startsWith("-") && !locationOk(tok)) return false; // template argument
	}
	return true;
}

/** Resolve one variable name against command assignments + known conventions. */
function lookupVar(
	name: string,
	state: ShellVarState,
	cwd: string,
	depth: number,
): VarInfo | undefined {
	if (state.assignments.has(name)) {
		return classifyRhs(state.assignments.get(name) as string, state, cwd, depth);
	}
	if (EPHEMERAL_ENV_VARS.has(name)) return { kind: "ephemeral" };
	if (name === "HOME") return { kind: "literal", value: HOME };
	if (name === "PWD") {
		if (state.lastCd === undefined) return { kind: "literal", value: cwd };
		const cd = expandVars(state.lastCd, state, cwd, depth + 1);
		return cd === undefined
			? { kind: "unknown" }
			: { kind: "literal", value: cd };
	}
	return undefined; // unassigned, unknown → caller fails closed
}

/**
 * Expand $NAME / ${NAME} references in `text`. Returns undefined when any
 * reference is unknown/unresolvable (caller must then fail closed) or when
 * the result still contains shell syntax we do not model ($?, $(, backticks,
 * ${VAR:-default} …).
 */
function expandVars(
	text: string,
	state: ShellVarState,
	cwd: string,
	depth = 0,
): string | undefined {
	if (depth > 8) return undefined; // assignment cycle / runaway nesting
	let out = "";
	let last = 0;
	for (const m of text.matchAll(
		/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
	)) {
		const name = m[1] ?? m[2];
		const info = lookupVar(name, state, cwd, depth);
		let replacement: string | undefined;
		if (info?.kind === "ephemeral") {
			replacement = `/tmp/.guard-resolved-${name}`;
		} else if (info?.kind === "literal") {
			replacement = expandVars(info.value, state, cwd, depth + 1);
		}
		if (replacement === undefined) return undefined;
		out += text.slice(last, m.index) + replacement;
		last = m.index + m[0].length;
	}
	out += text.slice(last);
	if (out.includes("$") || out.includes("`")) return undefined;
	// Tilde expansion at the start only (shell semantics).
	if (out === "~" || out.startsWith("~/")) out = HOME + out.slice(1);
	return out;
}

function extractPathsFromCommand(command: string): string[] {
	const paths: string[] = [];

	// Drop redirections first: targets like /dev/null are redirect destinations,
	// not operands, and treating them as such false-blocks `rm -rf build/ > /dev/null`.
	const stripped = command
		.replace(/\s\d*>{1,2}\s*\S+/g, "")
		.replace(/\s\d*<\s*\S+/g, "");

	const parts = stripped.split(/\s+/);
	for (let i = 1; i < parts.length; i++) {
		const part = parts[i].replace(/[;|&><]+$/g, "").replace(/^["']|["']$/g, "");
		if (!part || part.startsWith("-")) continue;

		// WHY: NAME=… tokens are definitions (env prefixes, TMP=$(mktemp -d)),
		// not targets. Treating them as paths made the assignment line itself a
		// phantom "unresolved variable" target — e.g. `E2E=$(mktemp -d)` plus an
		// rm elsewhere in the same script blocked the whole script.
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(part)) continue;

		paths.push(part);
	}

	return paths;
}

/**
 * Blank out assignment spans (LHS + RHS) so a target list built from the
 * command cannot contain phantom tokens from an assignment's own RHS — e.g.
 * the `/tmp/e2e-XXXXXX)` leftover of `T=$(mktemp -d /tmp/e2e-XXXXXX)`.
 */
function stripAssignments(command: string): string {
	return command.replace(ASSIGNMENT_RE, (m) => " ".repeat(m.length));
}

/**
 * True when EVERY rm target in `command` resolves strictly beneath /tmp/ or
 * /var/tmp/ (the ephemeral carve-out). Exact roots and normalized escapes are
 * not ephemeral: /tmp, /var/tmp, /tmp/.., /tmp/../etc all stay blocked.
 */
function rmTargetsAllEphemeral(command: string): boolean {
	let found = false;
	for (const m of command.matchAll(
		/\brm\s+(?:(?:-[a-zA-Z]+|--recursive|--force)\s+)*([^\n;|&]*)/g,
	)) {
		const args = m[1]
			.split(/\s+/)
			.map((a) => a.replace(/^["']|["']$/g, ""))
			.filter(Boolean);
		if (args.length === 0) return false; // `rm -rf` bare — conservative
		for (const arg of args) {
			if (arg.includes("$")) return false; // unresolved variable → keep blocked
			const resolved = path.resolve(arg);
			if (resolved === "/tmp" || resolved === "/var/tmp") return false;
			if (!resolved.startsWith("/tmp/") && !resolved.startsWith("/var/tmp/")) {
				return false;
			}
		}
		found = true;
	}
	return found;
}

/**
 * Would a glob-bearing target's EXPANSION reach a protected tree? The literal
 * pattern (e.g. /home/*) is neither an existing path nor lexically under a
 * protected dir, but the shell expands it into real entries — evaluate the
 * static root (text before the first glob metachar, minus its partial
 * segment) and block when a protected directory sits AT or BENEATH that root.
 * This is a conservative containment check, not a shell parser.
 */
function globRootProtected(target: string, cwd: string): boolean {
	const cut = target.search(/[*?]/);
	if (cut < 0) return false;
	let t = target;
	if (t === "~" || t.startsWith("~/")) t = HOME + t.slice(1); // tilde expansion
	const prefix = t.slice(0, cut);
	const segIdx = prefix.lastIndexOf("/");
	let root = segIdx >= 0 ? prefix.slice(0, segIdx) : "";
	if (t.startsWith("/") && root === "") root = "/"; // '/*' globs the fs root itself
	if (root === "") return false; // pure-relative glob → children of cwd (permitted)
	let resolved = path.resolve(cwd, root);
	try {
		resolved = fs.realpathSync(resolved);
	} catch {
		/* nonexistent root — lexical resolution is the best we can do */
	}
	if (resolved.startsWith("/tmp/") || resolved.startsWith("/var/tmp/")) {
		return false; // ephemeral subtree mirrors isPathProtected
	}
	// Glob roots inside the project cwd are ordinary cwd-scoped work (same
	// carve-out as isPathProtected: project files under a protected ancestor
	// like ~/Desktop stay allowed).
	const normalizedCwd = path.resolve(cwd);
	if (
		resolved === normalizedCwd ||
		resolved.startsWith(normalizedCwd + path.sep)
	) {
		return false;
	}
	for (const p of PROTECTED_DIRS) {
		if (
			resolved === p ||
			resolved.startsWith(p + path.sep) ||
			p.startsWith(resolved + path.sep) // glob root is an ancestor of a protected dir
		) {
			return true;
		}
	}
	return false;
}

/**
 * Find's search roots: every leading non-option path argument between the
 * `find` word and its first destructive action (-exec/dir rm or -delete).
 * Options never precede the root paths, so leading non-`-` tokens are the
 * start points; none means find's implicit `.`.
 */
function findStartPaths(segment: string): string[] {
	const tokens = segment.split(/\s+/).filter(Boolean);
	const starts: string[] = [];
	for (const tok of tokens) {
		if (tok.startsWith("-")) break;
		starts.push(tok.replace(/^["']|["']$/g, ""));
	}
	return starts.length > 0 ? starts : ["."];
}

/**
 * Blank non-executable DATA regions of a shell command so destructive-pattern
 * matching only sees shell syntax, while preserving length 1:1 (blanked chars
 * become spaces) so the two views stay index-aligned.
 *
 *   mode="gate":    for DESTRUCTIVE / DANGEROUS / deploy-hazard PATTERN GATING.
 *                   Quoted spans are data → blanked, EXCEPT double-quoted
 *                   spans containing $ or ` (those constructs execute/expand
 *                   even quoted). Heredoc bodies per the examinability rules
 *                   below.
 *   mode="targets": for target extraction / variable collection. Quoted spans
 *                   are kept when they can be a real path operand — containing
 *                   $ or ` (expands at runtime) or starting with / or ~ (an
 *                   absolute/tilde path literal) — and blanked otherwise, so
 *                   data payloads (commit messages, heredoc prose) cannot
 *                   become phantom targets while quoted real targets still
 *                   resolve.
 *
 * Heredoc examinability (both modes): a heredoc fed to a SHELL interpreter
 * (sh/bash/zsh/ksh/dash/ash/su — its body is executed by that shell) stays
 * fully examinable regardless of delimiter quoting; quoted-delimiter bodies
 * (<<'EOF') are literal data → blanked; unquoted bodies keep only lines that
 * contain a command substitution ($( … ) or backticks — the parent shell
 * expands those before feeding stdin; a bare $VAR only interpolates data).
 *
 * Single-quoted spans are shell-literal, so blanking them can never hide an
 * executable construct; unmatched quotes blank to end-of-text, which mirrors
 * shell semantics (an unterminated string makes the whole rest data).
 */
function stripShellData(
	command: string,
	mode: "gate" | "targets" | "paths",
): string {
	const out: string[] = command.split(""); // Match the UTF-16 offsets used by slice/indexOf.
	const blank = (from: number, to: number) => {
		for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " ";
	};
	const isShellWord = (tok: string): boolean => {
		if (!tok || tok.includes("=") || tok.startsWith("<") || tok.startsWith("-"))
			return false;
		const base = tok.slice(tok.lastIndexOf("/") + 1);
		if (
			base === "sudo" ||
			base === "env" ||
			base === "nice" ||
			base === "nohup" ||
			base === "su"
		)
			return false;
		return /^(ba|z|k|da|a)?sh$/.test(base);
	};

	let i = 0;
	const n = command.length;
	while (i < n) {
		const c = command[i];
		if (c === "\\") {
			i += 2; // escaped char: never opens/changes a span
			continue;
		}
		if (c === "'") {
			let j = i + 1;
			while (j < n && command[j] !== "'") j++;
			const end = j < n ? j : n - 1; // unmatched quote → rest is data (shell would error)
			if (mode === "gate") blank(i, end + 1);
			i = end + 1;
			continue;
		}
		if (c === '"') {
			let j = i + 1;
			while (j < n && command[j] !== '"') {
				if (command[j] === "\\") j++;
				j++;
			}
			const end = j < n ? j : n - 1;
			const span = command.slice(i, end + 1);
			const expands = span.includes("$") || span.includes("`");
			const pathLike = /^"[/~]/.test(command.slice(i, end + 1));
			if (
				mode !== "paths" &&
				(mode === "gate" ? !expands : !(expands || pathLike))
			)
				blank(i, end + 1);
			i = end + 1;
			continue;
		}
		if (
			c === "<" &&
			command[i + 1] === "<" &&
			command[i + 2] !== "<" &&
			command[i - 1] !== "<"
		) {
			const m =
				/^<<(-?)\s*(?:"([^"\n]*)"|'([^'\n]*)'|([A-Za-z_][A-Za-z0-9_]*))/.exec(
					command.slice(i),
				);
			if (m) {
				const delim = m[2] ?? m[3] ?? m[4];
				const quotedDelim =
					m[2] !== undefined || m[3] !== undefined || m[4] === undefined;
				const lineStart = command.lastIndexOf("\n", i) + 1;
				let lineEnd = command.indexOf("\n", i);
				if (lineEnd === -1) lineEnd = n;
				let shellConsumer = false;
				for (const tok of command.slice(lineStart, i).split(/\s+/)) {
					if (isShellWord(tok)) {
						shellConsumer = true;
						break;
					}
				}
				// Locate the terminator line.
				const bodyStart = lineEnd + 1;
				let bodyEnd = bodyStart;
				let k = bodyStart;
				while (k <= n) {
					const eol = command.indexOf("\n", k);
					const lineText = command.slice(k, eol === -1 ? n : eol);
					if (lineText.trim() === delim) {
						bodyEnd = eol === -1 ? n : eol + 1;
						break;
					}
					if (eol === -1) {
						bodyEnd = n;
						break;
					}
					k = eol + 1;
				}
				if (bodyEnd > bodyStart) {
					for (let p = bodyStart; p < bodyEnd; ) {
						const eol2 = command.indexOf("\n", p);
						const stop = eol2 === -1 ? n : eol2 + 1;
						const lineText = command.slice(p, stop);
						const examinable =
							shellConsumer || (!quotedDelim && /\$\(|`/.test(lineText));
						if (!examinable) blank(p, stop);
						p = stop;
					}
					i = bodyEnd;
					continue;
				}
				i += m[0].length; // unterminated heredoc → just skip the marker
				continue;
			}
		}
		i++;
	}
	return out.join("");
}

function destructiveTargetsProtectedPath(
	command: string,
	cwd: string,
): { target: string; expanded?: string; resolved: boolean } | undefined {
	// Two views of the same command, index-aligned by stripShellData:
	//   gateText — data spans blanked, for PATTERN matching only (a `rm -rf`
	//   inside a heredoc body or quoted message is data, not shell syntax);
	//   targetText — heredoc data blanked but quoted path operands kept, so
	//   extraction/var resolution still sees real targets like '/etc' or "$HOME".
	// A literal `chmod +x /tmp/script; <read-only audit>` must not make
	// unrelated /proc operands look like chmod targets. Only mask this narrow,
	// independently verified temp operation; other mutations retain all guards.
	const permissionView = stripShellData(command, "targets");
	for (const match of permissionView.matchAll(/(?:^|[;\n&|])\s*chmod[ \t]+\+x[ \t]+(\/(?:tmp|var\/tmp)\/[A-Za-z0-9_./-]+)(?=[ \t]*(?:[;\n&|]|$))/g)) {
		if (isPathProtected(match[1], cwd)) continue;
		const start = match.index + match[0].indexOf("chmod");
		const end = match.index + match[0].length;
		command = command.slice(0, start) + " ".repeat(end - start) + command.slice(end);
	}
	const gateText = stripShellData(command, "gate");
	if (!matchesDestructivePattern(gateText)) {
		return undefined;
	}
	const targetText = stripShellData(command, "targets");
	const state = collectShellAssignments(targetText);

	// WHY: dd's target arrives as an `of=<path>` token, which the
	// assignment-shaped skip in extractPathsFromCommand drops (and for a bare
	// `dd if=x of=y` that drops EVERY token) — check it before the empty-paths
	// early return. This also closes an old hole where `dd … of=/dev/sda`
	// matched the destructive pattern but its token resolved as a harmless
	// cwd-relative path and never hit the protected check. Pattern-scanned on
	// gateText so an of=/dev string inside heredoc data cannot trigger it.
	const ddTarget = /\bdd\b[^;|&]*?\bof=(\S+)/i.exec(gateText)?.[1];
	if (ddTarget && isPathProtected(ddTarget, cwd)) {
		return { target: ddTarget, resolved: true };
	}

	// find -exec(dir) rm / find -delete: the {} placeholder is unknowable, so
	// the search ROOTS are validated against the same protected-path policy —
	// a destructive operation rooted in a protected tree cannot bypass it by
	// delegating the deletion to find. Marker located on gateText (data can't
	// trigger it), roots read from targetText (quoted roots still resolve).
	const findMarker =
		/\bfind\b[\s\S]*?(?:\s-exec(?:dir)?\s+rm\b|\s-delete\b)/i.exec(gateText);
	if (findMarker) {
		for (const raw of findStartPaths(
			targetText.slice(findMarker.index, findMarker.index + findMarker[0].length),
		)) {
			let expanded: string | undefined;
			if (raw.includes("$")) {
				expanded = expandVars(raw, state, cwd);
			} else if (raw === "~" || raw.startsWith("~/")) {
				expanded = HOME + raw.slice(1); // tilde start path
			} else {
				expanded = raw;
			}
			if (
				expanded === undefined ||
				isPathProtected(expanded, cwd) ||
				globRootProtected(expanded, cwd)
			) {
				return { target: raw, expanded, resolved: expanded !== undefined };
			}
		}
	}

	const paths = extractPathsFromCommand(stripAssignments(targetText));
	// Bare relative targets (e.g. "node_modules") are resolved inside cwd.
	if (paths.length === 0) {
		return undefined;
	}

	// Resolve shell variables against assignments found in the command text
	// instead of blanket-blocking every `$` (the old rule false-positived the
	// whole mktemp temp-copy workflow). Unknown variables still fail closed.
	for (const targetPath of paths) {
		if (targetPath.includes("$")) {
			// $() and backticks are EXECUTABLE constructs — whatever they expand
			// to is unknowable and they can run arbitrary commands; block with the
			// resolved (dangerous) disposition rather than the misleading
			// "unresolved variable" one.
			if (/\$\(|`/.test(targetPath)) {
				return { target: targetPath, resolved: true };
			}
			const expanded = expandVars(targetPath, state, cwd);
			if (expanded === undefined) {
				return { target: targetPath, resolved: false };
			}
			if (isPathProtected(expanded, cwd)) {
				return { target: targetPath, expanded, resolved: true };
			}
			if (globRootProtected(expanded, cwd)) {
				return { target: targetPath, expanded, resolved: true };
			}
			continue; // resolved to a non-protected path (e.g. mktemp under /tmp)
		}
		if (isPathProtected(targetPath, cwd)) {
			return { target: targetPath, resolved: true };
		}
		// Glob-bearing literal target: the shell expands it into real entries
		// that lexical checks cannot see (e.g. rm /home/* reaches $HOME).
		if (globRootProtected(targetPath, cwd)) {
			return { target: targetPath, resolved: true };
		}
	}

	return undefined;
}

// Compiled policy: ".agent_memory/ is local working notes; NEVER push it to any
// remote". Enforced at the stage that would leak it (git add). If the file is
// already gitignored, git add cannot stage it and the guard stays silent.
function isAgentMemoryExposed(cwd: string): Promise<boolean> {
	return new Promise((resolve) => {
		try {
			if (!fs.existsSync(path.join(cwd, ".agent_memory"))) return resolve(false);
		} catch {
			return resolve(false);
		}
		const proc = spawn("git", ["check-ignore", "-q", ".agent_memory"], {
			cwd,
			shell: false,
			stdio: "ignore",
		});
		const timer = setTimeout(() => proc.kill(), 3000);
		proc.on("close", (code) => {
			clearTimeout(timer);
			resolve(code !== 0);
		}); // exit 0 = ignored
		proc.on("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
	});
}

async function gitAddLeaksAgentMemory(
	command: string,
	cwd: string,
): Promise<boolean> {
	if (!/\bgit\s+add\b/.test(command)) return false;
	const tokens = command.split(/\s+/);
	const addIdx = tokens.indexOf("add");
	if (addIdx < 0) return false;
	const args = tokens.slice(addIdx + 1);
	if (args.some((a) => a.startsWith(".agent_memory"))) return true; // explicit add
	if (args.some((a) => a === "." || a === "-A" || a === "--all" || a === "-f")) {
		return await isAgentMemoryExposed(cwd);
	}
	return false;
}

// Resolve existing ancestors too: a new file beneath a symlink must not gain
// permissions from its innocent-looking lexical path. Never guess on errors.
function mutationPath(raw: string, cwd: string): string | undefined {
	const value = raw.replace(/^@/, "").replace(/^~(?=\/|$)/, HOME);
	let probe = path.resolve(cwd, value);
	const suffix: string[] = [];
	for (let depth = 0; depth < 128; depth++) {
		try {
			return path.join(fs.realpathSync(probe), ...suffix);
		} catch (e: any) {
			if (e.code !== "ENOENT") return undefined;
			try {
				if (fs.lstatSync(probe).isSymbolicLink()) return undefined;
			} catch (statError: any) {
				if (statError.code !== "ENOENT") return undefined;
			}
			const parent = path.dirname(probe);
			if (parent === probe) return undefined;
			suffix.unshift(path.basename(probe));
			probe = parent;
		}
	}
	return undefined;
}
const within = (file: string, root: string) =>
	file === root || file.startsWith(root + path.sep);
const scopeTooBroad = (root: string) =>
	PROTECTED_DIRS.some((protectedDir) => within(protectedDir, root));
function sensitiveExternalPath(file: string): boolean {
	return /(?:^|\/)(?:\.git|\.ssh|\.gnupg|\.aws|\.config|\.local|\.env[^/]*|auth\.json|models\.json|credentials[^/]*)(?:\/|$)|\.(?:pem|key)$/i.test(
		file,
	);
}
function automaticWriteRoot(
	file: string,
	cwd: string,
	agentDir = getAgentDir(),
): string | undefined {
	if (sensitiveExternalPath(file)) return undefined;
	// Repository evidence only; no remote/Git command or hook execution.
	let dir = cwd;
	for (let depth = 0; depth < 24 && !scopeTooBroad(dir); depth++) {
		try {
			const dotGit = path.join(dir, ".git");
			const st = fs.lstatSync(dotGit);
			let gitDir = dotGit;
			if (st.isFile() && st.size <= 4096) {
				const match = /^gitdir: ([^\r\n]+)\s*$/.exec(
					fs.readFileSync(dotGit, "utf8"),
				);
				if (!match) return undefined;
				gitDir = path.resolve(dir, match[1]);
			} else if (!st.isDirectory()) return undefined;
			if (fs.statSync(path.join(gitDir, "HEAD")).isFile()) {
				if (within(file, dir)) return dir;
				break;
			}
		} catch {}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	// Global configured skills are writable automatically ONLY in harness work.
	const parent = path.dirname(agentDir);
	const harness = mutationPath(
		path.basename(agentDir) === "agent" && !scopeTooBroad(parent)
			? parent
			: agentDir,
		cwd,
	);
	if (!harness || scopeTooBroad(harness) || !within(cwd, harness))
		return undefined;
	try {
		const settingsPath = path.join(agentDir, "settings.json");
		const stat = fs.lstatSync(settingsPath);
		if (!stat.isFile() || stat.size > 65536) return undefined;
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		for (const item of Array.isArray(settings.skills)
			? settings.skills.slice(0, 32)
			: []) {
			if (
				typeof item !== "string" ||
				!(item.startsWith("/") || item.startsWith("~/"))
			)
				continue;
			const skillPath = mutationPath(item, agentDir);
			if (!skillPath) continue;
			let stat: fs.Stats;
			try {
				stat = fs.statSync(skillPath);
			} catch {
				continue;
			}
			if (!stat.isFile() && !stat.isDirectory()) continue;
			if (
				!scopeTooBroad(skillPath) &&
				(stat.isFile() ? file === skillPath : within(file, skillPath))
			)
				return skillPath;
		}
	} catch {}
	return undefined;
}
const PATH_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export function invalidMutationPath(raw: string): string | undefined {
	if (!raw.trim() || PATH_CONTROLS.test(raw))
		return `Blocked: invalid filesystem path ${JSON.stringify(raw.slice(0, 200)).replace(/[\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}. Empty paths and control characters/newlines are not allowed. Retry with the intended path as a single clean string; no file was changed.`;
}

// Deliberately cross-line, not word n-grams: dense CSS, tables, and checklist
// syntax within one line are not evidence of degeneration.
export function writeDegeneration(content: string): string | undefined {
	const spans = new Map<string, number[]>();
	let previous = "",
		consecutive = 0;
	let lineNumber = 0;
	for (const line of content.split(/\r?\n/)) {
		lineNumber++;
		consecutive = line === previous ? consecutive + 1 : 1;
		previous = line;
		if (line.trim().length < 24 || !/\p{L}/u.test(line)) continue;
		if (consecutive >= 3)
			return `3 consecutive identical substantive lines ending at line ${lineNumber}`;
		if (line.length < 100) continue;
		const span = line; // Shared prefixes in distinct CSS/HTML lines are legitimate.
		const occurrences = spans.get(span) ?? [];
		occurrences.push(lineNumber);
		if (occurrences.length >= 3)
			return `the same exact long line at lines ${occurrences.join(", ")}`;
		spans.set(span, occurrences);
	}
}

function literalShellWord(raw: string, variables: Map<string, string>): string {
	return raw.replace(
		/\$'((?:\\[\s\S]|[^'])*)'|'([^']*)'|"((?:\\[\s\S]|[^"\\])*)"|\\([\s\S])|\$([A-Za-z_]\w*)|\$\{([A-Za-z_]\w*)\}/g,
		(
			match,
			ansi: string | undefined,
			single: string | undefined,
			double: string | undefined,
			escaped: string | undefined,
			variable: string | undefined,
			braced: string | undefined,
		) => {
			if (ansi !== undefined)
				return ansi.replace(
					/\\(x[\da-fA-F]{1,2}|u[\da-fA-F]{1,4}|U[\da-fA-F]{1,8}|[0-7]{1,3}|[abefnrtv\\'"])/g,
					(_escape, code: string) => {
						const controls: Record<string, string> = {
							a: "\x07",
							b: "\b",
							e: "\x1b",
							f: "\f",
							n: "\n",
							r: "\r",
							t: "\t",
							v: "\v",
						};
						if (controls[code]) return controls[code];
						if (/^[xuU]/.test(code))
							return String.fromCodePoint(
								Math.min(0x10ffff, parseInt(code.slice(1), 16)),
							);
						if (/^[0-7]/.test(code)) return String.fromCharCode(parseInt(code, 8));
						return code;
					},
				);
			if (single !== undefined) return single;
			// Substitution source is not the resulting filename (bash strips trailing
			// newlines). Leave dynamic operands to the independent shell safety gate.
			if (double !== undefined && /(^|[^\\])(?:\\\\)*(?:\$\(|`)/.test(double))
				return "[unresolved shell substitution]";
			if (double !== undefined)
				return double.replace(
					/\\([\\"$`\n])|\$([A-Za-z_]\w*)|\$\{([A-Za-z_]\w*)\}/g,
					(m, escape, a, b) =>
						escape !== undefined
							? escape === "\n"
								? ""
								: escape
							: (variables.get(a ?? b) ?? m),
				);
			if (escaped !== undefined) return escaped === "\n" ? "" : escaped;
			return variables.get(variable ?? braced!) ?? match;
		},
	);
}

// A literal-operand guard, not a shell sandbox. It never executes substitutions.
// Heredoc data and printf/echo payloads remain legal, including multiline text.
export function invalidShellPath(command: string): string | undefined {
	const source = stripShellData(command, "paths");
	const words =
		source.match(
			/(?:\$'(?:\\[\s\S]|[^'])*'|'[^']*'|"(?:\\[\s\S]|[^"\\])*"|\\[\s\S]|[^\s'"\\;|&<>()])+|(?:>>?|<{1,3}|[;\n|&()])/g,
		) ?? [];
	const variables = new Map<string, string>();
	let executable = "",
		redirect = false,
		comment = false,
		dataOperand = false;
	for (const word of words) {
		if (/^[;\n|&()]$/.test(word)) {
			executable = "";
			redirect = false;
			comment = false;
			dataOperand = false;
			continue;
		}
		if (comment) continue;
		if (word.startsWith("#")) {
			comment = true;
			continue;
		}
		if (/^[<>]+$/.test(word)) {
			redirect = word === ">" || word === ">>" || word === "<";
			dataOperand = word === "<<" || word === "<<<";
			continue;
		}
		if (dataOperand) {
			dataOperand = false;
			continue;
		}
		if (
			executable === "stat" &&
			(/^--(?:printf|format)(?:=|$)/.test(word) || word.startsWith("-c"))
		) {
			dataOperand = ["--printf", "--format", "-c"].includes(word);
			continue;
		}
		const assignment = /^([A-Za-z_]\w*)=(.*)$/s.exec(word);
		if (assignment && !executable) {
			variables.set(assignment[1], literalShellWord(assignment[2], variables));
			continue;
		}
		const value = literalShellWord(word, variables);
		if (redirect) {
			redirect = false;
			const reason = invalidMutationPath(value);
			if (reason) return reason;
			continue;
		}
		if (!executable) {
			const reason = invalidMutationPath(value);
			if (reason) return reason;
			executable = path.basename(value);
			if (["sudo", "env", "command", "exec", "nohup"].includes(executable))
				executable = "";
			continue;
		}
		if (
			/^(touch|mkdir|rmdir|rm|mv|cp|ln|install|tee|truncate|cd|chmod|chown|chgrp|stat|cat|ls)$/.test(
				executable,
			)
		) {
			const reason = invalidMutationPath(value);
			if (reason) return reason;
		}
	}
}

export default function filesystemSafetyExtension(pi: ExtensionAPI) {
	let maintenanceReminded = false;
	pi.on("session_start", () => { maintenanceReminded = false; });
	pi.on("before_agent_start", () => {
		if (!SELF_MUTATION_ALLOWED || maintenanceReminded) return;
		maintenanceReminded = true;
		return { message: { customType: "harness-maintenance-safety", content: SELF_MUTATION_GUIDANCE, display: false } };
	});
	const approved = new Map<string, "file" | "directory">(),
		denied = new Set<string>();
	const pending = new Map<string, Promise<boolean>>();
	let generation = 0;
	const reset = () => {
		generation++;
		approved.clear();
		denied.clear();
		pending.clear();
	};
	pi.on("session_start", reset);
	pi.on("session_shutdown", reset);
	pi.on("input", () => {
		denied.clear();
	});
	pi.on("tool_call", async (event, ctx) => {
		// Only intercept bash tool calls
		if (event.toolName !== "bash") {
			return undefined;
		}

		const command = event.input.command as string;
		if (!command) {
			return undefined;
		}

		const invalidPath = invalidShellPath(command);
		if (invalidPath) return { block: true, reason: invalidPath };

		if (await gitAddLeaksAgentMemory(command, ctx.cwd)) {
			const reason =
				"Blocked: git add would stage .agent_memory/ (council protocol — never push agent memory to any remote). Stage specific files or gitignore .agent_memory first.";
			if (ctx.hasUI) ctx.ui.notify(reason, "error");
			return { block: true, reason };
		}

		// Data-span views: pattern gates must not fire on heredoc bodies, quoted
		// messages, or other data payloads (a `rm -rf /` string in a commit
		// message or heredoc is not a command). See stripShellData.
		const gateText = stripShellData(command, "gate");
		const targetText = stripShellData(command, "targets");

		if (isAlwaysDangerous(gateText, targetText)) {
			const reason = "Blocked: Destructive command detected";
			if (ctx.hasUI) {
				ctx.ui.notify(reason, "error");
			}
			return { block: true, reason };
		}

		// Deploy-hazard interception (compiled policy — see DOCTRINE-MODULES/deployment.md)
		for (const pattern of DEPLOY_HAZARD_PATTERNS) {
			if (pattern.test(gateText)) {
				const reason = `Blocked: Deploy hazard (${pattern.source}) — prod/remote/worktree state would be destroyed irreversibly. Stage the intended change and ship via the normal push pipeline.`;
				if (ctx.hasUI) {
					ctx.ui.notify(reason, "error");
				}
				return { block: true, reason };
			}
		}

		const guardedTarget = destructiveTargetsProtectedPath(command, ctx.cwd);
		if (guardedTarget) {
			let reason: string;
			if (guardedTarget.resolved) {
				reason = `Blocked: Cannot operate on protected path "${guardedTarget.target}"`;
				if (guardedTarget.expanded) {
					reason += ` (resolves to "${guardedTarget.expanded}")`;
				}
			} else {
				reason =
					`Blocked: "${guardedTarget.target}" is an unresolved shell variable used by a destructive command — it could expand to a protected path. ` +
					`Derive temp paths inside the same command (e.g. T=$(mktemp -d); cp -r . "$T/"; rm -rf "$T") or pass a literal path instead.`;
			}
			if (ctx.hasUI) {
				ctx.ui.notify(reason, "error");
			}
			return { block: true, reason };
		}

		return undefined;
	});

	pi.on("tool_result", (event, ctx) => {
		if (
			event.isError ||
			(event.toolName !== "write" && event.toolName !== "edit")
		)
			return;
		const raw = event.input.path as string;
		const target = mutationPath(raw, ctx.cwd);
		let bytes: number | null = null;
		try {
			if (target) bytes = fs.statSync(target).size;
		} catch {
			/* Size unavailable, not zero. */
		}
		return {
			content: [
				...event.content,
				{
					type: "text" as const,
					text: `File mutation succeeded: path=${JSON.stringify(raw)}; resolved=${JSON.stringify(target ?? null)}; size=${bytes ?? "unknown"} bytes. Content not independently verified.`,
				},
			],
			details: {
				...event.details,
				fileMutation: { path: raw, resolved: target, bytes },
			},
		};
	});

	// Also intercept write and edit tools
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") {
			return undefined;
		}

		const filePath = (event.input.file_path || event.input.path) as string;
		if (!filePath) {
			return undefined;
		}

		const harnessDenial = selfMutationDenial(filePath, ctx.cwd);
		if (harnessDenial) return { block: true, reason: harnessDenial };
		const invalidPath = invalidMutationPath(filePath);
		if (invalidPath) return { block: true, reason: invalidPath };
		if (
			event.toolName === "write" &&
			typeof event.input.content === "string" &&
			process.env.PI_WRITE_DEGENERATION !== "0"
		) {
			const repeated = writeDegeneration(event.input.content as string);
			if (repeated)
				return {
					block: true,
					reason: `Blocked: possible write degeneration (${repeated}) for ${JSON.stringify(filePath)}. No file was changed. Retry a smaller, reviewed payload. If repetition is intentional, the operator can disable this heuristic with PI_WRITE_DEGENERATION=0.`,
				};
		}

		const target = mutationPath(filePath, ctx.cwd);
		const cwd = mutationPath(ctx.cwd, ctx.cwd);
		if (!target || !cwd)
			return {
				block: true,
				reason: "Blocked: cannot safely resolve write target",
			};
		if (isPathProtected(target, cwd)) {
			if (automaticWriteRoot(target, cwd)) return undefined;
			const eligible =
				within(target, HOME) &&
				!sensitiveExternalPath(target) &&
				!PROTECTED_DIRS.includes(target);
			if (
				eligible &&
				[...approved].some(([root, kind]) =>
					kind === "file" ? target === root : within(target, root),
				)
			)
				return undefined;
			const parent = path.dirname(target),
				kind = scopeTooBroad(parent) ? "file" : "directory";
			const scope = kind === "file" ? target : parent,
				epoch = generation;
			if (
				eligible &&
				ctx.hasUI &&
				!denied.has(scope) &&
				approved.size < 32 &&
				!ctx.signal?.aborted
			) {
				let decision = pending.get(scope);
				if (!decision) {
					decision = ctx.ui.confirm(
						"Additional write scope",
						`Allow write/edit ${kind === "file" ? "of this file" : "under this directory"}: ${scope} for this session? This does not permit shell deletion, system paths or credentials.`,
						{ signal: ctx.signal },
					);
					pending.set(scope, decision);
				}
				const allowed = await decision.catch(() => false);
				if (pending.get(scope) === decision) pending.delete(scope);
				if (
					epoch === generation &&
					!ctx.signal?.aborted &&
					mutationPath(filePath, ctx.cwd) === target
				) {
					if (allowed) {
						approved.set(scope, kind);
						return undefined;
					}
					denied.add(scope);
				}
			}
			return {
				block: true,
				reason: `Blocked: ${filePath} is outside the verified writable scope. Use a session rooted in that project or approve a narrow directory interactively; headless approval is disabled.`,
			};
		}

		return undefined;
	});
}

// Exported read-only for harness bench tests (scripts/bench/path-safety-var-test.mjs);
// the default export above remains the extension entry point.
export {
	automaticWriteRoot,
	mutationPath,
	sensitiveExternalPath,
	scopeTooBroad,
	collectShellAssignments,
	destructiveTargetsProtectedPath,
	expandVars,
	extractPathsFromCommand,
	isAlwaysDangerous,
	isPathProtected,
	matchesDestructivePattern,
	stripShellData,
};
