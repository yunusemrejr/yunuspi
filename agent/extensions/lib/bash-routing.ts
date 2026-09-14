/**
 * Bash routing classifier — pure, I/O-free policy for the bash-router hook.
 *
 * Goal: route common *simple* shell forms to the structured tools that already
 * exist (read/grep/find) or that ship with this change (data_query/git_info/
 * http_request), so small models avoid quoting, escaping and flag recall.
 *
 * Safety contract:
 *  - Only single, simple commands are classified. Anything with an unquoted
 *    operator (| & ; < > ` $ ( )) or a newline is left to bash untouched.
 *  - Heredocs and redirect writes are matched only for a short advisory hint.
 *  - `escalate` rules may become a block on repeat (owned by bash-router.ts);
 *    `annotate` rules only add a one-line hint to the tool result.
 *  - Replacement strings are literal, copyable tool calls; they never contain
 *    shell syntax and never echo credentials.
 */

export type BashRoute = {
  /** Stable id used for escalation counting and telemetry. */
  ruleId: string;
  /** Suggested structured tool; must be an actual active tool name. */
  tool: string;
  /** escalate = may block on repeat; annotate = hint only, never blocks. */
  severity: "escalate" | "annotate";
  /** One short line appended to the bash result. Names the tool explicitly. */
  hint: string;
  /** Literal replacement tool call shown in a block reason. */
  replacement?: string;
};

const METACHARS = "|&;<>()`$";

/** True when the command is a single simple command with no unquoted operators. */
export function isSimpleCommand(command: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === "\\" && quote !== "'") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "\\") { i++; continue; }
    if (METACHARS.includes(c) || c === "\n" || c === "\r") return false;
  }
  return quote === null;
}

/** Tokenize a simple command, honoring quotes. Returns null when not simple. */
export function tokenizeSimple(command: string): string[] | null {
  if (!isSimpleCommand(command)) return null;
  const tokens: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let started = false;
  const push = () => { if (started) { tokens.push(cur); cur = ""; started = false; } };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === "\\" && quote !== "'") { i++; if (i < command.length) cur += command[i]; continue; }
      if (c === quote) { quote = null; continue; }
      cur += c; continue;
    }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (c === "\\") { i++; if (i < command.length) { cur += command[i]; started = true; } continue; }
    if (c === " " || c === "\t") { push(); continue; }
    cur += c; started = true;
  }
  push();
  return tokens.length ? tokens : null;
}

/** Literal JSON argument text for a copyable replacement call. */
function call(tool: string, args: Record<string, unknown>): string {
  return `${tool} ${JSON.stringify(args)}`;
}

/** Parse `-n N` / `-N` / `--lines=N` and return {count, rest}. */
function countFlag(tokens: string[], start: number): { count?: number; rest: string[] } {
  const rest: string[] = [];
  let count: number | undefined;
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i];
    if (typeof count === "undefined" && t === "-n" && i + 1 < tokens.length && /^\d+$/.test(tokens[i + 1])) { count = Number(tokens[i + 1]); i++; continue; }
    if (typeof count === "undefined" && /^-\d+$/.test(t)) { count = Number(t.slice(1)); continue; }
    if (typeof count === "undefined" && /^--lines=\d+$/.test(t)) { count = Number(t.split("=")[1]); continue; }
    rest.push(t);
  }
  return { count, rest };
}

const SIMPLE_GREP_FLAG = /^-(?:r|R|i|n|l|w|E|F|h|s|q)+$/;
const SIMPLE_RG_FLAG = /^-(?:n|i|w|E|F|l|h|s|q)+$/;
const SIMPLE_JQ_FLAG = /^-(?:r|c|e|S|M|j|a)+$/;

/** A jq-style filter that maps onto a data_query path: `.a.b[0]`, `.`, `.[2]` */
function toDataPath(filter: string): string | null {
  if (filter === ".") return "";
  let out = "";
  let i = 0;
  if (filter[i] === ".") i++;
  while (i < filter.length) {
    const c = filter[i];
    if (c === ".") { out += "."; i++; continue; }
    if (c === "[") {
      const end = filter.indexOf("]", i);
      if (end < 0) return null;
      const inside = filter.slice(i + 1, end);
      if (!/^\d+$/.test(inside)) return null;
      out += `[${inside}]`;
      i = end + 1;
      continue;
    }
    const m = /^[A-Za-z0-9_$-]+/.exec(filter.slice(i));
    if (!m) return null;
    out += m[0];
    i += m[0].length;
    if (i < filter.length && filter[i] !== "." && filter[i] !== "[") return null;
  }
  return out;
}

const REPO_READ_ACTIONS: Record<string, string> = { status: "status", diff: "diff", log: "log", show: "show", branch: "branch" };

/** Classify one bash command. Returns null when bash should run untouched. */
export function classifyBashCommand(command: string): BashRoute | null {
  const raw = command.trim();
  if (!raw || raw.length > 4000) return null;

  // Advisory-only: file content written through a redirect/heredoc.
  if (/^(?:echo|printf|cat|tee)\b[^|;&]*>{1,2}\s*\S+/.test(raw) || /<<-?\s*['"]?[A-Za-z_]/.test(raw)) {
    return {
      ruleId: "write-redirect",
      tool: "write",
      severity: "annotate",
      hint: "Prefer the write/edit tools for file content; they avoid shell quoting and heredoc escaping.",
    };
  }

	const tokens = tokenizeSimple(raw);
	if (!tokens) return null;
	const [head, ...args] = tokens;

  // Utility substitutions stay advisory when the shell flags/output have
  // different semantics. Only an explicit single target becomes a candidate.
  const utility = (ruleId: string, tool: string, hint: string, params?: Record<string, unknown>): BashRoute => ({
    ruleId, tool, severity: "annotate", hint: `Use the ${tool} tool ${hint}.`,
    ...(params ? { replacement: call(tool, params) } : {}),
  });
  if (head === "sqlite3" && args.length === 2 && !args[0].startsWith("-")) {
    const [file, sql] = args;
    if (sql === ".tables") return utility("utility-sqlite", "sqlite_probe", "with action tables for bounded database inspection", { path: file, action: "tables" });
    const schema = /^\.schema(?:\s+([A-Za-z_][A-Za-z0-9_]*))?$/.exec(sql);
    if (schema) return utility("utility-sqlite", "sqlite_probe", "with action schema", { path: file, action: "schema", ...(schema[1] ? { table: schema[1] } : {}) });
    if (/^(?:SELECT|WITH|EXPLAIN|PRAGMA)\b/i.test(sql.trim())) return utility("utility-sqlite", "sqlite_probe", "with action query or explain for read-only SQL and bounded rows");
  }
  const packageName = /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9_][A-Za-z0-9._-]*$/;
  if (["npm", "pnpm", "yarn"].includes(head) && ["ls", "list", "explain", "why"].includes(args[0]) && args.length >= 2 && packageName.test(args[1]) && args.slice(2).every(a => /^(?:--json|--depth=\d+)$/.test(a)))
    return utility("utility-package", "package_probe", "for the installed version, exact location and lock resolution", { package: args[1] });
  if (head === "cat" && args.length === 1) {
    const pkg = /^(.*?)(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/.exec(args[0]);
    if (pkg && packageName.test(pkg[2])) return utility("utility-package", "package_probe", "for installed dependency metadata", { package: pkg[2], project: pkg[1].replace(/\/$/, "") || "." });
    if (/(?:^|\/)(?:openapi|swagger)(?:\.[^/]+)?\.(?:json|ya?ml)$/i.test(args[0]))
      return utility("utility-openapi", "openapi_probe", "to select endpoints and request/response shapes", { path: args[0], action: "list_endpoints" });
  }
  if (head === "node" && args.length === 2 && ["-p", "--print"].includes(args[0])) {
    const pkg = /^require\(['"]((?:@[^/'"]+\/)?[^/'"]+)\/package\.json['"]\)(?:\.(?:version|exports|types|bin|peerDependencies))?$/.exec(args[1]);
    if (pkg && packageName.test(pkg[1])) return utility("utility-package", "package_probe", "for installed dependency metadata", { package: pkg[1] });
  }
  if (head === "dig") {
    const parts = args.filter(a => a !== "+short");
    if (parts.length >= 1 && parts.length <= 2 && /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(parts[0]) && (parts.length === 1 || /^(?:A|AAAA|CNAME|MX|TXT|NS|SOA|SRV|CAA)$/.test(parts[1])))
      return utility("utility-dns", "net_probe", "with action dns", { action: "dns", host: parts[0], ...(parts[1] ? { record_type: parts[1] } : {}) });
  }
  if (["nc", "netcat"].includes(head) && ["-z", "-zv", "-vz"].includes(args[0]) && args.length === 3 && /^\d+$/.test(args[2]) && +args[2] >= 1 && +args[2] <= 65535 && !args[1].startsWith("-"))
    return utility("utility-tcp", "net_probe", "with action tcp for a single bounded connection", { action: "tcp", host: args[1], port: +args[2] });
  if (head === "openssl" && args[0] === "s_client" && args[1] === "-connect" && (args.length === 3 || args.length === 5 && args[3] === "-servername")) {
    const target = /^(?:\[([0-9a-f:]+)\]|([A-Za-z0-9.-]+)):(\d+)$/i.exec(args[2]);
    if (target && +target[3] >= 1 && +target[3] <= 65535) return utility("utility-tls", "net_probe", "with action tls for certificate and validation details", { action: "tls", host: target[1] ?? target[2], port: +target[3], ...(args[4] ? { servername: args[4] } : {}) });
  }
  if (head === "unzip" && args.length === 2 && args[0] === "-l" || head === "tar" && args.length === 2 && /^-?(?:t[zgJj]?f|[zgJj]tf)$/.test(args[0]))
    return utility("utility-archive", "archive_probe", "to list archive members without extraction", { action: "list", path: args[1] });
  if (head === "diff" && args.length === 2 && args.every(a => !a.startsWith("-") && /\.(?:json|ya?ml)$/i.test(a)))
    return utility("utility-contract", "contract_diff", "when comparing data-contract structure instead of scalar or formatting differences", { before: args[0], after: args[1] });
  if (head === "lcov" && args.length === 2 && args[0] === "--summary")
    return utility("utility-coverage", "coverage_probe", "with explicit artifact and source-file paths for coverage and changed-line intersections");

	// Read-only system inspection has a structured replacement. Keep these
	// advisory because flags such as `ps aux` and `ss -ltnp` do not have a
	// byte-for-byte equivalent in sys_probe; the native rows are still easier
	// for an agent to consume than reparsing shell columns.
	if (head === "ps" && (args.length === 0 || (args.length === 1 && /^(?:aux|-?ef|-?eF|-e|-f)$/.test(args[0])))) {
		return {
			ruleId: "sys-ps",
			tool: "sys_probe",
			severity: "annotate",
			hint: "Use the sys_probe tool with action `processes` for bounded structured process rows instead of parsing `ps` output.",
		};
	}
	if (head === "ss" && args.length >= 1 && args.length <= 2 && args.some((arg) => /^-[A-Za-z]+$/.test(arg) && arg.includes("l")) && args.every((arg) => /^-[A-Za-z]+$/.test(arg))) {
		return {
			ruleId: "sys-ss",
			tool: "sys_probe",
			severity: "annotate",
			hint: "Use the sys_probe tool with action `listeners` for bounded structured sockets instead of parsing `ss` output.",
		};
	}
	if (head === "systemctl" && args.length >= 1 && args[0] === "list-units" && args.slice(1).every((arg) => /^--(?:type|state)=\S+$/.test(arg) || arg === "--no-pager" || arg === "--no-legend")) {
		return {
			ruleId: "sys-systemctl",
			tool: "sys_probe",
			severity: "annotate",
			hint: "Use the sys_probe tool with action `services` for bounded structured service rows instead of parsing `systemctl` output.",
		};
	}

	if (tokens.length < 2) return null;

  if (head === "cat" && args.length === 1 && !args[0].startsWith("-")) {
    return {
      ruleId: "view-cat",
      tool: "read",
      severity: "escalate",
      hint: "Use the read tool instead of `cat`: bounded, paginated output with line numbers.",
      replacement: call("read", { path: args[0] }),
    };
  }

  if ((head === "head" || head === "tail") && args.length >= 1) {
    const { rest } = countFlag(args, 0);
    if (rest.length === 1 && !rest[0].startsWith("-")) {
      return {
        ruleId: head === "head" ? "view-head" : "view-tail",
        tool: "read",
        severity: "annotate",
        hint: "Use the read tool (offset/limit) for file views instead of shell `head`/`tail`.",
      };
    }
  }

  if (head === "sed" && args[0] === "-n" && args.length === 3) {
    const range = /^(\d+)(?:,(\d+))?p$/.exec(args[1]);
    const file = args[2];
    if (range && !file.startsWith("-")) {
      const from = Number(range[1]);
      const to = range[2] ? Number(range[2]) : from;
      if (to >= from && to - from < 5000) {
        return {
          ruleId: "view-sed",
          tool: "read",
          severity: "escalate",
          hint: "Use the read tool with offset/limit instead of `sed -n`.",
          replacement: call("read", { path: file, offset: from, limit: to - from + 1 }),
        };
      }
    }
  }

  if (head === "grep" && args.length >= 2) {
    let i = 0;
    while (i < args.length && (SIMPLE_GREP_FLAG.test(args[i]) || /^--(?:include|exclude)=.+$/.test(args[i]))) i++;
    if (i + 1 < args.length && !args[i].startsWith("-")) {
      return {
        ruleId: "search-grep",
        tool: "grep",
        severity: "annotate",
        hint: "Use the grep tool for searches: bounded matches and context, no shell quoting.",
      };
    }
  }

  if (head === "rg" && args.length >= 2) {
    let i = 0;
    while (i < args.length && SIMPLE_RG_FLAG.test(args[i])) i++;
    if (i + 1 < args.length && !args[i].startsWith("-")) {
      return {
        ruleId: "search-rg",
        tool: "grep",
        severity: "annotate",
        hint: "Use the grep tool for searches: bounded matches and context, no shell quoting.",
      };
    }
  }

  if (head === "find" && args.length >= 3 && (args.includes("-name") || args.includes("-iname"))) {
    return {
      ruleId: "search-find",
      tool: "find",
      severity: "annotate",
      hint: "Use the find tool for glob searches; the result is bounded and gitignore-aware.",
    };
  }

  if ((head === "jq" || head === "yq") && args.length >= 2) {
    let i = 0;
    while (i < args.length && (SIMPLE_JQ_FLAG.test(args[i]) || args[i] === "--raw-output" || args[i] === "--compact-output")) i++;
    if (i + 1 <= args.length - 1 && !args[i].startsWith("-")) {
      const filter = args[i];
      const file = args[args.length - 1];
      const path = toDataPath(filter);
      if (path !== null && file !== filter && !file.startsWith("-")) {
        return {
          ruleId: "data-jq",
          tool: "data_query",
          severity: "escalate",
          hint: "Use the data_query tool instead of `jq` for JSON/YAML reads.",
          replacement: call("data_query", { op: "get", file, path }),
        };
      }
      return {
        ruleId: "data-jq-complex",
        tool: "data_query",
        severity: "annotate",
        hint: "Use the data_query tool for simple JSON/YAML reads; keep `jq` only for complex transforms.",
      };
    }
  }

  if ((head === "python" || head === "python3") && args.includes("-c") && /\bjson\b/.test(raw)) {
    return {
      ruleId: "data-pyjson",
      tool: "data_query",
      severity: "annotate",
      hint: "Use the data_query tool instead of `python -c` for JSON reads.",
    };
  }

  if (head === "curl" && args.length >= 1) {
    const mutating = args.some((a) => /^-(?:d|F|T|o|O)$/.test(a) || /^--(?:data|form|output|upload-file|request)(?:=|$)/.test(a) || a === "-X");
    const url = [...args].reverse().find((a) => /^https?:\/\//.test(a));
    if (!mutating && url) {
      return {
        ruleId: "net-curl-get",
        tool: "http_request",
        severity: "escalate",
        hint: "Use the http_request tool instead of `curl`: status, headers and bounded body without shell quoting.",
        replacement: call("http_request", { url }),
      };
    }
    return {
      ruleId: "net-curl-other",
      tool: "http_request",
      severity: "annotate",
      hint: "Use the http_request tool for HTTP calls; bodies and headers avoid shell quoting there.",
    };
  }

  if (head === "wget") {
    return {
      ruleId: "net-wget",
      tool: "http_request",
      severity: "annotate",
      hint: "Use fetch_content for readable pages or http_request for raw HTTP instead of `wget`.",
    };
  }

  if (head === "git" && args.length >= 1 && REPO_READ_ACTIONS[args[0]]) {
    const sub = args[0];
    const rest = args.slice(1).filter((a) => a !== "--no-pager" && a !== "--color=never");
    let replacement: string | undefined;
    if (sub === "status") replacement = call("git_info", { action: "status" });
    else if (sub === "diff") {
      const staged = rest.includes("--cached") || rest.includes("--staged");
      replacement = call("git_info", staged ? { action: "diff", staged: true } : { action: "diff" });
    } else if (sub === "log") {
      const { count } = countFlag(rest, 0);
      replacement = call("git_info", { action: "log", ...(count ? { count: Math.min(count, 50) } : {}) });
    } else if (sub === "show") {
      const rev = rest.find((a) => !a.startsWith("-"));
      replacement = call("git_info", { action: "show", ...(rev && !/[<>|;&`$]/.test(rev) ? { revision: rev } : {}) });
    } else if (sub === "branch") replacement = call("git_info", { action: "branch" });
    return {
      ruleId: `git-${sub}`,
      tool: "git_info",
      severity: "escalate",
      hint: "Use the git_info tool for read-only git inspection: compact, bounded, no pager.",
      ...(replacement ? { replacement } : {}),
    };
  }

  if (head === "sleep" && args.length === 1 && /^\d+(?:\.\d+)?$/.test(args[0])) {
    return {
      ruleId: "sleep",
      tool: "wait_for",
      severity: "annotate",
      hint: "For waiting, prefer wait_for with a concrete condition or bg_run/process for long work instead of `sleep`.",
    };
  }

  if (head === "ls" && args.every((a) => !a.startsWith("-"))) {
    return {
      ruleId: "ls",
      tool: "ls",
      severity: "annotate",
      hint: "The ls tool gives a compact directory listing; use it for plain listings.",
    };
  }

  return null;
}

/**
 * Detect a signal tool whose `-f` pattern also matches the invoking shell's own
 * command line. `pkill -f chrome` cannot exclude the `bash -c '...pkill -f
 * chrome...'` process it runs in, so it kills its own shell (observed exit 137).
 * The bracket form `pkill -f '[c]hrome'` keeps the pattern from appearing
 * literally in the command line and is the copyable safe replacement.
 */
export function selfMatchingSignal(command: string): { reason: string; replacement: string } | null {
  if (typeof command !== "string" || !/\b(?:pkill|pgrep)\b/.test(command)) return null;
  const invocations = command.matchAll(/(?:^|[;&|]\s*|\bthen\s+|\bdo\s+)(?:\S*\/)?(pkill|pgrep)\b([^\n;&|]*)/gi);
  for (const match of invocations) {
    const tool = match[1];
    const args = tokenizeSimple(match[2].trim()) ?? match[2].trim().split(/\s+/).filter(Boolean);
    const hasFullMatch = args.some((a) => a === "-f" || /^-[A-Za-z]*f$/.test(a) || a === "--full");
    if (!hasFullMatch) continue;
    const pattern = [...args].reverse().find((a) => !a.startsWith("-"));
    if (!pattern) continue;
    const literal = pattern.replace(/^['"]|['"]$/g, "");
    // A bracket expression (e.g. [c]hrome) does not appear literally, so pkill
    // cannot match the shell command line that contains it. Anything else does.
    if (/\[[^\]]*\]/.test(literal)) continue;
    if (!command.includes(literal)) continue;
    const escaped = literal.length > 0 ? `[${literal[0]}]${literal.slice(1)}` : literal;
    return {
      reason: `\`${tool} -f ${literal}\` also matches this shell's own command line and can terminate the command (exit 137). Use the bracket form so the pattern is not literal in the command line.`,
      replacement: `${tool} -f '${escaped}'`,
    };
  }
  return null;
}
