/**
 * Check evidence: which commands prove a code change, which files are code or
 * something people look at, and the ledger that says what has not been checked
 * or looked at yet. Pure and shared: the check gate (check-gate.ts) and the
 * goal's verification (task-state/ingest.ts) read the same tool list here.
 */

/** Extensions that count as code. */
const CODE_EXT = new Set(("ts tsx js jsx mjs cjs mts cts py pyw go rs java kt kts scala c h cc cpp cxx hpp hh cs fs rb php pl pm lua sh bash zsh fish ps1 swift m mm dart ex exs erl hs clj sql r jl zig nim vue svelte astro gd").split(" "));
/** Files people see when they open the result. */
const VISIBLE_EXT = new Set(("html htm css scss sass less jsx tsx vue svelte astro svg twig erb hbs ejs pug njk liquid mustache pptx docx odp odt key").split(" "));
const EXCLUDED_DIR = new Set(["node_modules", "dist", "build", "out", ".git", "__pycache__", "vendor", "target", ".cache", ".venv", "venv", "coverage"]);
const IMAGE_FILE = /\.(?:png|jpe?g|webp|gif)$/i;

const extensionOf = (file: string) => /\.([A-Za-z0-9]+)$/.exec(file)?.[1]?.toLowerCase() ?? "";

/** Path as the project sees it: relative to cwd when inside it, so a project that lives under a folder named `build` is not excluded. */
function projectPath(file: string, cwd?: string): string {
	const normal = file.replaceAll("\\", "/");
	const root = cwd?.replaceAll("\\", "/").replace(/\/+$/, "");
	return root && normal.startsWith(`${root}/`) ? normal.slice(root.length + 1) : normal;
}

function excluded(file: string, cwd?: string): boolean {
	const path = projectPath(file, cwd);
	return path.startsWith("/tmp/") || path.split("/").some(part => EXCLUDED_DIR.has(part)) || /\.min\./.test(path.split("/").at(-1) ?? "");
}

export const isCodeFile = (file: string, cwd?: string): boolean => CODE_EXT.has(extensionOf(file)) && !excluded(file, cwd);
export const isVisibleFile = (file: string, cwd?: string): boolean => VISIBLE_EXT.has(extensionOf(file)) && !excluded(file, cwd);
export const isImageFile = (file: string): boolean => IMAGE_FILE.test(file);

// ---------- commands ----------

/**
 * Segments of a shell command split on `&&`, `||`, `;`, `|` and newline outside quotes.
 * `exitMasked` when anything but `&&` joins two of them: the exit status then belongs to
 * a later command (`npm test; echo done`, `npm test || true`, `pytest | tail`), not to the check.
 */
export function commandSegments(command: string): { segments: string[]; exitMasked: boolean } {
	const parts: { text: string; join: string }[] = [];
	let current = "", quote = "";
	const cut = (join: string) => { parts.push({ text: current.trim(), join }); current = ""; };
	for (let at = 0; at < command.length; at++) {
		const char = command[at];
		if (quote) { current += char; if (char === "\\" && quote === '"') current += command[++at] ?? ""; else if (char === quote) quote = ""; continue; }
		if (char === "\\") { current += char + (command[++at] ?? ""); continue; }
		if (char === '"' || char === "'") { quote = char; current += char; continue; }
		if (char === "&" && command[at + 1] === "&" || char === "|" && command[at + 1] === "|") { cut(char + char); at++; continue; }
		if (char === ";" || char === "\n" || char === "|") { cut(char); continue; }
		current += char;
	}
	cut("");
	const kept = parts.filter(part => part.text);
	return { segments: kept.map(part => part.text), exitMasked: kept.slice(0, -1).some(part => part.join !== "&&") };
}

/** The command a segment runs, without the harmless wrappers in front of it. */
export function peelWrappers(segment: string): string {
	let text = segment.trim();
	for (let guard = 0; guard < 12; guard++) {
		const next = text
			.replace(/^[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+/, "")
			.replace(/^timeout\s+(?:-\S+\s+)*\d+(?:\.\d+)?[smhd]?\s+/, "")
			.replace(/^nice\s+(?:-n\s*-?\d+\s+|-\d+\s+)?/, "")
			.replace(/^env\s+(?:-i\s+)?/, "")
			.replace(/^(?:time|command)\s+/, "");
		if (next === text) break;
		text = next.trim();
	}
	return text;
}

const EXT_PATTERN = [...CODE_EXT].join("|");
const EXEC = String.raw`(?:\S*\/)?`;
const NOT_A_RUN = /(?:^|\s)(?:--help|--version)(?:\s|$)/;
const CHECK_TOOLS: RegExp[] = [
	// JS and TS
	/^(?:npm|pnpm|yarn|bun) (?:test|t)\b/,
	/^(?:npm|pnpm|yarn|bun) run [\w:.-]*(?:test|build|check|lint|typecheck|tsc|verify|e2e|ci|smoke)[\w:.-]*/,
	/^(?:npx|pnpm dlx|bunx|pnpm exec|yarn) (?:-\S+ )*(?:tsc|vitest|jest|mocha|playwright|eslint|biome|ava|tap|astro check|svelte-check|vue-tsc)\b/,
	new RegExp(`^${EXEC}(?:tsc|vitest|jest|mocha|eslint|biome|vue-tsc|svelte-check)\\b`),
	/^node (?:-{1,2}[\w-]+(?:=\S+)? )*(?:--test|--check|-c)\b/,
	/^deno (?:test|check|lint)\b/,
	/^bun test\b/,
	// Python
	new RegExp(`^${EXEC}pytest\\b`),
	/^python[0-9.]* (?:-[A-Za-z]+ )*-m (?:pytest|unittest|py_compile|compileall|mypy|ruff|pyflakes|doctest|pylint)\b/,
	new RegExp(`^${EXEC}(?:mypy|ruff|pyright|flake8|pylint|tox|nox)\\b`),
	/^(?:uv|poetry|pipenv|hatch) run (?:pytest|python|mypy|ruff)\b/,
	// Other toolchains
	/^go (?:test|build|vet|run)\b/,
	/^cargo (?:test|check|build|clippy|run|nextest)\b/,
	/^make(?: -\S+)*(?: (?:test|check|build|all|lint|ci)\b|\s*$)/,
	/^(?:cmake --build|ctest|ninja)\b/,
	/^(?:\.\/)?gradlew? (?:test|build|check)\b/,
	/^mvn (?:test|verify|package|compile)\b/,
	/^dotnet (?:test|build|run)\b/,
	/^swift (?:build|test)\b/,
	/^php -l\b/,
	new RegExp(`^${EXEC}phpunit\\b`),
	/^composer (?:test|run-script test)\b/,
	/^(?:bundle exec )?(?:rspec|rake test)\b/,
	/^mix test\b/,
	/^shellcheck\b/,
	/^(?:ba|z)?sh -n\b/,
	/^zig build\b/,
	/^(?:flutter|dart) test\b/,
	/^docker (?:build|compose (?:build|up|run))\b/,
];

/** One command step that is a test, build, type check, lint or similar tool run. Used by the goal's verification as well. */
export function isCheckToolStep(step: string): boolean {
	const text = peelWrappers(step);
	return !NOT_A_RUN.test(text) && CHECK_TOOLS.some(pattern => pattern.test(text));
}

const INTERPRETER = /^(?:python[0-9.]*|node|tsx|ts-node|bash|sh|zsh|ruby|php|perl|lua|Rscript|deno run|bun(?: run)?)\s/;
const ONE_LINER = /^(?:python[0-9.]*|node)\s(?:\S+\s)*?-[cep]\s/;
const CHECK_NAMED_PATH = /^(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]*(?:test|check|verify|lint|build|smoke|selftest)[\w.-]*$/;
const LOCAL_SERVICE = /(?:^|[\s"'])(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?:[:/\s"']|$)/;

/** The program run on its own input: an interpreter on a code file, a check-named script, a request to a local service. */
function isRunStep(step: string): boolean {
	const text = peelWrappers(step);
	if (NOT_A_RUN.test(text)) return false;
	if (/^(?:curl|wget|http|xh)\s/.test(text)) return LOCAL_SERVICE.test(text);
	if (ONE_LINER.test(text)) return /import |require\(|from /.test(text);
	const [first = ""] = text.split(/\s+/);
	if (CHECK_NAMED_PATH.test(first)) return true;
	if (!INTERPRETER.test(`${text} `)) return false;
	const file = text.split(/\s+/).slice(1).find(token => !token.startsWith("-"))?.replace(/^["']|["']$/g, "") ?? "";
	return new RegExp(`\\.(?:${EXT_PATTERN})$`, "i").test(file);
}

/** A shell command clears the gate when one of its segments is a check or a run of the program. */
export function isCheckCommand(command: string): boolean {
	return commandSegments(String(command ?? "")).segments.some(segment => isCheckToolStep(segment) || isRunStep(segment));
}

/** Output that says a check failed although the command exited 0 (its exit status was a later command's). */
export const FAIL_MARK = /(^|\s)[1-9]\d* (failed|failing|errors?)\b|^not ok \d|Traceback \(most recent call last\)|error TS\d{3,5}|^FAIL\s|npm ERR!|^FAILED |\bFAILED \(|panicked at|^E\s{3}\S/m;

export interface CheckResult {
	/** The tool reported an error, or the exit code is not 0. */
	failed: boolean;
	/** Text the command printed. */
	output?: string;
	/** Started in the background; its outcome arrives later. */
	background?: boolean;
	/** The background task's id, so its end can be matched to this start. */
	taskId?: string;
}

export type CheckOutcome = { kind: "pass" } | { kind: "background" } | { kind: "fail"; snippet: string };
type Settled = Exclude<CheckOutcome, { kind: "background" }>;

const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** What a check command's result means for the gate; undefined when the command is not a check. */
export function checkOutcome(command: string, result: CheckResult): CheckOutcome | undefined {
	if (!isCheckCommand(command)) return undefined;
	if (result.background) return { kind: "background" };
	const output = result.output ?? "";
	const marked = FAIL_MARK.exec(output);
	if (!result.failed && !(marked && commandSegments(command).exitMasked)) return { kind: "pass" };
	const lines = output.split("\n");
	const line = marked ? lines.find(candidate => FAIL_MARK.test(candidate)) ?? "" : lines.map(row => row.trim()).filter(Boolean).at(-1) ?? "";
	return { kind: "fail", snippet: clip(line.trim(), 100) };
}

/** The text with everything inside quotes (and each backslash escape) blanked to `_`, same length: a `>` in a message is not a redirection. */
function blankQuoted(text: string): string {
	let quote = "", blank = "";
	for (let at = 0; at < text.length; at++) {
		const char = text[at];
		if (char === "\\" && quote !== "'") { const escape = text.slice(at, at + 2); blank += "_".repeat(escape.length); at += escape.length - 1; continue; }
		if (quote) { if (char === quote) { quote = ""; blank += char; } else blank += "_"; continue; }
		if (char === '"' || char === "'") quote = char;
		blank += char;
	}
	return blank;
}

/** Files a shell command writes: `sed -i`, redirection, `tee`. */
export function shellWrittenFiles(command: string): string[] {
	const files = new Set<string>();
	for (const segment of commandSegments(command).segments) {
		const text = peelWrappers(segment);
		const tokens = text.split(/\s+/).map(token => token.replace(/^["']|["']$/g, ""));
		if (/^sed\s(?:\S+\s)*?-[A-Za-z]*i/.test(text)) for (const token of tokens.slice(1)) if (/\.\w+$/.test(token) && !token.startsWith("-")) files.add(token);
		if (/^tee\s/.test(text)) for (const token of tokens.slice(1)) { if (/^\d*[<>]/.test(token)) break; if (!token.startsWith("-")) files.add(token); }
		// Found on the blanked copy, read from the real text: a quoted target after an unquoted `>` still counts.
		for (const match of blankQuoted(segment).matchAll(/(?<![0-9&<>])>>?\s*(?!&)(?:"([^"]+)"|'([^']+)'|([^\s;&|<>()]+))/dg)) {
			const [from, to] = match.indices!.slice(1).find(Boolean) ?? [0, 0];
			const target = segment.slice(from, to);
			if (target && !target.startsWith("/dev/")) files.add(target);
		}
	}
	return [...files];
}

/** A command that publishes work to others: a push, a package publish, a release. */
export function isPublishCommand(command: string): boolean {
	return commandSegments(String(command ?? "")).segments.some(segment => {
		const text = peelWrappers(segment);
		if (/(?:^|\s)(?:--dry-run|-h|--help)(?:\s|$)/.test(text)) return false;
		return /^git\s+(?:-\S+\s+(?:\S+\s+)?)*?push\b/.test(text)
			|| /^(?:npm|pnpm|yarn|bun)\s+publish\b/.test(text) || /^cargo\s+publish\b/.test(text) || /^twine\s+upload\b/.test(text) || /^gh\s+release\s+create\b/.test(text);
	});
}

// ---------- texts ----------

export function fileList(files: readonly string[]): string {
	const shown = files.slice(0, 4).map(file => file.length > 60 ? `…${file.slice(-59)}` : file);
	return files.length > 4 ? `${shown.join(", ")} and ${files.length - 4} more` : shown.join(", ");
}

/** A final report that puts part of the request off to a later round. The word alone also describes a subject ("loaded deferred", "deferred payments"): only a promise to do it later, or a heading, counts. */
export const DEFER = /follows? (?:as|in) (?:its own|a) (?:small |separate )?(?:update|step|round|change)|in a (?:later|follow-up|separate|next) (?:step|round|pass|update|change)|left (?:it |this |that )?for (?:later|a follow-up|the next)|(?:will|can) (?:do|add|handle|finish) (?:it|that|this|the rest) (?:later|next time|in a follow-up)|\b(?:I|we)(?: have|['\u2019]ve)? (?:deferred|postponed)\b|\b(?:deferred|postponed) (?:to|until|for) (?:a |the )?(?:later|next|follow-up|future|another)|(?<=^[ \t#>*-]*)(?:deferred|postponed)\*{0,2}[ \t]*:/im;
export const deferredPhrase = (report: string): string | undefined => DEFER.exec(report)?.[0];
/** The report names the failed command or says something failed, and claims no success next to it. */
// Quoting the command is not stating its result: only a failure word counts.
const statesFailure = (report: string): boolean =>
	/\bfail(?:s|ed|ing|ure)?\b|\b(?:is|still|are) (?:red|broken)\b/i.test(report) && !/\b(?:all )?(?:tests? )?pass(?:es|ed|ing)?\b|\bgreen\b|\bsucceed(?:s|ed)?\b/i.test(report);

export const checkTexts = {
	stopUnchecked: (files: readonly string[]) => `Code changed after its last check: ${fileList(files)}. Run the check that proves this change (the tests it can break, the build or type check, or the program on real input) and read the result before you report. If nothing here can run it, say so in the report and why.`,
	stopFailed: (failed: { command: string; snippet: string }) => `The last check failed: \`${failed.command}\`${failed.snippet ? ` — ${failed.snippet}` : ""}. Fix the cause and run it again, or put the failure in the report next to what works.`,
	shipUnchecked: (files: readonly string[]) => `Hold the push: code changed after its last check (${fileList(files)}). Run the check that proves it first, then push.`,
	shipFailed: (failed: { command: string }) => `Hold the push: the last check failed (\`${failed.command}\`). Fix it or say in the report why it ships anyway, then push.`,
	copies: "Before you report, list every copy the change must reach (the deploy, a mirror or replica, a packaged zip or fix script, a cache purge, the GitHub push, other sites that carry it) and bring each up to date, or say which one is left and why.",
	deferred: (phrase: string) => `Your report puts off «${phrase}». Do it now, or list it as not done with the reason.`,
	look: (files: readonly string[]) => `Changed and not looked at: ${fileList(files)}. Open the real output (a page at phone width 360 px and at desktop width; a document or slide rendered) and look at the images before you report or push. A text check (curl, grep, a passing test) shows that words are there, not that they can be read.`,
};

// ---------- ledger ----------

export interface LedgerSwitches { check: boolean; look: boolean }

/**
 * What changed and was not checked or looked at, plus the once-per-prompt asks.
 * Unchecked and unlooked entries persist across prompts; the asks reset with each user prompt.
 */
export function createCheckLedger() {
	/** Unchecked code files, each with the revision of its last change. */
	const unchecked = new Map<string, number>();
	const unlooked = new Set<string>();
	/** Checks started in the background, by task id: what they run and how many changes existed when they started. */
	const background = new Map<string, { command: string; revision: number }>();
	let failed: { command: string; snippet: string } | undefined;
	let revision = 0, visibleChangedAt = 0;
	let codeThisPrompt = false, visibleThisPrompt = false, anyThisPrompt = false, asked = false, held = false;
	const checkPending = () => unchecked.size > 0 || failed !== undefined;
	const failure = () => failed && { command: clip(failed.command, 80), snippet: failed.snippet };
	const uncheckedFiles = () => [...unchecked.keys()];
	/** A finished check proves the changes made up to `upTo`, not those made while it ran. */
	const settle = (command: string, outcome: Settled, upTo: number) => {
		for (const [file, changed] of unchecked) if (changed <= upTo) unchecked.delete(file);
		failed = outcome.kind === "pass" ? undefined : { command, snippet: outcome.snippet };
	};
	return {
		/** A file the agent wrote or edited. */
		change(file: string, cwd?: string) {
			anyThisPrompt = true;
			revision++;
			if (isCodeFile(file, cwd)) { unchecked.set(projectPath(file, cwd), revision); codeThisPrompt = true; }
			if (isVisibleFile(file, cwd)) { unlooked.add(projectPath(file, cwd)); visibleThisPrompt = true; visibleChangedAt = Date.now(); }
		},
		/** A command that ran. Returns what it meant for the gate; undefined when it was not a check. A check started in the background proves nothing until `backgroundEnded`. */
		check(command: string, result: CheckResult): CheckOutcome | undefined {
			const outcome = checkOutcome(command, result);
			if (!outcome) return undefined;
			if (outcome.kind === "background") {
				if (result.taskId) {
					background.set(result.taskId, { command, revision });
					while (background.size > 32) background.delete(background.keys().next().value!);
				}
				return outcome;
			}
			settle(command, outcome, revision);
			return outcome;
		},
		/** A background task ended with this exit and output. Does nothing for a task that was not a check started here. */
		backgroundEnded(taskId: string, result: Omit<CheckResult, "background" | "taskId">): CheckOutcome | undefined {
			const started = background.get(taskId);
			if (!started) return undefined;
			background.delete(taskId);
			const outcome = checkOutcome(started.command, result);
			if (outcome && outcome.kind !== "background") settle(started.command, outcome, started.revision);
			return outcome;
		},
		/** An image or rendered output was opened. */
		look() { unlooked.clear(); },
		/** When (epoch ms) the latest visible file was written: an image older than that shows an earlier state. */
		visibleChangedAt: () => visibleChangedAt,
		newPrompt() { codeThisPrompt = false; visibleThisPrompt = false; anyThisPrompt = false; asked = false; held = false; },
		reset() { this.newPrompt(); unchecked.clear(); unlooked.clear(); background.clear(); failed = undefined; visibleChangedAt = 0; },
		/** The text for the end of a turn: once per prompt, only for what this prompt changed. `lookOwned` is true when another owner already asks for the look; `report` is the final assistant message. */
		finish(switches: LedgerSwitches, lookOwned = false, report = ""): string | undefined {
			if (asked) return undefined;
			const parts: string[] = [];
			const phrase = switches.check && anyThisPrompt ? deferredPhrase(report) : undefined;
			if (switches.check && codeThisPrompt && checkPending()) {
				// A report that already says what failed did what the ask would ask for.
				if (unchecked.size) parts.push(checkTexts.stopUnchecked(uncheckedFiles()));
				else if (!statesFailure(report)) parts.push(checkTexts.stopFailed(failure()!));
			}
			if (switches.look && !lookOwned && visibleThisPrompt && unlooked.size) parts.push(checkTexts.look([...unlooked]));
			if (phrase) parts.push(checkTexts.deferred(phrase));
			if (!parts.length) return undefined;
			asked = true;
			return [...parts, checkTexts.copies].join("\n\n");
		},
		/** The text that holds a publishing command: once per prompt. */
		beforePublish(switches: LedgerSwitches): string | undefined {
			if (held) return undefined;
			const parts: string[] = [];
			if (switches.check && checkPending()) parts.push(unchecked.size ? checkTexts.shipUnchecked(uncheckedFiles()) : checkTexts.shipFailed(failure()!));
			if (switches.look && unlooked.size) parts.push(checkTexts.look([...unlooked]));
			if (!parts.length) return undefined;
			held = true;
			return parts.join("\n\n");
		},
		/** True when this gate asks, or already asked, about unchecked code in this prompt: other end-of-turn check nudges stay silent. */
		coversCheck: (switches: LedgerSwitches) => switches.check && codeThisPrompt && (checkPending() || asked),
		snapshot: () => ({ unchecked: uncheckedFiles(), unlooked: [...unlooked], failed: failure(), codeThisPrompt, visibleThisPrompt }),
	};
}

export type CheckLedger = ReturnType<typeof createCheckLedger>;

/** The last assistant turn, kept beside the ledger so every end-of-turn owner reads the same one. */
export const finalTurn: { stop?: string; report: string } = ((globalThis as any)[Symbol.for("yunus-pi.final-turn.v1")] ??= { report: "" });

/** Commands a gate has held: a retry of the same command passes every gate, so one command is held once, whoever held it. */
const HELD = ((globalThis as any)[Symbol.for("yunus-pi.held-commands.v1")] ??= new Map<string, string>()) as Map<string, string>;
export const wasHeld = (command: string): boolean => HELD.has(command);
/** The receipts gate records its own waiver on a repeat, so it skips only commands the check gate held. */
export const heldByCheckGate = (command: string): boolean => HELD.get(command) === "check-gate";
export const clearHeld = () => HELD.clear();
export function noteHeld(command: string, owner = "check-gate"): void {
	HELD.set(command, owner);
	while (HELD.size > 32) HELD.delete(HELD.keys().next().value!);
}

/** Armed while the check gate is loaded in this process (not in a subagent child), so others know it speaks. */
const ARMED = Symbol.for("yunus-pi.check-gate-armed.v1");
export const armCheckGate = () => { (globalThis as any)[ARMED] = true; };
/** True when the check gate owns this prompt's end-of-turn check ask, so the older nudges for the same state hold back. */
export const checkGateCovers = (): boolean => (globalThis as any)[ARMED] === true && sharedCheckLedger().coversCheck({ check: checkGateOn(), look: lookGateOn() });

/** One ledger per process: the extension loader evaluates a module once per importer. */
const SHARED = Symbol.for("yunus-pi.check-ledger.v1");
export function sharedCheckLedger(): CheckLedger {
	return ((globalThis as any)[SHARED] ??= createCheckLedger());
}

/** PI_CHECK_GATE=0 turns off the whole gate, the look part too; PI_LOOK_GATE=0 turns off only the look part. */
export const checkGateOn = () => process.env.PI_CHECK_GATE !== "0";
export const lookGateOn = () => checkGateOn() && process.env.PI_LOOK_GATE !== "0";
