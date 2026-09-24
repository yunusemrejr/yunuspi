import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hostOperationRisk } from "./lib/host-operation-safety.ts";
import {
	getAgentDir,
	type ExtensionAPI,
} from "@yunuspi/coding-agent";

import {
	canonicalMutationPath,
	containsPath,
	selfMutationDenial,
	SELF_MUTATION_ALLOWED,
	SELF_MUTATION_GUIDANCE,
} from "./lib/self-mutation-guard.ts";

const HOME = os.homedir();

// Protected directories - operations blocked unless inside project
const PROTECTED_DIRS = [
	"/",
	"/root",
	"/home",
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

/** Contextual accident prevention; executable isolation remains the hard boundary.
 * Only operands of recognized mutations are evaluated. This deliberately bounded
 * shell model never executes substitutions or treats variable names as authority.
 */
type ShellRisk = {
	level: "block" | "review";
	reason: string;
	target?: string;
	expanded?: string;
	resolved: boolean;
};
type ShellState = {
	vars: Map<string, string | undefined>;
	cwd: string | undefined;
	environment: NodeJS.ProcessEnv;
	allocated: Set<string>;
};
type ShellToken = { raw: string; operator: boolean };

/**
 * Pure-syntax memo: shell tokenization is a deterministic function of the
 * command string, so the tool_call handlers in this extension share one
 * bounded parse per distinct command. Authorization DECISIONS
 * (assessShellMutation, isPathProtected) are never cached — they read mutable
 * filesystem state and are re-evaluated on every event, including the
 * post-confirm TOCTOU recheck.
 */
const shellTokenCache = new Map<string, ShellToken[]>();
const SHELL_TOKEN_CACHE_MAX = 512;
const SHELL_TOKEN_CACHE_CHARS = 16384;

function shellTokens(source: string): ShellToken[] {
	const cacheable = source.length <= SHELL_TOKEN_CACHE_CHARS;
	const hit = cacheable ? shellTokenCache.get(source) : undefined;
	if (hit) return hit.map((token) => ({ ...token }));
	const tokens = shellTokensUncached(source);
	if (cacheable) {
		if (shellTokenCache.size >= SHELL_TOKEN_CACHE_MAX) shellTokenCache.delete(shellTokenCache.keys().next().value!);
		shellTokenCache.set(source, tokens.map((token) => ({ ...token })));
	}
	return tokens;
}

function shellTokensUncached(source: string): ShellToken[] {
	const tokens: ShellToken[] = [];
	let word = "",
		quote = "",
		substitution = 0;
	const flush = () => {
		if (word) tokens.push({ raw: word, operator: false });
		word = "";
	};
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (c === "\\" && quote !== "'") {
			word += c + (source[++i] ?? "");
			continue;
		}
		if (quote) {
			word += c;
			if (c === quote) quote = "";
			continue;
		}
		if (c === "'" || c === '"' || c === "`") {
			quote = c;
			word += c;
			continue;
		}
		if (c === "$" && source[i + 1] === "(") {
			substitution++;
			word += "$(";
			i++;
			continue;
		}
		if (substitution) {
			if (c === "(") substitution++;
			if (c === ")") substitution--;
			word += c;
			continue;
		}
		if (c === "#" && !word) {
			while (i < source.length && source[i] !== "\n") i++;
			i--;
			continue;
		}
		if (c === "\n" || /[;|&()<>]/.test(c)) {
			flush();
			let raw = c;
			if (source[i + 1] === c && /[|&<>]/.test(c)) raw += source[++i];
			tokens.push({ raw, operator: true });
			continue;
		}
		if (/\s/.test(c)) {
			flush();
			continue;
		}
		word += c;
	}
	flush();
	return tokens;
}

function shellSubstitutions(word: string): string[] {
	const mask = word.split("");
	let quote = "";
	for (let i = 0; i < word.length; i++) {
		if (word[i] === "\\" && quote !== "'") {
			mask[i] = " ";
			if (i + 1 < mask.length) mask[++i] = " ";
			continue;
		}
		if (word[i] === "'" && quote !== '"') {
			quote = quote ? "" : "'";
			mask[i] = " ";
			continue;
		}
		if (quote === "'") {
			mask[i] = " ";
			continue;
		}
		if (word[i] === '"') quote = quote ? "" : '"';
	}
	return [...mask.join("").matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)].map((m) =>
		word.slice(
			m.index + (m[1] === undefined ? 1 : 2),
			m.index + m[0].length - 1,
		),
	);
}

function shellValue(
	raw: string,
	state: ShellState,
	depth = 0,
): string | undefined {
	if (depth > 8) return;
	let out = "",
		quote = "";
	const variable = (name: string) =>
		state.vars.has(name)
			? state.vars.get(name)
			: name === "PWD"
				? state.cwd
				: state.environment[name];
	for (let i = 0; i < raw.length; i++) {
		const c = raw[i];
		if (c === "'" && quote !== '"') {
			quote = quote ? "" : "'";
			continue;
		}
		if (quote === "'") {
			out += c;
			continue;
		}
		if (c === '"') {
			quote = quote ? "" : '"';
			continue;
		}
		if (c === "\\") {
			const next = raw[++i];
			if (next === undefined) return;
			if (next !== "\n")
				out += quote === '"' && !/[\\"$`]/.test(next) ? "\\" + next : next;
			continue;
		}
		if (c === "`") {
			const end = raw.indexOf("`", i + 1);
			if (end < 0) return;
			const value = substitutionValue(raw.slice(i + 1, end), state, depth + 1);
			if (value === undefined) return;
			out += value;
			i = end;
			continue;
		}
		if (c === "$" && raw[i + 1] === "(") {
			// Only a complete substitution is modeled, never a command that happens
			// to mention mktemp (e.g. $(mktemp -d; echo /)).
			const end = raw.indexOf(")", i + 2);
			if (end < 0) return;
			const value = substitutionValue(raw.slice(i + 2, end), state, depth + 1);
			if (value === undefined) return;
			out += value;
			i = end;
			continue;
		}
		if (c === "$") {
			const tail = raw.slice(i);
			const match =
				/^\$([A-Za-z_]\w*)|^\$\{([A-Za-z_]\w*)(?:(:-|-|:\?|\?)([^{}]*))?\}/.exec(
					tail,
				);
			if (!match) return;
			let value = variable(match[1] ?? match[2]);
			const missing =
				value === undefined || (match[3]?.startsWith(":") && value === "");
			if (missing && match[3]?.endsWith("-"))
				value = shellValue(match[4], state, depth + 1);
			if (missing && match[3]?.endsWith("?")) return; // shell aborts; no inferred target
			if (value === undefined) return;
			// Unquoted expansion can produce several operands or inject rm options.
			if (!quote && /\s/.test(value)) return;
			out += value;
			i += match[0].length - 1;
			continue;
		}
		out += c;
	}
	if (quote) return;
	if (raw.startsWith("~")) {
		if (!(raw === "~" || raw.startsWith("~/"))) return;
		out = HOME + out.slice(1);
	}
	return out;
}

function substitutionValue(
	body: string,
	state: ShellState,
	depth: number,
): string | undefined {
	const tokens = shellTokens(body);
	if (!tokens.length || tokens.some((t) => t.operator)) return;
	const words = tokens.map((t) => shellValue(t.raw, state, depth));
	if (words.some((w) => w === undefined)) return;
	const args = words as string[],
		command = path.basename(args.shift()!);
	if (
		command === "pwd" &&
		(!args.length || (args.length === 1 && ["-P", "-L"].includes(args[0])))
	)
		return state.cwd;
	if (command !== "mktemp") return;
	let base: string | undefined,
		template: string | undefined,
		useTemp = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (["-d", "--directory", "-q", "--quiet"].includes(arg)) continue;
		if (arg === "-p") {
			base = args[++i];
			if (!base) return;
			useTemp = true;
			continue;
		}
		if (arg === "--tmpdir") {
			base = state.vars.has("TMPDIR")
				? state.vars.get("TMPDIR")
				: state.environment.TMPDIR || "/tmp";
			useTemp = true;
			continue;
		}
		if (arg.startsWith("--tmpdir=")) {
			base = arg.slice(9);
			useTemp = true;
			continue;
		}
		if (arg === "-t") {
			useTemp = true;
			continue;
		}
		if (arg.startsWith("-")) return; // includes -u: no allocated temporary path
		if (template !== undefined) return;
		template = arg;
	}
	// mktemp's real location, including the actual TMPDIR, never a /tmp proxy
	// merely because a variable is named TEMP. Preserve suffix/traversal checks.
	if (!template || useTemp)
		base ??= state.vars.has("TMPDIR")
			? state.vars.get("TMPDIR")
			: state.environment.TMPDIR || "/tmp";
	if (base === undefined && (!template || useTemp)) return;
	const pattern = template ?? "tmp.XXXXXXXXXX";
	if (!/X{3,}/.test(pattern)) return;
	if (useTemp && path.isAbsolute(pattern)) return;
	const location = base === undefined ? pattern : base + "/" + pattern;
	if (!state.cwd && !path.isAbsolute(location)) return;
	try {
		const result = canonicalMutationPath(
			location.replace(/X{3,}/g, "pi-allocated-temp"),
			state.cwd,
		);
		state.allocated.add(result);
		return result;
	} catch {
		return;
	}
}

function isPathProtected(
	targetPath: string,
	cwd: string,
	followLeaf = true,
): boolean {
	let resolved: string, normalizedCwd: string;
	try {
		resolved = canonicalMutationPath(
			targetPath.replace(/^~(?=\/|$)/, HOME),
			cwd,
			followLeaf,
		);
		normalizedCwd = canonicalMutationPath(cwd);
	} catch {
		return true;
	}
	// A launch at / or home never grants those whole trees as destructive scope.
	if ([...PROTECTED_DIRS, "/tmp", "/var/tmp"].includes(resolved)) return true;
	if (!scopeTooBroad(normalizedCwd) && containsPath(normalizedCwd, resolved))
		return false;
	if (resolved.startsWith("/tmp/") || resolved.startsWith("/var/tmp/"))
		return false;
	return PROTECTED_DIRS.some(
		(root) => root !== "/" && containsPath(root, resolved),
	);
}

function assessShellMutation(
	command: string,
	cwd: string,
	environment = process.env,
	depth = 0,
): ShellRisk | undefined {
	if (depth > 5)
		return {
			level: "review",
			reason:
				"Nested shell mutation exceeds the bounded analyzer; split the command",
			resolved: false,
		};
	const state: ShellState = {
		vars: new Map(),
		cwd,
		environment,
		allocated: new Set(),
	};
	const exported = new Set(Object.keys(environment));
	const branches: Array<{
		vars: Map<string, string | undefined>;
		cwd: string | undefined;
	}> = [];
	let conditionalCd: string | undefined;
	let mutationCwd: string | undefined = cwd;
	let risk: ShellRisk | undefined;
	const note = (next: ShellRisk | undefined) => {
		if (next && (!risk || next.level === "block")) risk = next;
	};
	const uncertain = (
		target: string,
		reason = "unresolved shell variable or dynamic target",
		resolved = false,
	) => note({ level: "review", target, resolved, reason });
	const check = (
		raw: string,
		recursive = false,
		broad = false,
		unlinkLeaf = false,
	) => {
		const expanded = shellValue(raw, state);
		if (expanded === undefined) {
			uncertain(raw);
			return;
		}
		if (!expanded) return; // empty quoted operand is an rm error, not '/'
		if (!mutationCwd && !path.isAbsolute(expanded)) {
			uncertain(raw, "working directory is not known at this operation");
			return;
		}
		// Detect unquoted glob syntax, including variable-produced patterns. Quoted
		// literal '*' filenames are ordinary files. Braces are ambiguous, not paths.
		const glob =
			/[*?[]/.test(expanded) && !/^'(?:[^']*)'$|^"(?:[^"$]*)"$/.test(raw);
		const cut = glob ? expanded.search(/[*?[]/) : -1;
		const prefix = cut < 0 ? expanded : expanded.slice(0, cut);
		const target =
			cut < 0
				? prefix
				: prefix.includes("/")
					? prefix.slice(0, prefix.lastIndexOf("/") + 1)
					: ".";
		const followLeaf = !unlinkLeaf || glob || expanded.endsWith("/");
		if (/[{}]/.test(expanded)) {
			uncertain(raw, "brace-expanded mutation needs explicit target paths");
			return;
		}
		let physical: string;
		try {
			physical = canonicalMutationPath(target, mutationCwd, followLeaf);
		} catch {
			uncertain(raw, "mutation target cannot be resolved safely");
			return;
		}
		const harnessDenial = selfMutationDenial(
			physical,
			state.cwd ?? cwd,
			followLeaf,
		);
		if (harnessDenial || isPathProtected(physical, cwd, followLeaf)) {
			note({
				level: "block",
				target: raw,
				expanded: physical,
				resolved: true,
				reason: harnessDenial ?? "Cannot operate on protected path",
			});
			return;
		}
		let workspace: string;
		try {
			workspace = canonicalMutationPath(cwd);
		} catch {
			uncertain(raw);
			return;
		}
		if (
			(recursive || broad) &&
			((cut < 0 && containsPath(physical, workspace)) ||
				(glob &&
					/(?:^|\/)\*$/.test(expanded) &&
					containsPath(physical, workspace)))
		)
			note({
				level: "review",
				target: raw,
				expanded: physical,
				resolved: true,
				reason:
					"This operation replaces or removes a whole working directory; select a narrower file set or review the exact command",
			});
	};
	const processSegment = (tokens: ShellToken[]) => {
		conditionalCd = undefined;
		mutationCwd = state.cwd;
		if (!tokens.length) return;
		const raw = tokens.map((t) => t.raw);
		// Inspect executed substitutions even when their enclosing command is read-only.
		for (const word of raw) {
			for (const body of shellSubstitutions(word))
				note(
					assessShellMutation(
						body,
						state.cwd ?? cwd,
						{ ...environment, ...Object.fromEntries(state.vars) },
						depth + 1,
					),
				);
		}
		const args: string[] = [],
			redirects: string[] = [];
		for (let i = 0; i < tokens.length; i++) {
			if (tokens[i].operator && /^[<>]/.test(tokens[i].raw)) {
				const op = tokens[i].raw,
					operand = tokens[++i]?.raw;
				if (operand && [">", ">>"].includes(op)) {
					if (args.length && /^\d+$/.test(args.at(-1)!)) args.pop();
					if (operand !== "/dev/null" && !/^\d+$/.test(operand))
						redirects.push(operand);
				}
			} else args.push(tokens[i].raw);
		}
		for (const dest of redirects) check(dest);
		let i = 0;
		if (["then", "do", "else", "!"].includes(args[i])) i++;
		const prefixVariables = new Map(state.vars);
		const assignments: Array<[string, string | undefined]> = [];
		const exportsVariables =
			args[i] === "export" ||
			(args[i] === "declare" && args[i + 1]?.includes("x"));
		if (["export", "local", "readonly", "declare"].includes(args[i])) i++;
		while (i < args.length) {
			if (/^-[a-zA-Z]+$/.test(args[i]) && assignments.length === 0 && i > 0) {
				i++;
				continue;
			}
			const m = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(args[i]);
			if (!m) break;
			const value = shellValue(m[2], state);
			assignments.push([m[1], value]);
			state.vars.set(m[1], value);
			i++;
		}
		if (i === args.length) {
			for (const [key, value] of assignments) {
				state.vars.set(key, value);
				if (exportsVariables) exported.add(key);
			}
			return;
		}
		state.vars = prefixVariables;
		if (exportsVariables && !assignments.length) {
			for (const key of args.slice(i))
				if (/^[A-Za-z_]\w*$/.test(key)) exported.add(key);
			return;
		}
		let childEnvironment: NodeJS.ProcessEnv = {
			...environment,
			...Object.fromEntries(
				[...state.vars].filter(([key]) => exported.has(key)),
			),
			...Object.fromEntries(assignments),
		};
		let childCwd = state.cwd;
		let name = path.basename(shellValue(args[i++], state) ?? "");
		let elevated = false;
		const envAssignment = (raw: string): [string, string | undefined] | undefined => {
			const lexical = /^([A-Za-z_]\w*)=(.*)$/s.exec(raw);
			if (lexical) return [lexical[1], shellValue(lexical[2], state)];
			const evaluated = /^([A-Za-z_]\w*)=(.*)$/s.exec(shellValue(raw, state) ?? "");
			if (evaluated) return [evaluated[1], evaluated[2]];
		};
		while (
			[
				"command",
				"exec",
				"sudo",
				"doas",
				"env",
				"nohup",
				"timeout",
				"nice",
				"stdbuf",
				"setsid",
				"busybox",
			].includes(name)
		) {
			if (name === "sudo" || name === "doas") elevated = true;
			while (
				i < args.length &&
				((shellValue(args[i], state) ?? "").startsWith("-") || /^[A-Za-z_]\w*=/.test(args[i]) || name === "env" && envAssignment(args[i]) !== undefined)
			) {
				const rawOption = args[i++];
				const assignment = name === "env" ? envAssignment(rawOption) : undefined;
				if (assignment) { childEnvironment[assignment[0]] = assignment[1]; continue; }
				const option = shellValue(rawOption, state);
				if (option === undefined) { uncertain(name, "Wrapper option is unresolved"); return; }
				if (option === "--") break;
				// These wrapper modes only describe a command; substitutions above
				// are still assessed because the shell evaluates them first.
				if (name === "command" && /^-[pvV]*[vV][pvV]*$/.test(option) ||
					name === "sudo" && (option === "--list" || /^-[ABbEHknPSlv]*l[ABbEHknPSlv]*$/.test(option))) return;
				if (name === "env") {
					if (option === "-i" || option === "--ignore-environment")
						childEnvironment = {};
					if (option === "-u" || option === "--unset") {
						const key = shellValue(args[i] ?? "", state);
						if (key === undefined) { uncertain("env", "Environment removal is unresolved"); return; }
						delete childEnvironment[key];
					}
					if (option.startsWith("--unset="))
						delete childEnvironment[option.slice(8)];
					if (option === "-S" || option === "--split-string" || option.startsWith("--split-string=") || /^-S./s.test(option)) {
						const script = option.startsWith("--split-string=") ? option.slice(15)
							: /^-S./s.test(option) ? option.slice(2) : shellValue(args[i++] ?? "", state);
						if (script === undefined)
							uncertain("env -S", "Split command is unresolved");
						else
							note(
								assessShellMutation(
									[script, ...args.slice(i)].join(" "),
									childCwd ?? cwd,
									childEnvironment,
									depth + 1,
								),
							);
						return;
					}
					if (option.startsWith("--chdir=")) {
						const dest = option.slice(8);
						try {
							childCwd =
								dest !== undefined
									? canonicalMutationPath(dest, state.cwd)
									: undefined;
						} catch {
							childCwd = undefined;
						}
					}
					if (option === "-C" || option === "--chdir") {
						const dest = shellValue(args[i] ?? "", state);
						try {
							childCwd =
								dest !== undefined
									? canonicalMutationPath(dest, state.cwd)
									: undefined;
						} catch {
							childCwd = undefined;
						}
					}
				}
				if (
					(["sudo", "doas"].includes(name) &&
						["-u", "-g", "-h", "-p", "-C", "-D", "-R", "--user", "--group", "--host", "--prompt", "--close-from", "--chdir", "--chroot"].includes(option)) ||
					(name === "env" &&
						["-u", "--unset", "-C", "--chdir", "-a", "--argv0", "-f", "--file"].includes(option)) ||
					(name === "exec" && option === "-a") ||
					(name === "nice" && ["-n", "--adjustment"].includes(option)) ||
					(name === "stdbuf" && ["-i", "-o", "-e", "--input", "--output", "--error"].includes(option)) ||
					(name === "timeout" && ["-s", "-k", "--signal", "--kill-after"].includes(option))
				)
					i++;
			}
			// env still accepts assignments after its option terminator.
			if (name === "env") while (i < args.length) {
				const assignment = envAssignment(args[i]);
				if (!assignment) break;
				childEnvironment[assignment[0]] = assignment[1]; i++;
			}
			if (name === "timeout") i++;
			if (i < args.length && shellValue(args[i], state) === undefined) {
				uncertain(name, "Wrapped command or option is unresolved; use explicit operands");
				return;
			}
			name = path.basename(shellValue(args[i++] ?? "", state) ?? "");
		}
		mutationCwd = childCwd;
		const operands = args.slice(i),
			values = operands.map((arg) => shellValue(arg, state));
		// Reuse the parsed executable/operands, so quoted examples and grep data
		// do not become host mutations. Wrappers and substitutions share this gate.
		note(hostOperationRisk(name, values));
		if (/^python[\d.]*$/.test(name) && values[0] === "-m" && values[1] === "esptool")
			note(hostOperationRisk("esptool", values.slice(2)));
		if (name === "find") {
			for (let at = 0; at < operands.length; at++) {
				if (!["-exec", "-execdir", "-ok", "-okdir"].includes(values[at] ?? "")) continue;
				let end = at + 1;
				while (end < operands.length && ![";", "+"].includes(values[end] ?? "")) end++;
				const executable = path.basename(values[at + 1] ?? "");
				note(hostOperationRisk(executable, values.slice(at + 2, end).map(value => value?.includes("{}") ? undefined : value)));
				// Filesystem operands from find remain owned by the scoped-root
				// checks below; recursively inspect only command/shell wrappers.
				if (/^(?:command|exec|sudo|doas|env|nohup|timeout|nice|stdbuf|setsid|busybox|bash|sh|dash|zsh|ksh|python[\d.]*|xargs)$/.test(executable))
					note(assessShellMutation(operands.slice(at + 1, end).join(" "), state.cwd ?? cwd, childEnvironment, depth + 1));
				at = end;
			}
		}
		if (name === "xargs") {
			let at = 0;
			while (at < values.length && values[at]?.startsWith("-")) {
				const option = values[at++];
				if (option === "--") break;
				if (["-a", "--arg-file", "-d", "--delimiter", "-E", "-I", "-L", "-n", "-P", "-s", "--max-lines", "--max-args", "--max-procs", "--max-chars", "--process-slot-var"].includes(option!)) at++;
			}
			// Dynamic stdin operands cannot be resolved, but a literal dangerous
			// executable must not evade host preflight by using an xargs wrapper.
			note(hostOperationRisk(path.basename(values[at] ?? ""), [...values.slice(at + 1), undefined]));
			if (/^(?:command|exec|sudo|doas|env|nohup|timeout|nice|stdbuf|setsid|busybox|bash|sh|dash|zsh|ksh|python[\d.]*|xargs)$/.test(path.basename(values[at] ?? "")))
				note(assessShellMutation([...operands.slice(at), '"${__PI_XARGS_OPERAND}"'].join(" "), state.cwd ?? cwd,
					{ ...childEnvironment, __PI_XARGS_OPERAND: undefined }, depth + 1));
		}
		if (elevated && /^(?:bash|sh|dash|zsh|python[\d.]*|node|npm|npx|pnpm|yarn|pytest|make|ctest|cargo|go)$/.test(name))
			uncertain(name, "Elevated scripts, builds and tests can change the host beyond this command's visible operands. Inspect the entrypoint, device/network access and recovery first; prefer an unprivileged focused check or sandbox_run", values.every(value => value !== undefined));
		if (name === "cd") {
			const dest = shellValue(
				operands.find((a) => a !== "--" && a !== "-P" && a !== "-L") ?? "~",
				state,
			);
			try {
				const physical =
					dest !== undefined && state.cwd
						? canonicalMutationPath(dest, state.cwd)
						: undefined;
				conditionalCd = physical;
				state.cwd =
					physical &&
					(state.allocated.has(physical) || fs.statSync(physical).isDirectory())
						? physical
						: undefined;
			} catch {
				state.cwd = undefined;
			}
			return;
		}
		if (name === "unset") {
			for (const key of operands) state.vars.set(key, undefined);
			return;
		}
		if (
			name === "xargs" &&
			values.some((v) =>
				[
					"rm",
					"rmdir",
					"shred",
					"mv",
					"cp",
					"sed",
					"perl",
					"sh",
					"bash",
				].includes(path.basename(v ?? "")),
			)
		) {
			uncertain(
				"xargs",
				"Mutation operands arrive from stdin; use scoped find -exec or preview explicit paths",
			);
			return;
		}
		if (["fi", "done", "esac"].includes(name)) {
			const before = branches.pop();
			if (before) {
				for (const key of new Set([
					...state.vars.keys(),
					...before.vars.keys(),
				]))
					if (state.vars.get(key) !== before.vars.get(key))
						state.vars.set(key, undefined);
				if (state.cwd !== before.cwd) state.cwd = undefined;
			}
			return;
		}
		if (
			[
				"for",
				"while",
				"until",
				"if",
				"case",
				"eval",
				"source",
				".",
				"read",
			].includes(name)
		) {
			if (["for", "while", "until", "if", "case"].includes(name))
				branches.push({ vars: new Map(state.vars), cwd: state.cwd });
			if (["if", "while", "until"].includes(name))
				note(
					assessShellMutation(
						operands.join(" "),
						state.cwd ?? cwd,
						{ ...environment, ...Object.fromEntries(state.vars) },
						depth + 1,
					),
				);
			// No inference of branch or sourced assignments; dependent targets need review.
			for (const key of state.vars.keys()) state.vars.set(key, undefined);
			if (name === "for" || name === "read")
				for (const key of operands)
					if (/^[A-Za-z_]\w*$/.test(key)) state.vars.set(key, undefined);
			return;
		}
		if (/^(?:bash|sh|dash|zsh|ksh)$/.test(name)) {
			const option = values.findIndex(
				(v) => v !== undefined && /^-[a-z]*c[a-z]*$/.test(v),
			);
			if (option >= 0) {
				const script = values[option + 1];
				if (script !== undefined)
					note(
						assessShellMutation(
							script,
							childCwd ?? cwd,
							childEnvironment,
							depth + 1,
						),
					);
			}
			return;
		}
		// Remote/state-wide operations are reviewable, not rejected because a regex
		// sees '--force' inside --force-with-lease or '--delete' beside --dry-run.
		if (name === "git") {
			let start = 0;
			while (start < values.length && values[start]?.startsWith("-")) {
				if (["-C", "-c", "--git-dir", "--work-tree"].includes(values[start]!))
					start++;
				start++;
			}
			const verb = values[start],
				opts = values.slice(start + 1);
			const has = (...flags: string[]) =>
				opts.some((v) => v !== undefined && flags.includes(v));
			if (
				verb === "push" &&
				!has("--dry-run", "-n") &&
				(has("--force", "-f", "--delete", "-d", "--mirror") ||
					opts.some((v) => v?.startsWith("+") || v?.startsWith(":")))
			)
				uncertain(
					"git push",
					"Remote history or refs would be overwritten or removed; review the exact command",
					true,
				);
			if (
				(verb === "reset" && has("--hard")) ||
				(verb === "clean" &&
					!has("--dry-run", "-n") &&
					opts.some((v) => /^-[a-z]*f/.test(v ?? "")))
			)
				uncertain(
					"git " + verb,
					"Working-tree data would be discarded; preview or review the exact command",
					true,
				);
			return;
		}
		if (name === "rsync") {
			if (
				!values.some(
					(v) => v === "--dry-run" || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(v ?? ""),
				) &&
				values.some((v) => /^--(?:delete(?:-.+)?|del)$/.test(v ?? ""))
			)
				uncertain(
					"rsync",
					"Destination files absent from the source would be deleted; use --dry-run to review",
					true,
				);
			return;
		}
		if (name === "ssh") {
			const tail = values.filter((v): v is string => v !== undefined).join(" ");
			if (/\b(?:rm|mkfs|dd|shred)\b/.test(tail))
				uncertain(
					"ssh",
					"Remote mutation has no verified local filesystem scope; review the remote command",
				);
			return;
		}
		if (
			/^mkfs(?:\.|$)/.test(name) ||
			["fdisk", "sfdisk", "parted"].includes(name)
		) {
			if (
				!values.some((v) =>
					["--help", "--version", "-l", "--list"].includes(v ?? ""),
				)
			)
				note({
					level: "block",
					reason:
						"Device formatting or partition mutation requires a separate operator workflow",
					target: name,
					resolved: true,
				});
			return;
		}
		if (name === "find") {
			const destructive =
				values.some((v) =>
					["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(v ?? ""),
				) &&
				(values.includes("-delete") ||
					values.some((v) =>
						[
							"rm",
							"rmdir",
							"shred",
							"chmod",
							"chown",
							"mv",
							"cp",
							"sed",
							"perl",
							"sh",
							"bash",
						].includes(path.basename(v ?? "")),
					));
			if (!destructive) return;
			const roots: string[] = [];
			let at = 0;
			while (["-H", "-L", "-P"].includes(values[at] ?? "")) at++;
			for (
				;
				at < operands.length &&
				!operands[at].startsWith("-") &&
				operands[at] !== "(";
				at++
			)
				roots.push(operands[at]);
			for (const root of roots.length ? roots : ["."])
				check(
					root,
					!values.some((v) =>
						["-name", "-iname", "-path", "-regex"].includes(v ?? ""),
					),
					false,
				);
			// -L traverses links inside a safe root. Do not pretend root checks cover it.
			if (values.includes("-L"))
				uncertain(
					"find -L",
					"Destructive find follows descendant symlinks; use explicit paths or avoid -L",
				);
			return;
		}
		if (name === "dd") {
			for (const arg of operands)
				if (arg.startsWith("of=")) check(arg.slice(3));
			return;
		}
		if (
			![
				"rm",
				"rmdir",
				"unlink",
				"shred",
				"mv",
				"cp",
				"install",
				"chmod",
				"chown",
				"chgrp",
				"truncate",
				"tee",
				"sed",
				"perl",
			].includes(name)
		)
			return;
		const optionValues = values.slice(
			0,
			values.includes("--") ? values.indexOf("--") : values.length,
		);
		if (optionValues.includes("--help") || optionValues.includes("--version"))
			return;
		const targets: string[] = [];
		let afterOptions = false,
			destination: string | undefined;
		const recursive = values.some(
			(v) => v === "--recursive" || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(v ?? ""),
		);
		for (let at = 0; at < operands.length; at++) {
			const arg = operands[at],
				value = values[at];
			if (!afterOptions && value === "--") {
				afterOptions = true;
				continue;
			}
			if (!afterOptions && value?.startsWith("-")) {
				if (["-t", "--target-directory"].includes(value))
					destination = operands[++at];
				else if (value.startsWith("--target-directory="))
					destination = arg.slice(arg.indexOf("=") + 1);
				else if (
					[
						"--reference",
						"--mode",
						"--owner",
						"--group",
						"--suffix",
						"-m",
						"-o",
						"-g",
						"-S",
						"-s",
						"--size",
						"-e",
						"-f",
					].includes(value) &&
					name !== "rm"
				)
					at++;
				continue;
			}
			targets.push(arg);
		}
		if (
			["chmod", "chown", "chgrp"].includes(name) &&
			!values.some((v) => v?.startsWith("--reference")) &&
			!(
				name === "chmod" &&
				values.some((v) => /^-[rwxXstugo]+(?:,|$)/.test(v ?? ""))
			)
		)
			targets.shift();
		if (name === "cp" || name === "install") {
			// Copy sources are reads; -t names the destination explicitly.
			const dest = destination ?? targets.at(-1);
			if (dest) check(dest, false, false);
			return;
		}
		if (name === "sed" || name === "perl") {
			if (
				!values.some(
					(v) =>
						v === "--in-place" ||
						v?.startsWith("--in-place=") ||
						/^-[a-zA-Z]*i/.test(v ?? ""),
				)
			)
				return;
			if (!values.some((v) => v === "-e" || v?.startsWith("-e") || v === "-f"))
				targets.shift();
		}
		if (destination) check(destination);
		for (let at = 0; at < targets.length; at++)
			check(
				targets[at],
				recursive || name === "mv",
				["rm", "sed", "perl", "chmod", "chown", "chgrp"].includes(name),
				["rm", "unlink", "rmdir"].includes(name) ||
					(name === "mv" &&
						(destination !== undefined || at < targets.length - 1)),
			);
	};
	let segment: ShellToken[] = [];
	const snapshot = () => ({ vars: new Map(state.vars), cwd: state.cwd });
	const restore = (saved: ReturnType<typeof snapshot>) => {
		state.vars = new Map(saved.vars);
		state.cwd = saved.cwd;
	};
	const subshells: ReturnType<typeof snapshot>[] = [];
	let pipeline: ReturnType<typeof snapshot> | undefined;
	for (const token of shellTokens(stripShellData(command, "paths"))) {
		if (token.operator && /^[;\n|&()]|^&&$|^\|\|$/.test(token.raw)) {
			const before = snapshot();
			processSegment(segment);
			segment = [];
			if (token.raw === "&&" && conditionalCd) state.cwd = conditionalCd;
			if (token.raw === "(") {
				subshells.push(snapshot());
			} else if (token.raw === ")") {
				const saved = subshells.pop();
				if (saved) restore(saved);
			} else if (token.raw === "|") {
				pipeline ??= before;
				restore(pipeline);
			} else if (pipeline) {
				restore(pipeline);
				pipeline = undefined;
			} else if (token.raw === "&") restore(before);
			else if (token.raw === "||") {
				for (const [key, value] of state.vars)
					if (!before.vars.has(key) || before.vars.get(key) !== value)
						state.vars.set(key, undefined);
				if (state.cwd !== before.cwd) state.cwd = undefined;
			}
		} else segment.push(token);
	}
	processSegment(segment);
	return risk;
}

// Compatibility helpers for older callers; production uses the single assessor.
function destructiveTargetsProtectedPath(command: string, cwd: string) {
	return assessShellMutation(command, cwd);
}
function isAlwaysDangerous(command: string, targetView = command) {
	return assessShellMutation(targetView, process.cwd())?.level === "block";
}
function matchesDestructivePattern(command: string) {
	return /\b(?:rm|rmdir|unlink|shred|mv|cp|install|chmod|chown|chgrp|truncate|tee|sed|perl|find|dd|mkfs|fdisk)\b/.test(
		command,
	);
}
function extractPathsFromCommand(command: string) {
	return shellTokens(command)
		.slice(1)
		.filter(
			(t) =>
				!t.operator && !t.raw.startsWith("-") && !/^[A-Za-z_]\w*=/.test(t.raw),
		)
		.map((t) => t.raw);
}

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

// Compiled policy: ".agent_memory/ is local working notes; NEVER push it to any
// remote". Enforced at the stage that would leak it (git add). If the file is
// already gitignored, git add cannot stage it and the guard stays silent.
function isAgentMemoryExposed(cwd: string): Promise<boolean> {
	return new Promise((resolve) => {
		try {
			if (!fs.existsSync(path.join(cwd, ".agent_memory")))
				return resolve(false);
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
	if (
		args.some((a) => a === "." || a === "-A" || a === "--all" || a === "-f")
	) {
		return await isAgentMemoryExposed(cwd);
	}
	return false;
}

// Resolve existing ancestors too: a new file beneath a symlink must not gain
// permissions from its innocent-looking lexical path. Never guess on errors.
function mutationPath(raw: string, cwd: string): string | undefined {
	const value = raw.replace(/^@/, "").replace(/^~(?=\/|$)/, HOME);
	try {
		return canonicalMutationPath(value, cwd);
	} catch {
		return undefined;
	}
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
	// Repeated rows, fixtures and short examples are normal. Only a large output
	// dominated by one identical substantive line is strong enough to interrupt.
	if (content.length < 8192) return;
	const lines = content.split(/\r?\n/),
		counts = new Map<string, number>();
	for (const line of lines) {
		if (line.trim().length < 80 || !/\p{L}/u.test(line)) continue;
		const count = (counts.get(line) ?? 0) + 1;
		counts.set(line, count);
		if (count >= 12 && count * line.length > content.length * 0.85)
			return `one identical substantive line accounts for over 85% of this large output (${count} copies)`;
	}
}

export function writeReplacementRisk(
	previous: string,
	next: string,
): string | undefined {
	const before = Buffer.byteLength(previous),
		after = Buffer.byteLength(next);
	if (before >= 16_384 && after < before * 0.05)
		return `whole-file write would remove over 95% of an existing ${before}-byte file`;
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
						if (/^[0-7]/.test(code))
							return String.fromCharCode(parseInt(code, 8));
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
export function invalidShellPath(command: string, depth = 0): string | undefined {
	let source = stripShellData(command, "paths");
	// $(...) starts a fresh shell quoting scope even inside double quotes.
	// Its source is not a filename; keep it out of the literal-word regex below
	// while checking literal paths inside the substitution independently.
	let quote = "";
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (c === "\\" && quote !== "'") { i++; continue; }
		if (c === "'" && quote !== '"') { quote = quote ? "" : "'"; continue; }
		if (quote === "'") continue;
		if (c === '"') { quote = quote ? "" : '"'; continue; }
		if (c !== "$" || source[i + 1] !== "(") continue;
		const frames = [{ quote: "", parentheses: 1 }];
		let end = i + 2;
		for (; end < source.length && frames.length; end++) {
			const frame = frames[frames.length - 1], ch = source[end];
			if (ch === "\\" && frame.quote !== "'") { end++; continue; }
			if (ch === "'" && frame.quote !== '"') { frame.quote = frame.quote ? "" : "'"; continue; }
			if (frame.quote === "'") continue;
			if (ch === '"') { frame.quote = frame.quote ? "" : '"'; continue; }
			if (ch === "$" && source[end + 1] === "(") { frames.push({ quote: "", parentheses: 1 }); end++; continue; }
			if (!frame.quote && ch === "(") frame.parentheses++;
			if (!frame.quote && ch === ")" && --frame.parentheses === 0) frames.pop();
		}
		if (frames.length) continue; // Incomplete shell input stays with existing validation.
		if (depth < 8) {
			const reason = invalidShellPath(source.slice(i + 2, end - 1), depth + 1);
			if (reason) return reason;
		}
		source = source.slice(0, i) + "__shell_substitution__" + source.slice(end);
		i += "__shell_substitution__".length - 1;
	}
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
	pi.on("session_start", () => {
		maintenanceReminded = false;
	});
	pi.on("before_agent_start", () => {
		if (!SELF_MUTATION_ALLOWED || maintenanceReminded) return;
		maintenanceReminded = true;
		return {
			message: {
				customType: "harness-maintenance-safety",
				content: SELF_MUTATION_GUIDANCE,
				display: false,
			},
		};
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
		// Only intercept shell commands: bash, background runs and commands
		// launched into a desktop_session virtual display.
		if (event.toolName !== "bash" && event.toolName !== "bg_run" && !(event.toolName === "desktop_session" && event.input?.action === "launch")) {
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

		const risk = assessShellMutation(command, ctx.cwd);
		if (risk) {
			const reason = `${risk.level === "review" ? "Review required" : "Blocked"}: ${risk.reason}${risk.target ? `: ${JSON.stringify(risk.target)}` : ""}${risk.expanded ? ` (resolves to ${JSON.stringify(risk.expanded)})` : ""}.`;
			// Approval is for this exact invocation only. It never enlarges write
			// scope or overrides a hard harness/system boundary.
			const epoch = generation;
			if (
				risk.level === "review" &&
				risk.resolved &&
				ctx.hasUI &&
				!ctx.signal?.aborted
			) {
				const allowed = await ctx.ui
					.confirm(
						"Review destructive operation",
						`${reason}\n\nWorking directory: ${ctx.cwd}\n${command}`,
						{ signal: ctx.signal },
					)
					.catch(() => false);
				if (
					allowed &&
					epoch === generation &&
					!ctx.signal?.aborted &&
					JSON.stringify(assessShellMutation(command, ctx.cwd)) ===
						JSON.stringify(risk)
				)
					return undefined;
			}
			return {
				block: true,
				reason:
					reason +
					(risk.level === "review"
						? " Use explicit, narrow targets or a preview before retrying; unresolved targets are never guessed from variable names."
						: ""),
			};
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
	const mutationPolicy = async (event: any, ctx: any) => {
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
	};
	pi.on("tool_call", mutationPolicy);
	pi.events?.on("harness:mutation-preflight", (request: any) => {
		request.checks.push(() => mutationPolicy({toolName: request.kind, input: {path: request.target}}, request.ctx));
	});
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "write") return;
		const filePath = (event.input.file_path || event.input.path) as string;
		if (typeof filePath !== "string") return;
		const target = mutationPath(filePath, ctx.cwd);
		if (!target) return;
		if (event.toolName === "write" && typeof event.input.content === "string") {
			let previous: string | undefined;
			try {
				const stat = fs.statSync(target);
				if (stat.isFile() && stat.size >= 16_384 && stat.size <= 2_000_000)
					previous = fs.readFileSync(target, "utf8");
			} catch {
				/* The native tool reports ordinary access errors. */
			}
			const reason =
				previous === undefined
					? undefined
					: writeReplacementRisk(previous, event.input.content);
			if (reason) {
				const epoch = generation;
				let accepted = false;
				if (ctx.hasUI && !ctx.signal?.aborted)
					accepted = await ctx.ui
						.confirm(
							"Review whole-file replacement",
							`${reason}: ${target}. Allow this exact replacement?`,
							{ signal: ctx.signal },
						)
						.catch(() => false);
				let unchanged = false;
				try {
					unchanged =
						mutationPath(filePath, ctx.cwd) === target &&
						fs.readFileSync(target, "utf8") === previous;
				} catch {}
				if (
					!accepted ||
					!unchanged ||
					epoch !== generation ||
					ctx.signal?.aborted
				)
					return {
						block: true,
						reason: `Review required: ${reason}. No file was changed. Use an edit with exact old text for an intentional replacement, or review this write interactively.`,
					};
			}
		}
	});
}

// Exported read-only for harness bench tests (scripts/bench/path-safety-var-test.mjs);
// the default export above remains the extension entry point.
export {
	assessShellMutation,
	automaticWriteRoot,
	mutationPath,
	sensitiveExternalPath,
	scopeTooBroad,
	destructiveTargetsProtectedPath,
	extractPathsFromCommand,
	isAlwaysDangerous,
	isPathProtected,
	matchesDestructivePattern,
	stripShellData,
};
