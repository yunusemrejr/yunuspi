/**
 * What a parsed shell command does beyond the working tree.
 *
 * The filesystem guard owns shell parsing (wrappers, substitutions, pipelines)
 * and every block. This module only names a consequence from the executable
 * and the operands the guard already resolved: publishing, deploying, sending,
 * deleting something remote, running downloaded code, discarding local work.
 * Naming it lets the guard decide by evidence instead of by prompt: a snapshot
 * taken first, or the user's own words read by a judge (command-intent.ts).
 *
 * Pure: no I/O, no process state. An unresolved operand is `undefined`.
 */

export type ConsequenceKind =
	| "push" | "publish" | "deploy" | "remote-delete" | "remote-code"
	| "send" | "local-loss" | "privilege" | "system";

export interface Consequence {
	kind: ConsequenceKind;
	/** Completes "This command …" in plain words, for the user and the judge. */
	effect: string;
	/** What clears it. `snapshot`: a worktree checkpoint taken first makes it
	 * recoverable. `request`: the user asked for this consequence. */
	needs: "snapshot" | "request";
	/** `git -C <dir>`: where the snapshot has to be taken. */
	workdir?: string;
}

type Operands = readonly (string | undefined)[];

/** Leading words that are not options; `valued` options consume the next operand. */
function words(args: readonly string[], valued: readonly string[] = []): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") { out.push(...args.slice(i + 1)); break; }
		if (arg.startsWith("-") && arg !== "-") { if (valued.includes(arg)) i++; continue; }
		out.push(arg);
	}
	return out;
}
const cluster = (args: readonly string[], letter: string) => args.some((arg) => /^-[A-Za-z]+$/.test(arg) && arg.includes(letter));
const any = (args: readonly string[], ...flags: string[]) => args.some((arg) => flags.includes(arg) || flags.some((flag) => flag.startsWith("--") && arg.startsWith(`${flag}=`)));
const starts = (list: readonly string[], ...prefix: (string | readonly string[])[]) =>
	prefix.every((want, at) => typeof want === "string" ? list[at] === want : want.includes(list[at] ?? ""));

const GIT_GLOBAL_VALUED = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"];

/** `git <verb>`: pushes, and the verbs that discard uncommitted work. */
export function gitConsequence(values: Operands): Consequence | undefined {
	const args = values.map((value) => value ?? "");
	let at = 0, workdir: string | undefined;
	while (at < args.length && args[at].startsWith("-")) {
		if (args[at] === "-C") workdir = values[at + 1];
		at += GIT_GLOBAL_VALUED.includes(args[at]) ? 2 : 1;
	}
	const verb = args[at], rest = args.slice(at + 1);
	const local = (effect: string, needs: Consequence["needs"] = "snapshot"): Consequence => ({ kind: "local-loss", effect, needs, ...(workdir === undefined ? {} : { workdir }) });
	if (verb === "push") {
		if (any(rest, "--dry-run") || cluster(rest, "n")) return;
		const targets = words(rest, ["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
		const remote = targets[0] ? ` "${targets[0]}"` : "";
		const rewrites = any(rest, "--force", "--force-with-lease", "--force-if-includes", "--delete", "--mirror", "--prune") ||
			cluster(rest, "f") || cluster(rest, "d") || targets.slice(1).some((ref) => ref.startsWith("+") || ref.startsWith(":"));
		return rewrites
			? { kind: "push", needs: "request", effect: `overwrites or deletes branches or history on the git remote${remote}; other people's copies and open work can be affected` }
			: { kind: "push", needs: "request", effect: `publishes local commits to the git remote${remote}` };
	}
	if (verb === "reset" && any(rest, "--hard")) return local("discards every uncommitted change to tracked files");
	if (verb === "clean" && !any(rest, "--dry-run") && !cluster(rest, "n") && (cluster(rest, "f") || any(rest, "--force")))
		return cluster(rest, "x") || cluster(rest, "X")
			? local("deletes untracked and ignored files (build output, local settings such as .env); a snapshot does not cover ignored files", "request")
			: local("deletes untracked files");
	if (verb === "checkout" && (any(rest, "--force") || cluster(rest, "f") || rest.includes("--") && rest.indexOf("--") < rest.length - 1 || words(rest).includes(".")))
		return local("overwrites uncommitted changes in the working tree");
	if (verb === "restore" && (!any(rest, "--staged") && !cluster(rest, "S") || any(rest, "--worktree") || cluster(rest, "W")))
		return local("overwrites uncommitted changes in the working tree");
	if (verb === "switch" && (any(rest, "--discard-changes", "--force") || cluster(rest, "f")))
		return local("discards uncommitted changes while switching branches");
	if (verb === "stash" && ["drop", "clear"].includes(words(rest)[0] ?? ""))
		return local("deletes stashed work", "request");
}

type Rule = { when: (list: string[], args: string[]) => boolean; kind: ConsequenceKind; effect: string | ((list: string[]) => string) };
const dry = (args: readonly string[]) => any(args, "--dry-run", "--help", "-h", "--version");

const GITHUB_WRITES: Record<string, readonly string[]> = {
	pr: ["create", "merge", "close", "comment", "review", "edit", "ready", "reopen"],
	issue: ["create", "close", "comment", "delete", "edit", "reopen", "transfer"],
	release: ["create", "delete", "upload", "edit"],
	repo: ["create", "delete", "rename", "archive", "edit"],
	gist: ["create", "delete", "edit"],
	workflow: ["run", "enable", "disable"],
	run: ["rerun", "cancel", "delete"],
	secret: ["set", "delete"],
	variable: ["set", "delete"],
	label: ["create", "delete", "edit"],
};
const KUBE_WRITES = ["apply", "delete", "replace", "patch", "scale", "create", "edit", "set", "annotate", "label", "drain", "cordon", "uncordon", "taint"];
const DESTROY_VERB = /^(?:delete|destroy|terminate|remove|purge|deregister)(?:-|$)/;
const DESTRUCTIVE_SQL = /\b(?:drop\s+(?:database|schema|table|index|collection|keyspace)|truncate\s+(?:table\s+)?[\w."`]|dropDatabase\s*\(|\.drop\s*\(|flushall|flushdb)\b|\bdelete\s+from\s+[\w."`]+\s*;?\s*$/i;

const RULES: Record<string, readonly Rule[]> = {};
const rule = (names: string, ...rules: Rule[]) => { for (const name of names.split(" ")) RULES[name] = rules; };

rule("npm pnpm bun yarn",
	{ kind: "publish", effect: "publishes this package to a package registry, where anyone can install it", when: (list, args) => !dry(args) && (starts(list, "publish") || starts(list, "npm", "publish")) },
	{ kind: "publish", effect: "changes a package that is already published (removal, deprecation, tags or owners)", when: (list) => starts(list, ["unpublish", "deprecate"]) || starts(list, ["dist-tag", "owner", "access"], ["add", "rm", "remove", "set", "grant", "revoke"]) });
rule("cargo",
	{ kind: "publish", effect: "publishes this crate to crates.io; a published version cannot be deleted", when: (list, args) => !dry(args) && starts(list, ["publish", "yank"]) });
rule("twine", { kind: "publish", effect: "uploads this package to a Python package index", when: (list) => starts(list, "upload") });
rule("poetry uv hatch flit vsce", { kind: "publish", effect: "publishes this package to a public index", when: (list, args) => !dry(args) && starts(list, "publish") });
rule("gem", { kind: "publish", effect: "publishes or withdraws a gem on rubygems.org", when: (list) => starts(list, ["push", "yank"]) });
rule("docker podman",
	{ kind: "publish", effect: "uploads an image to a container registry", when: (list, args) => starts(list, "push") || starts(list, ["build", "buildx"]) && any(args, "--push") },
	{ kind: "local-loss", effect: "deletes Docker volumes and the data stored in them", when: (list, args) => starts(list, "system", "prune") && any(args, "--volumes") || starts(list, "volume", ["rm", "remove", "prune"]) || starts(list, "compose", "down") && (any(args, "--volumes") || cluster(args, "v")) });
rule("docker-compose", { kind: "local-loss", effect: "deletes Docker volumes and the data stored in them", when: (list, args) => starts(list, "down") && (any(args, "--volumes") || cluster(args, "v")) });
rule("gh",
	{ kind: "publish", effect: (list) => `changes something on GitHub that other people see or are notified about (${list.slice(0, 2).join(" ")})`, when: (list) => (GITHUB_WRITES[list[0]] ?? []).includes(list[1] ?? "") },
	{ kind: "publish", effect: "sends a write request to the GitHub API", when: (list, args) => {
		if (!starts(list, "api")) return false;
		const at = args.findIndex((arg) => arg === "-X" || arg === "--method");
		const method = at >= 0 ? args[at + 1] : args.map((arg) => /^(?:-X|--method=)(\w+)$/.exec(arg)?.[1]).find(Boolean);
		return method ? !/^get$/i.test(method) : any(args, "-f", "-F", "--field", "--raw-field", "--input");
	} });
rule("vercel", { kind: "deploy", effect: "deploys or changes a live site on Vercel", when: (list, args) => !dry(args) && (!list.length || starts(list, ["deploy", "promote", "rollback", "remove", "rm", "alias"])) });
rule("netlify firebase", { kind: "deploy", effect: "deploys to a live site", when: (list, args) => !dry(args) && starts(list, "deploy") });
rule("fly flyctl", { kind: "deploy", effect: "deploys or changes a live app on Fly.io", when: (list) => starts(list, ["deploy", "launch"]) || starts(list, "apps", "destroy") });
rule("wrangler", { kind: "deploy", effect: "deploys or deletes a live Cloudflare worker or site", when: (list, args) => !dry(args) && (starts(list, ["deploy", "publish", "delete"]) || starts(list, "pages", "deploy")) });
rule("railway", { kind: "deploy", effect: "deploys to a live service", when: (list) => starts(list, "up") });
rule("terraform tofu", { kind: "deploy", effect: (list) => `changes real infrastructure (${list.slice(0, 2).join(" ")})`, when: (list, args) => !any(args, "-help", "--help") && (starts(list, ["apply", "destroy", "taint", "untaint", "import"]) || starts(list, "state", ["rm", "mv", "push"]) || starts(list, "workspace", "delete")) });
rule("pulumi", { kind: "deploy", effect: (list) => `changes real infrastructure (${list.slice(0, 2).join(" ")})`, when: (list, args) => !any(args, "--help") && (starts(list, ["up", "destroy", "refresh", "import"]) || starts(list, "stack", "rm")) });
rule("kubectl oc", { kind: "deploy", effect: (list) => `changes a live Kubernetes cluster (${list[0]}${list[0] === "rollout" ? ` ${list[1]}` : ""})`, when: (list, args) => !any(args, "--dry-run", "--help") && (KUBE_WRITES.includes(list[0] ?? "") || starts(list, "rollout", ["restart", "undo", "pause", "resume"])) });
rule("helm", { kind: "deploy", effect: (list) => `changes a live Kubernetes release (${list[0]})`, when: (list, args) => !any(args, "--dry-run", "--help") && starts(list, ["install", "upgrade", "uninstall", "delete", "rollback"]) });
rule("ansible-playbook", { kind: "deploy", effect: "applies changes to remote machines", when: (_list, args) => !any(args, "--check", "--syntax-check", "--list-hosts", "--list-tasks", "--help") && !cluster(args, "C") });
rule("aws",
	{ kind: "remote-delete", effect: (list) => `deletes cloud resources or data (aws ${list.slice(0, 2).join(" ")})`, when: (list, args) => !any(args, "--dryrun", "--dry-run") && list[0] !== "help" && (starts(list, "s3", ["rm", "rb"]) || starts(list, "s3", "sync") && any(args, "--delete") || DESTROY_VERB.test(list[1] ?? "")) });
rule("gcloud az doctl",
	{ kind: "deploy", effect: (list) => `deploys to a live cloud service (${list.slice(0, 3).join(" ")})`, when: (list, args) => !any(args, "--help") && list.includes("deploy") },
	{ kind: "remote-delete", effect: (list) => `deletes cloud resources (${list.slice(0, 3).join(" ")})`, when: (list, args) => !any(args, "--help") && list.slice(0, 5).some((word) => DESTROY_VERB.test(word)) });
rule("dropdb", { kind: "remote-delete", effect: "deletes a whole database", when: (_list, args) => !any(args, "--help", "--version") });
rule("psql mysql mariadb mongosh mongo redis-cli clickhouse-client cockroach",
	{ kind: "remote-delete", effect: "deletes tables, collections or rows in a database server; unless a backup exists this cannot be undone", when: (_list, args) => args.some((arg) => DESTRUCTIVE_SQL.test(arg)) });
rule("mail mailx s-nail sendmail mutt msmtp swaks", { kind: "send", effect: "sends an email", when: (_list, args) => !any(args, "--help", "--version", "-bp") });
rule("crontab",
	{ kind: "system", effect: "deletes every scheduled job of this user", when: (_list, args) => cluster(args, "r") },
	{ kind: "system", effect: "replaces this user's scheduled jobs", when: (list, args) => !cluster(args, "l") && !cluster(args, "e") && (list.length > 0 || args.includes("-")) });

/** Options that consume the next operand, so the verb is found behind them. */
const VALUED: Record<string, readonly string[]> = {
	aws: ["--profile", "--region", "--output", "--endpoint-url", "--query", "--color", "--ca-bundle", "--cli-read-timeout", "--cli-connect-timeout"],
	gh: ["-R", "--repo", "--hostname"],
	kubectl: ["-n", "--namespace", "--context", "--cluster", "--user", "--kubeconfig", "-s", "--server", "--token", "--as", "--as-group", "--request-timeout"],
	oc: ["-n", "--namespace", "--context", "--cluster", "--user", "--kubeconfig", "-s", "--server", "--token", "--as"],
	helm: ["-n", "--namespace", "--kube-context", "--kubeconfig"],
	vercel: ["-t", "--token", "-S", "--scope", "--cwd", "-A", "--local-config", "-Q", "--global-config"],
	docker: ["-c", "--context", "-H", "--host", "--config", "-l", "--log-level"],
	crontab: ["-u"],
	gcloud: ["--project", "--account", "--configuration", "--format", "--region", "--zone"],
	az: ["--subscription", "-g", "--resource-group", "-o", "--output"],
};

/** The consequence of one command, from its executable name and operands. */
export function commandConsequence(name: string, values: Operands): Consequence | undefined {
	if (name === "git") return gitConsequence(values);
	const rules = Object.hasOwn(RULES, name) ? RULES[name] : undefined;
	if (!rules) return;
	const args = values.map((value) => value ?? "");
	const list = words(args, Object.hasOwn(VALUED, name) ? VALUED[name] : []);
	for (const entry of rules) {
		if (!entry.when(list, args)) continue;
		return { kind: entry.kind, needs: "request", effect: typeof entry.effect === "string" ? entry.effect : entry.effect(list) };
	}
}

const DOWNLOADERS = new Set(["curl", "wget", "aria2c", "http", "https", "xh"]);
const INTERPRETER = /^(?:sh|bash|zsh|dash|ksh|fish|python[\d.]*|node|deno|bun|perl|ruby|php)$/;
/** Options after which an interpreter still reads its program from stdin. */
const STDIN_PROGRAM = (name: string, args: readonly string[]) => {
	const list = words(args);
	if (/^(?:sh|bash|zsh|dash|ksh|fish)$/.test(name)) return !cluster(args, "c") && (cluster(args, "s") || !list.length || list[0] === "-");
	return !any(args, "-c", "-e", "-m", "--eval", "-r") && (!list.length || list[0] === "-");
};
const sourceHost = (values: Operands) => {
	for (const value of values) {
		const match = /^[a-z][a-z0-9+.-]*:\/\/([^/\s?#@]*@)?([^/\s?#:]+)/i.exec(value ?? "");
		if (match) return match[2].toLowerCase();
	}
};
const remoteCode = (host: string | undefined): Consequence => ({
	kind: "remote-code", needs: "request",
	effect: `downloads a program from ${host ?? "the network"} and runs it at once, before anyone has read it`,
});

export interface ParsedCommand { name: string; values: Operands }

/** A pipeline whose download feeds an interpreter (`curl … | sh`). */
export function pipelineConsequence(stages: readonly ParsedCommand[]): Consequence | undefined {
	const from = stages.findIndex((stage) => DOWNLOADERS.has(stage.name));
	if (from < 0) return;
	const runs = stages.slice(from + 1).some((stage) => INTERPRETER.test(stage.name) && STDIN_PROGRAM(stage.name, stage.values.map((value) => value ?? "")));
	return runs ? remoteCode(sourceHost(stages[from].values)) : undefined;
}

/** Which operands a command executes as a program rather than reads as data:
 * everything for `eval`/`source`, the script after `-c`/`-e` for an
 * interpreter. A download substituted into one of these runs unread. */
export function programOperands(name: string, values: Operands): number[] {
	if (["eval", "source", "."].includes(name)) return values.map((_value, at) => at);
	if (!INTERPRETER.test(name)) return [];
	const shell = /^(?:sh|bash|zsh|dash|ksh|fish)$/.test(name);
	const at = values.findIndex((value) => value !== undefined && (shell ? /^-[a-z]*c[a-z]*$/.test(value) : ["-c", "-e", "--eval", "-r"].includes(value)));
	return at >= 0 && at + 1 < values.length ? [at + 1] : [];
}

/** A command that executes what a substitution downloaded: `sh -c "$(curl …)"`,
 * `eval "$(wget -O- …)"`, `bash <(curl …)`, `source <(curl …)`. `fetched` are
 * the commands substituted into its program operands. */
export function substitutionConsequence(name: string, fetched: readonly ParsedCommand[]): Consequence | undefined {
	if (!INTERPRETER.test(name) && !["eval", "source", "."].includes(name)) return;
	const download = fetched.find((command) => DOWNLOADERS.has(command.name));
	return download ? remoteCode(sourceHost(download.values)) : undefined;
}

/** `sudo`/`doas` in front of a script, build or test: run as administrator it
 * can change the system far beyond what its visible arguments show. */
export function elevatedConsequence(name: string): Consequence | undefined {
	if (/^(?:bash|sh|dash|zsh|python[\d.]*|node|npm|npx|pnpm|yarn|pytest|make|ctest|cargo|go)$/.test(name))
		return { kind: "privilege", needs: "request", effect: `runs "${name}" as administrator; a script, build or test run this way can change the system far beyond what its arguments show` };
}
