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
	/** The command names its repository in a way that cannot be read here (an
	 * unresolved `-C`, `--git-dir`, `--work-tree`), so a snapshot would be taken
	 * in the wrong place. */
	unlocated?: true;
}

/** Consequences that reach other machines or other people. A project script is
 * read for these; what it does to local files is the project's own business. */
export const REACHES_OUT: ReadonlySet<ConsequenceKind> = new Set(["push", "publish", "deploy", "remote-delete", "remote-code", "send"]);

type Operands = readonly (string | undefined)[];

/**
 * Positions of the operands that are not options. `valued` options consume
 * the next operand. With `loose`, so does every option the list does not know
 * (`--registry <url>`, `-F app`): a tool's verb can sit behind either reading,
 * and no table of every tool's options stays complete.
 */
function wordsAt(args: readonly string[], valued: readonly string[] = [], loose = false): number[] {
	const out: number[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") { for (let rest = i + 1; rest < args.length; rest++) out.push(rest); break; }
		if (arg.startsWith("-") && arg !== "-") {
			if (valued.includes(arg) || loose && !arg.includes("=") && i + 1 < args.length && !args[i + 1].startsWith("-")) i++;
			continue;
		}
		out.push(i);
	}
	return out;
}
const words = (args: readonly string[], valued: readonly string[] = [], loose = false) => wordsAt(args, valued, loose).map((at) => args[at]);
const cluster = (args: readonly string[], letter: string) => args.some((arg) => /^-[A-Za-z]+$/.test(arg) && arg.includes(letter));
const any = (args: readonly string[], ...flags: string[]) => args.some((arg) => flags.includes(arg) || flags.some((flag) => flag.startsWith("--") && arg.startsWith(`${flag}=`)));
const starts = (list: readonly string[], ...prefix: (string | readonly string[])[]) =>
	prefix.every((want, at) => typeof want === "string" ? list[at] === want : want.includes(list[at] ?? ""));
const base = (value: string) => value.slice(value.lastIndexOf("/") + 1);

const GIT_GLOBAL_VALUED = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"];

/** The options before git's verb: where the verb sits and which repository they point at. */
function gitHead(values: Operands) {
	const args = values.map((value) => value ?? "");
	let at = 0, workdir: string | undefined, unlocated = false;
	while (at < args.length && args[at].startsWith("-")) {
		const option = args[at];
		if (option === "-C") {
			// Several -C add up, each relative to the one before.
			const next = values[at + 1];
			if (next === undefined) unlocated = true;
			else workdir = workdir === undefined || next.startsWith("/") ? next : `${workdir}/${next}`;
		}
		if (/^--(?:git-dir|work-tree)(?:=|$)/.test(option) || option === "-c" && /^core\.(?:worktree|bare)=/i.test(args[at + 1] ?? "")) unlocated = true;
		at += GIT_GLOBAL_VALUED.includes(option) ? 2 : 1;
	}
	return { args, at, workdir, unlocated };
}

/** git's verb as written, and where its own operands start. `unread` when the
 * verb is a variable, a substitution or a pattern: nothing can be said about
 * what such a command does. */
export function gitVerb(values: Operands): { verb?: string; unread: boolean; head: Operands; rest: Operands; workdir?: string } {
	const { at, workdir } = gitHead(values);
	const verb = values[at];
	const unread = at < values.length && (verb === undefined || /[{}*?[\]]/.test(verb));
	return { ...(verb === undefined ? {} : { verb }), unread, head: values.slice(0, at), rest: values.slice(at + 1), ...(workdir === undefined ? {} : { workdir }) };
}

/** `git <verb>`: pushes, and the verbs that discard uncommitted work. */
export function gitConsequence(values: Operands): Consequence | undefined {
	const { args, at, workdir, unlocated } = gitHead(values);
	const verb = args[at], rest = args.slice(at + 1);
	// `git push -h` prints usage and does nothing else.
	if (rest.slice(0, rest.includes("--") ? rest.indexOf("--") : rest.length).includes("-h")) return;
	const local = (effect: string, needs: Consequence["needs"] = "snapshot"): Consequence => ({
		kind: "local-loss", effect, needs, ...(workdir === undefined ? {} : { workdir }), ...(unlocated ? { unlocated: true as const } : {}),
	});
	const forced = any(rest, "--force") || cluster(rest, "f");
	if (verb === "push") {
		if (any(rest, "--dry-run") || cluster(rest, "n")) return;
		const targets = words(rest, ["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
		const remote = targets[0] ? ` "${targets[0]}"` : "";
		const rewrites = any(rest, "--force", "--force-with-lease", "--force-if-includes", "--delete", "--mirror", "--prune") ||
			cluster(rest, "f") || cluster(rest, "d") || targets.some((ref) => ref.startsWith("+") || ref.startsWith(":"));
		return rewrites
			? { kind: "push", needs: "request", effect: `overwrites or deletes branches or history on the git remote${remote}; other people's copies and open work can be affected` }
			: { kind: "push", needs: "request", effect: `publishes local commits to the git remote${remote}` };
	}
	if (verb === "reset" && any(rest, "--hard")) return local("discards every uncommitted change to tracked files");
	if (verb === "clean" && !any(rest, "--dry-run") && !cluster(rest, "n") && forced)
		return cluster(rest, "x") || cluster(rest, "X")
			? local("deletes untracked and ignored files (build output, local settings such as .env); a snapshot does not cover ignored files", "request")
			: local("deletes untracked files");
	if (verb === "checkout") {
		// A path restores over local edits with or without `--`, and a name alone
		// does not say whether it is a branch or a path: any operand is treated as
		// a path. Creating or detaching a branch carries local edits along.
		const pathsAfterDashes = rest.includes("--") && rest.indexOf("--") < rest.length - 1;
		const creates = any(rest, "--orphan", "--detach", "--track") || ["b", "B", "t", "d"].some((letter) => cluster(rest, letter));
		if (forced || pathsAfterDashes || !creates && words(rest, ["--conflict", "--pathspec-from-file"]).length > 0)
			return local("can overwrite uncommitted changes in the working tree");
	}
	if (verb === "restore" && (!any(rest, "--staged") && !cluster(rest, "S") || any(rest, "--worktree") || cluster(rest, "W")))
		return local("overwrites uncommitted changes in the working tree");
	if (verb === "switch" && (any(rest, "--discard-changes") || forced))
		return local("discards uncommitted changes while switching branches");
	if (verb === "rm" && forced && !any(rest, "--cached", "--dry-run") && !cluster(rest, "n"))
		return local("deletes files together with any uncommitted changes in them");
	if (verb === "submodule" && words(rest)[0] === "deinit" && forced)
		return local("removes a submodule's files together with any uncommitted changes in them, which a snapshot of this repository does not cover", "request");
	if (verb === "stash" && ["drop", "clear"].includes(words(rest)[0] ?? ""))
		return local("deletes stashed work", "request");
	if (verb === "worktree" && words(rest)[0] === "remove" && forced)
		return local("deletes a work tree together with any uncommitted changes in it", "request");
	if (verb === "reflog" && ["expire", "delete"].includes(words(rest)[0] ?? "") || verb === "update-ref" && (cluster(rest, "d") || any(rest, "--stdin")) ||
		verb === "gc" && rest.some((arg) => /^--prune=(?:now|all)$/.test(arg)) || verb === "filter-branch" || verb === "filter-repo")
		return local("rewrites or deletes local history and the records that could bring it back, which no snapshot covers", "request");
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
/** `host:path` or `user@host:path`, the way rsync and scp name another machine. */
const REMOTE_PATH = /^(?:[\w.-]+@)?[\w.-]+:(?!\/\/)|^rsync:\/\//;

const RULES: Record<string, readonly Rule[]> = {};
const rule = (names: string, ...rules: Rule[]) => { for (const name of names.split(" ")) RULES[name] = rules; };

rule("npm pnpm bun yarn",
	{ kind: "publish", effect: "publishes this package to a package registry, where anyone can install it", when: (list, args) => !dry(args) && (starts(list, "publish") || starts(list, "npm", "publish") || starts(list, "workspace") && (list[2] === "publish" || list[2] === "npm" && list[3] === "publish")) },
	{ kind: "publish", effect: "changes a package that is already published (removal, deprecation, tags or owners)", when: (list) => starts(list, ["unpublish", "deprecate"]) || starts(list, ["dist-tag", "owner", "access"], ["add", "rm", "remove", "set", "grant", "revoke"]) });
rule("cargo",
	{ kind: "publish", effect: "publishes this crate to crates.io; a published version cannot be deleted", when: (list, args) => !dry(args) && starts(list, ["publish", "yank"]) });
rule("twine", { kind: "publish", effect: "uploads this package to a Python package index", when: (list) => starts(list, "upload") });
rule("poetry uv hatch flit vsce", { kind: "publish", effect: "publishes this package to a public index", when: (list, args) => !dry(args) && starts(list, "publish") });
rule("gem", { kind: "publish", effect: "publishes or withdraws a gem on rubygems.org", when: (list) => starts(list, ["push", "yank"]) });
rule("flutter dart", { kind: "publish", effect: "publishes this package to pub.dev; a published version cannot be deleted", when: (list, args) => !dry(args) && starts(list, "pub", "publish") });
rule("dotnet nuget", { kind: "publish", effect: "publishes a package to a NuGet feed", when: (list) => starts(list, "nuget", "push") || starts(list, "push") });
rule("mvn mvnw gradle gradlew", { kind: "publish", effect: "publishes build artifacts to a remote repository", when: (list, args) => !dry(args) && !cluster(args, "m") && list.some((word) => /^(?:deploy(?::[\w-]+)?|release:perform|(?:[\w-]*:)*publish(?!ToMavenLocal$)\w*|closeAndReleaseRepository)$/.test(word)) });
rule("docker podman",
	{ kind: "publish", effect: "uploads an image to a container registry", when: (list, args) => starts(list, "push") || starts(list, ["image", "manifest", "compose"], "push") || starts(list, ["build", "buildx"]) && (any(args, "--push") || args.some((arg, at) => (["--output", "-o"].includes(args[at - 1]) || arg.startsWith("--output=")) && /(?:^|[=,])(?:type=registry|push=true)(?:,|$)/.test(arg))) },
	{ kind: "local-loss", effect: "deletes Docker volumes and the data stored in them", when: (list, args) => starts(list, "system", "prune") && any(args, "--volumes") || starts(list, "volume", ["rm", "remove", "prune"]) || starts(list, "compose", "down") && (any(args, "--volumes") || cluster(args, "v")) });
rule("docker-compose",
	{ kind: "publish", effect: "uploads an image to a container registry", when: (list) => starts(list, "push") },
	{ kind: "local-loss", effect: "deletes Docker volumes and the data stored in them", when: (list, args) => starts(list, "down") && (any(args, "--volumes") || cluster(args, "v")) });
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
rule("surge gh-pages", { kind: "deploy", effect: "publishes files to a live site", when: (list, args) => !dry(args) && !starts(list, ["list", "whoami", "login", "logout", "help"]) });
rule("serverless sls sam cdk sst", { kind: "deploy", effect: (list) => `changes live cloud infrastructure (${list[0]})`, when: (list, args) => !dry(args) && starts(list, ["deploy", "remove", "destroy", "delete"]) });
rule("heroku", { kind: "deploy", effect: (list) => `changes a live Heroku app (${list[0]})`, when: (list) => /^(?:apps:destroy|pg:reset|pg:push|releases:rollback|container:release|ps:scale|config:set|config:unset|addons:destroy)$/.test(list[0] ?? "") });
rule("eas", { kind: "publish", effect: "submits or updates a published app", when: (list) => starts(list, ["submit", "update"]) });
rule("terraform tofu", { kind: "deploy", effect: (list) => `changes real infrastructure (${list.slice(0, 2).join(" ")})`, when: (list, args) => !any(args, "-help", "--help") && (starts(list, ["apply", "destroy", "taint", "untaint", "import"]) || starts(list, "state", ["rm", "mv", "push"]) || starts(list, "workspace", "delete")) });
rule("pulumi", { kind: "deploy", effect: (list) => `changes real infrastructure (${list.slice(0, 2).join(" ")})`, when: (list, args) => !any(args, "--help") && (starts(list, ["up", "destroy", "refresh", "import"]) || starts(list, "stack", "rm")) });
rule("kubectl oc", { kind: "deploy", effect: (list) => `changes a live Kubernetes cluster (${list[0]}${list[0] === "rollout" ? ` ${list[1]}` : ""})`, when: (list, args) => !any(args, "--dry-run", "--help") && (KUBE_WRITES.includes(list[0] ?? "") || starts(list, "rollout", ["restart", "undo", "pause", "resume"])) });
rule("helm", { kind: "deploy", effect: (list) => `changes a live Kubernetes release or chart registry (${list[0]})`, when: (list, args) => !any(args, "--dry-run", "--help") && starts(list, ["install", "upgrade", "uninstall", "delete", "rollback", "push"]) });
rule("ansible-playbook", { kind: "deploy", effect: "applies changes to remote machines", when: (_list, args) => !any(args, "--check", "--syntax-check", "--list-hosts", "--list-tasks", "--help") && !cluster(args, "C") });
rule("rsync", { kind: "deploy", effect: "copies files onto another machine, replacing what is there", when: (list, args) => !any(args, "--dry-run", "--help") && !cluster(args, "n") && list.length > 1 && REMOTE_PATH.test(list.at(-1) ?? "") });
rule("scp", { kind: "deploy", effect: "copies files onto another machine, replacing what is there", when: (list) => list.length > 1 && REMOTE_PATH.test(list.at(-1) ?? "") });
rule("aws",
	{ kind: "remote-delete", effect: (list) => `deletes cloud resources or data (aws ${list.slice(0, 2).join(" ")})`, when: (list, args) => !any(args, "--dryrun", "--dry-run") && list[0] !== "help" && (starts(list, "s3", ["rm", "rb"]) || starts(list, "s3", "sync") && any(args, "--delete") || DESTROY_VERB.test(list[1] ?? "")) });
rule("gcloud az doctl",
	{ kind: "deploy", effect: (list) => `deploys to a live cloud service (${list.slice(0, 3).join(" ")})`, when: (list, args) => !any(args, "--help") && list.includes("deploy") },
	{ kind: "remote-delete", effect: (list) => `deletes cloud resources (${list.slice(0, 3).join(" ")})`, when: (list, args) => !any(args, "--help") && list.slice(0, 5).some((word) => DESTROY_VERB.test(word)) });
rule("dropdb", { kind: "remote-delete", effect: "deletes a whole database", when: (_list, args) => !any(args, "--help", "--version") });
rule("psql mysql mariadb mongosh mongo redis-cli clickhouse-client cockroach",
	{ kind: "remote-delete", effect: "deletes tables, collections or rows in a database server; unless a backup exists this cannot be undone", when: (_list, args) => args.some((arg) => DESTRUCTIVE_SQL.test(arg)) });
rule("prisma",
	{ kind: "remote-delete", effect: "drops and recreates the configured database, deleting its data", when: (list, args) => starts(list, "migrate", "reset") || starts(list, "db", "push") && any(args, "--force-reset") },
	{ kind: "deploy", effect: "applies migrations to the configured database", when: (list) => starts(list, "migrate", "deploy") });
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
	rsync: ["-e", "--rsh", "--rsync-path", "--exclude", "--include", "--exclude-from", "--include-from", "--files-from", "--log-file", "--password-file", "--port", "--bwlimit", "--timeout", "--chmod", "--chown", "-f", "--filter", "--backup-dir", "--compare-dest", "--copy-dest", "--link-dest", "--partial-dir", "--temp-dir", "-T", "--max-size", "--min-size", "--out-format"],
	scp: ["-P", "-i", "-o", "-F", "-c", "-J", "-l", "-S", "-D", "-X"],
};

/** Launchers that start another program: `npx wrangler deploy`, `pnpm dlx vercel`,
 * `uv run twine upload`. Each entry is the words that precede the program. */
const RUNNERS: Record<string, readonly (readonly string[])[]> = {
	npx: [[]], bunx: [[]], pnpx: [[]], uvx: [[]],
	npm: [["exec"], ["x"]], pnpm: [["dlx"], ["exec"]], yarn: [["dlx"], ["exec"]], bun: [["x"]],
	uv: [["run"], ["tool", "run"]], poetry: [["run"]], pdm: [["run"]], hatch: [["run"]], pipenv: [["run"]], pipx: [["run"]], rye: [["run"]], bundle: [["exec"]],
};
/** The programs a launcher may be starting, one per way of reading its options. */
function launched(name: string, args: readonly string[]): { name: string; args: string[] }[] {
	if (/^python[\d.]*$/.test(name)) {
		const at = args.indexOf("-m");
		return at >= 0 && args[at + 1] ? [{ name: args[at + 1], args: args.slice(at + 2) }] : [];
	}
	const forms = Object.hasOwn(RUNNERS, name) ? RUNNERS[name] : undefined;
	if (!forms) return [];
	const found: { name: string; args: string[] }[] = [];
	for (const loose of [false, true]) {
		const at = wordsAt(args, [], loose);
		for (const form of forms) {
			const start = at[form.length];
			if (start !== undefined && form.every((word, k) => args[at[k]] === word)) found.push({ name: base(args[start].replace(/(.)@[^@/]*$/, "$1")), args: args.slice(start + 1) });
		}
	}
	return found;
}

const LOCAL_HOST = /^(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[?::1\]?|[^.]+\.(?:local|localhost|test|internal))$/i;
/** `curl -X DELETE` against a host that is not this machine. */
function httpDelete(args: readonly string[]): Consequence | undefined {
	const at = args.findIndex((arg) => arg === "-X" || arg === "--request");
	const method = at >= 0 ? args[at + 1] : args.map((arg) => /^(?:-X|--request=)(\w+)$/.exec(arg)?.[1]).find(Boolean);
	if (!/^delete$/i.test(method ?? "")) return;
	const target = targetHost(args);
	if (target && LOCAL_HOST.test(target)) return;
	return { kind: "remote-delete", needs: "request", effect: `sends a DELETE request to ${target ?? "a server"}, removing something there` };
}

/** The address a transfer tool talks to, when the command names one. */
const targetHost = (args: readonly string[]) => sourceHost(args) ??
	args.filter((arg) => !arg.startsWith("-")).map((arg) => /^([\w.-]+|\[[\da-f:]+\])(?::\d+)?(?:\/|$)/i.exec(arg)?.[1]).filter(Boolean).at(-1)?.toLowerCase();

/** `curl -T file`, `curl -F f=@file`, `curl -d @file`, `wget --post-file`: a
 * local file's contents leave for a host that is not this machine. */
function httpUpload(name: string, args: readonly string[]): Consequence | undefined {
	let file: string | undefined;
	for (let at = 0; at < args.length && !file; at++) {
		const arg = args[at], next = args[at + 1] ?? "";
		// `-T file`, `-sT file`, `-Tfile`, `--upload-file file`, `--upload-file=file`.
		const value = (...flags: string[]) => flags.map((flag) => {
			if (flag.startsWith("--")) return arg === flag ? next : arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1) : undefined;
			const short = arg.startsWith("--") ? null : new RegExp(`^-[A-Za-z]*${flag[1]}(.*)$`).exec(arg);
			return short ? short[1] || next : undefined;
		}).find((found) => found !== undefined);
		if (name === "wget") file = value("--post-file", "--body-file");
		else {
			file = value("-T", "--upload-file");
			// `@file` after a data option, `name@file` after --data-urlencode, `field=@file` in a form.
			file ??= /^@(.+)$/.exec(value("-d", "--data", "--data-binary", "--data-ascii", "--json") ?? "")?.[1] ??
				/^[^=@]*@(.+)$/.exec(value("--data-urlencode") ?? "")?.[1] ?? /^[^=]*=[@<]([^;]+)/.exec(value("-F", "--form") ?? "")?.[1];
		}
		if (file === "") file = undefined;
	}
	if (!file) return;
	const target = targetHost(args);
	if (target && LOCAL_HOST.test(target)) return;
	// `-` is stdin: whatever the pipeline feeds in (`cat report.json | curl -d @- …`).
	return { kind: "send", needs: "request", effect: `uploads ${file === "-" ? "the data piped into it" : `the local file "${file}"`} to ${target ?? "a server"}` };
}

/** The consequence of one command, from its executable name and operands. */
export function commandConsequence(name: string, values: Operands): Consequence | undefined {
	const args = values.map((value) => value ?? "");
	// `--help` ahead of any `--` makes a tool print its usage and stop.
	const help = args.indexOf("--help"), dashes = args.indexOf("--");
	if (help >= 0 && (dashes < 0 || help < dashes)) return;
	if (name === "git") return gitConsequence(values);
	for (const inner of launched(name, args)) {
		const found = commandConsequence(inner.name, inner.args);
		if (found) return found;
	}
	if (name === "curl") return httpDelete(args) ?? httpUpload(name, args);
	if (name === "wget") return httpUpload(name, args);
	const rules = Object.hasOwn(RULES, name) ? RULES[name] : undefined;
	if (!rules) return;
	const valued = Object.hasOwn(VALUED, name) ? VALUED[name] : [];
	const exact = words(args, valued), loose = words(args, valued, true);
	// The loose reading only adds: it is tried when it finds a verb the exact one did not.
	for (const list of loose.length && loose.join("\0") !== exact.join("\0") ? [exact, loose] : [exact])
		for (const entry of rules) {
			if (!entry.when(list, args)) continue;
			return { kind: entry.kind, needs: "request", effect: typeof entry.effect === "string" ? entry.effect : entry.effect(list) };
		}
}

/** Where a package manager runs a script from the project's own package.json:
 * the script's name and the directory option given, if any. `spread` when the
 * script runs in workspace packages instead: the packages the command names
 * (by name or path), or none named when it runs in all of them. */
export function packageScript(name: string, values: Operands): { script: string; dir?: string; spread?: string[] } | undefined {
	if (!["npm", "pnpm", "yarn", "bun"].includes(name) || values.includes(undefined)) return;
	const args = values as readonly string[];
	const DIR = ["--prefix", "-C", "--dir", "--cwd"];
	// pnpm's `-w` is a switch (the workspace root); npm's names a workspace.
	const PICK = name === "npm" ? ["-w", "--workspace"] : ["--filter", "-F"];
	const at = wordsAt(args, [...DIR, ...PICK, "--include", "--exclude", "--from", "-j", "--jobs"]);
	const picked = args.flatMap((arg, index) => PICK.includes(arg) ? [args[index + 1] ?? ""] : PICK.flatMap((flag) => flag.startsWith("--") && arg.startsWith(`${flag}=`) ? [arg.slice(flag.length + 1)] : []));
	let spread = picked.length > 0 || any(args, "--workspaces", "-ws", "-r", "--recursive");
	let list = at.map((index) => args[index]);
	// `yarn workspace web deploy`, `yarn workspaces foreach run deploy`.
	if (name === "yarn" && ["workspace", "workspaces"].includes(list[0] ?? "")) {
		if (list[0] === "workspace" && list[1]) picked.push(list[1]);
		list = list.slice(list[0] === "workspace" || list[1] === "foreach" ? 2 : 1);
		spread = true;
	}
	const runs = ["run", "run-script", "rum", "urn"].includes(list[0] ?? "");
	const script = runs ? list[1] : name === "npm" ? ({ t: "test", tst: "test", test: "test", start: "start", stop: "stop", restart: "restart", version: "version" } as Record<string, string>)[list[0] ?? ""] : list[0];
	if (!script) return;
	const flag = args.findIndex((arg) => DIR.includes(arg));
	const dir = flag >= 0 ? args[flag + 1] : args.map((arg) => /^--(?:prefix|dir|cwd)=(.+)$/.exec(arg)?.[1]).find(Boolean);
	// A pattern (`./packages/*`, `web...`) can match any package.
	return { script, ...(dir ? { dir } : {}), ...(spread ? { spread: picked.some((want) => /[^\w@/.-]|\.\.\./.test(want)) ? [] : picked } : {}) };
}

/** What `make` was asked to build: targets, the directory and the makefile named. Undefined for a dry run. */
export function makeRequest(values: Operands): { targets: string[]; dir?: string; file?: string } | undefined {
	if (values.includes(undefined)) return;
	const args = values as readonly string[];
	if (any(args, "--dry-run", "--just-print", "--recon", "--question", "--help", "--version", "--print-data-base") || cluster(args, "n") || cluster(args, "q") || cluster(args, "p")) return;
	const valued = ["-C", "--directory", "-f", "--file", "--makefile", "-I", "--include-dir", "-o", "--old-file", "--assume-old", "-W", "--what-if", "--new-file", "--assume-new", "-E", "--eval"];
	const targets = words(args, valued).filter((word) => !/^[A-Za-z_][\w.-]*\s*[:+?!]?=/.test(word));
	const value = (...flags: string[]) => {
		const at = args.findIndex((arg) => flags.includes(arg));
		return at >= 0 ? args[at + 1] : args.map((arg) => flags.map((flag) => flag.startsWith("--") && arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1) : undefined).find(Boolean)).find(Boolean);
	};
	const dir = value("-C", "--directory"), file = value("-f", "--file", "--makefile");
	return { targets, ...(dir ? { dir } : {}), ...(file ? { file } : {}) };
}

/** The recipe lines `make` would run for these targets (the first rule when
 * none is named), prerequisites included. A reading of the common makefile
 * shape, not an implementation of make: pattern rules, includes and computed
 * names are not followed. */
export function makeRecipes(makefile: string, targets: readonly string[], limit = 40): { target: string; line: string }[] {
	const rules = new Map<string, { needs: string[]; recipe: string[] }>();
	let open: string[] = [], first: string | undefined;
	for (const line of makefile.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
		if (line.startsWith("\t")) {
			const command = line.replace(/^\t[@+\-\s]*/, "").replace(/\$[({]MAKE[)}]/g, "make").replace(/\$\$/g, "$").trim();
			if (command && !command.startsWith("#")) for (const target of open) rules.get(target)?.recipe.push(command);
			continue;
		}
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		const header = /^([^\s#:=][^:=#]*):(?![=:])([^=]*)$/.exec(line);
		open = [];
		if (!header) continue;
		const [needs, inline = ""] = header[2].split(/;(.*)/s);
		for (const target of header[1].trim().split(/\s+/)) {
			if (!rules.has(target)) rules.set(target, { needs: [], recipe: [] });
			const entry = rules.get(target)!;
			entry.needs.push(...needs.replace("|", " ").trim().split(/\s+/).filter(Boolean));
			if (inline.trim()) entry.recipe.push(inline.trim());
			if (!target.startsWith(".")) first ??= target;
			open.push(target);
		}
	}
	const out: { target: string; line: string }[] = [], seen = new Set<string>();
	const queue = targets.length ? [...targets] : first ? [first] : [];
	while (queue.length && seen.size < limit) {
		const target = queue.shift()!;
		if (seen.has(target)) continue;
		seen.add(target);
		const entry = rules.get(target);
		if (!entry) continue;
		queue.push(...entry.needs);
		for (const line of entry.recipe) out.push({ target, line });
	}
	return out;
}

const DOWNLOADERS = new Set(["curl", "wget", "aria2c", "http", "https", "xh"]);
const INTERPRETER = /^(?:sh|bash|zsh|dash|ksh|fish|python[\d.]*|node|deno|bun|perl|ruby|php)$/;
const SHELL = /^(?:sh|bash|zsh|dash|ksh)$/;
/** Options after which an interpreter still reads its program from stdin. */
const STDIN_PROGRAM = (name: string, args: readonly string[]) => {
	const list = words(args);
	if (/^(?:sh|bash|zsh|dash|ksh|fish)$/.test(name)) return !cluster(args, "c") && (cluster(args, "s") || !list.length || list[0] === "-");
	return !any(args, "-c", "-e", "-m", "--eval", "-r") && (!list.length || list[0] === "-");
};
const sourceHost = (values: Operands) => {
	for (const value of values) {
		const match = /^[a-z][a-z0-9+.-]*:\/\/([^/\s?#@]*@)?(\[[^\]\s]+\]|[^/\s?#:]+)/i.exec(value ?? "");
		if (match) return match[2].toLowerCase();
	}
};
const remoteCode = (host: string | undefined): Consequence => ({
	kind: "remote-code", needs: "request",
	effect: `downloads a program from ${host ?? "the network"} and runs it at once, before anyone has read it`,
});

export interface ParsedCommand {
	name: string; values: Operands;
	/** The files this command writes through a redirect or as `tee` output, as full paths. */
	writes?: readonly string[];
}
export const isDownloader = (name: string) => DOWNLOADERS.has(name);
export const downloadHost = (values: Operands) => sourceHost(values);
/** A shell started without a script to run reads its program from stdin (`bash < deploy.sh`, `… | sh`). */
export const shellReadsStdin = (name: string, values: Operands) => SHELL.test(name) && STDIN_PROGRAM(name, values.map((value) => value ?? ""));

/** The files a pipeline fills with what it downloads: the downloader's own
 * redirect (`curl … > i.sh`) and what later stages write (`curl … | tee i.sh`). */
export function pipelineDownloads(stages: readonly ParsedCommand[]): { files: string[]; host?: string } {
	const from = stages.findIndex((stage) => DOWNLOADERS.has(stage.name));
	if (from < 0) return { files: [] };
	const host = sourceHost(stages[from].values);
	return { files: stages.slice(from).flatMap((stage) => stage.writes ?? []), ...(host ? { host } : {}) };
}

/** Text a pipeline hands to a shell as its program: `echo 'git push' | sh`. */
export function pipedProgram(stages: readonly ParsedCommand[]): string | undefined {
	for (let at = 1; at < stages.length; at++) {
		const from = stages[at - 1];
		if (!shellReadsStdin(stages[at].name, stages[at].values) || !["echo", "printf"].includes(from.name) || from.values.includes(undefined)) continue;
		return (from.values as string[]).filter((value, index) => index > 0 || !/^-[neE]+$/.test(value)).join(" ");
	}
}

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

/** The files a download command writes, as the command names them, and the
 * host they come from. A later command on the same line that runs one of them
 * runs a download nobody has read (`curl -o i.sh … && sh i.sh`). */
export function downloadedFiles(name: string, values: Operands): { files: string[]; host?: string } {
	if (!DOWNLOADERS.has(name)) return { files: [] };
	const args = values.map((value) => value ?? "");
	const files: string[] = [];
	let toStdout = false;
	const [short, long] = name === "wget" ? ["O", "--output-document"] : name === "aria2c" ? ["o", "--out"] : ["o", "--output"];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const attached = arg.startsWith(`${long}=`) ? arg.slice(long.length + 1) : new RegExp(`^-[A-Za-z]*${short}(.+)$`).exec(arg)?.[1];
		const named = attached ?? (arg === long || new RegExp(`^-[A-Za-z]*${short}$`).test(arg) ? args[i + 1] : undefined);
		if (named === "-") toStdout = true;
		else if (named) files.push(named);
	}
	const fromUrl = args.map((arg) => /^[a-z][a-z0-9+.-]*:\/\/[^?#]*\/([^/?#]+)(?:[?#]|$)/i.exec(arg)?.[1]).find(Boolean);
	const remoteName = name === "curl" ? cluster(args, "O") || any(args, "--remote-name", "--remote-name-all") : !files.length && !toStdout;
	if (remoteName && fromUrl && name !== "http" && name !== "https" && name !== "xh") files.push(fromUrl);
	const host = sourceHost(values);
	return { files, ...(host ? { host } : {}) };
}

/** The file an interpreter is told to run (`bash setup.sh`, `python3 get.py`,
 * `source env.sh`), when it runs a file rather than an inline program. */
export function programFile(name: string, values: Operands): string | undefined {
	const args = values.map((value) => value ?? "");
	if (name === "source" || name === ".") return values[0];
	if (!INTERPRETER.test(name) || programOperands(name, values).length || any(args, "-m")) return;
	const at = wordsAt(args, SHELL.test(name) ? ["-o", "-O", "--rcfile", "--init-file"] : ["-W", "-X", "-r", "--require", "--import", "--loader", "-I"])[0];
	return at === undefined ? undefined : values[at];
}
export const isShell = (name: string) => SHELL.test(name);
export const downloadConsequence = (host: string | undefined): Consequence => remoteCode(host);

/** Tools that only read, so running them as administrator changes nothing. */
// Network, firewall and partition tools are listed because the guard blocks
// their changing forms before this question is reached.
const READS_ONLY = /^(?:cat|ls|head|tail|less|more|grep|egrep|fgrep|rg|find|locate|stat|du|df|id|whoami|groups|journalctl|dmesg|lsblk|lsof|ss|netstat|ps|pgrep|which|whereis|true|test|printenv|lspci|lsusb|lscpu|lsmod|lshw|dmidecode|apt-cache|dpkg-query|uname|uptime|free|nproc|file|readlink|realpath|wc|sha\d+sum|md5sum|tree|getent|sensors|nvidia-smi|blkid|findmnt|ip|iptables|ip6tables|nft|ufw|firewall-cmd|nmcli|ifconfig|fdisk|sfdisk|parted)$/;
const READING_VERBS: Record<string, readonly string[]> = {
	systemctl: ["status", "show", "is-active", "is-enabled", "is-failed", "list-units", "list-unit-files", "list-timers", "list-dependencies", "cat"],
	docker: ["ps", "logs", "inspect", "images", "version", "info", "stats", "top"],
	apt: ["list", "show", "search", "policy"], "apt-get": ["check"], dpkg: ["-l", "-s", "-L", "-S", "--list", "--status", "--listfiles", "--search"],
	snap: ["list", "info", "find"], dnf: ["list", "info", "search"], pacman: ["-Q", "-Qi", "-Ql", "-Ss", "-Si"],
	timedatectl: ["status", "show", "list-timezones", "timesync-status"], hostnamectl: ["status"], mount: [], crontab: ["-l"],
	networkctl: ["status", "list", "lldp"],
};
/** The options that make a reading tool change something. */
const CHANGING_OPTION: Record<string, RegExp> = {
	find: /^-(?:exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/,
	journalctl: /^--(?:vacuum-\w+|rotate|flush|relinquish-var)(?:=|$)/,
	dmesg: /^(?:-[a-zA-Z]*[cCnDE][a-zA-Z]*|--(?:clear|read-clear|console-level|console-off|console-on)(?:=.*)?)$/,
	ss: /^(?:-[a-zA-Z]*K[a-zA-Z]*|--kill)$/,
	ip: /^(?:exec|-b|-batch|-force)$/,
};
const BUILDS = /^(?:bash|sh|dash|zsh|ksh|fish|python[\d.]*|node|deno|bun|npm|npx|pnpm|yarn|pytest|make|cmake|ninja|ctest|cargo|go|pip[\d.]*|gem|perl|ruby|php)$/;

/**
 * A command run as administrator (`sudo`, `doas`, `pkexec`, `su -c`). A
 * script, build or test run that way can change the system far beyond what
 * its arguments show; any other tool changes it for every user. Tools that
 * only read are let through. `invoked` is the executable as written, so a
 * local script (`./setup.sh`) is told apart from a system tool.
 */
export function elevatedConsequence(name: string, values: Operands = [], invoked = name): Consequence | undefined {
	if (!name) return;
	const first = values.find((value) => value !== undefined && value !== "") ?? "";
	// With no operand at all these tools print their state or their help.
	const changes = Object.hasOwn(CHANGING_OPTION, name) && values.some((value) => value === undefined || CHANGING_OPTION[name].test(value));
	if (!changes && (READS_ONLY.test(name) || Object.hasOwn(READING_VERBS, name) && (first === "" || READING_VERBS[name].includes(first)))) return;
	const local = invoked.includes("/") && !/^\/(?:usr\/)?(?:local\/)?s?bin\//.test(invoked) || /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|php)$/.test(name);
	return {
		kind: "privilege", needs: "request",
		effect: local || BUILDS.test(name)
			? `runs "${name}" as administrator; a script, build or test run this way can change the system far beyond what its arguments show`
			: `runs "${name}" as administrator, which changes this machine for every user and program on it`,
	};
}
