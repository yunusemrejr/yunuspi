/**
 * Bash routing classifier — pure, I/O-free policy for the bash-router hook.
 *
 * Goal: route common *simple* shell forms to the structured tools that already
 * exist (read/grep/find/git_info/http_request), so small models avoid quoting,
 * escaping and flag recall.
 *
 * Safety contract:
 *  - Only single, simple commands are classified. Anything with an unquoted
 *    operator (| & ; < > ` $ ( )) or a newline is left to bash untouched.
 *  - One leading `cd <dir> &&` and/or `timeout <n>` is peeled before
 *    classification, because `cd /tmp && curl …` defeated every rule in a
 *    shell-heavy session; matches on a peeled command are always advisory
 *    (cwd/timeout semantics stay with bash, so they never block).
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
  /** Literal single-file view, for consumers that verify the returned text.
   * Absent for expansions, pipelines and commands with peeled cwd wrappers. */
  readTarget?: { path: string; offset?: number; limit?: number };
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

const REPO_READ_ACTIONS: Record<string, string> = { status: "status", diff: "diff", log: "log", show: "show", branch: "branch" };

/** Peel one leading `cd <dir> &&` or `timeout …` wrapper, if present. */
function peelPrefix(raw: string): { rest: string; peeled: boolean } {
  let rest = raw.trim();
  let peeled = false;
  for (let i = 0; i < 2; i++) {
    const cd = /^(?:cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*&&\s+)([\s\S]+)$/.exec(rest);
    if (cd && cd[1].trim()) { rest = cd[1].trim(); peeled = true; continue; }
    const to = /^(?:timeout\s+(?:-\S+\s+)*\d+(?:\.\d+)?[smhd]?\s+)([\s\S]+)$/.exec(rest);
    if (to && to[1].trim()) { rest = to[1].trim(); peeled = true; continue; }
    break;
  }
  return { rest, peeled };
}

/** Classify one bash command. Returns null when bash should run untouched. */
export function classifyBashCommand(command: string): BashRoute | null {
  const raw = command.trim();
  if (!raw || raw.length > 4000) return null;
  const { rest, peeled } = peelPrefix(raw);
  const match = classifySimple(peeled ? rest : raw);
  if (!match || !peeled) return match;
  // A peeled prefix means the command line carried cwd/timeout context the
  // replacement cannot reproduce: hint only, never a blockable replacement.
  const { replacement: _dropped, readTarget: _readTarget, ...advisory } = match;
  return { ...advisory, severity: "annotate" as const };
}

function classifySimple(raw: string): BashRoute | null {

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

	if (tokens.length < 2) return null;

  if (head === "cat" && args.length === 1 && !args[0].startsWith("-")) {
    return {
      ruleId: "view-cat",
      tool: "read",
      severity: "escalate",
      hint: "Use the read tool instead of `cat`: bounded, paginated output with line numbers.",
      replacement: call("read", { path: args[0] }),
      ...(!/[$`*?\[\]{}~]/.test(args[0]) ? { readTarget: { path: args[0] } } : {}),
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
          ...(from >= 1 && !/[$`*?\[\]{}~]/.test(file) ? { readTarget: { path: file, offset: from, limit: to - from + 1 } } : {}),
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
      tool: "bg_wait",
      severity: "annotate",
      hint: "For waiting, prefer bg_wait on a task started with bg_run (or process for long work) instead of `sleep`.",
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

/** True when a command starts with `cd <dir> &&` and <dir> is the cwd. */
export function redundantCdPrefix(command: string, cwd: string): boolean {
  const match = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/.exec(command);
  if (!match) return false;
  const target = match[1].replace(/^["']|["']$/g, "").replace(/\/+$/, "");
  return target === cwd.replace(/\/+$/, "") || target === ".";
}

/**
 * `curl -s URL | python3 -c "...json.load(sys.stdin)..."` failing with
 * "Expecting value: line 1 column 1" means curl produced no JSON (server not
 * listening yet, HTTP error body, timeout). Name that cause once instead of
 * leaving the agent to debug the Python traceback.
 */
export function emptyJsonPipeHint(command: unknown, content: unknown): string | null {
  if (typeof command !== "string" || !/\bcurl\b[^|]*\|\s*(?:python\d?(?:\.\d+)?\s+-c|jq\b)/.test(command)) return null;
  const text = Array.isArray(content) ? content.map((part: any) => typeof part?.text === "string" ? part.text : "").join("\n") : String(content ?? "");
  if (!/Expecting value: line 1 column 1 \(char 0\)|JSONDecodeError|jq: error \(at <stdin>:0\)|parse error: Invalid numeric literal at line 1, column 1/.test(text)) return null;
  return "curl delivered empty or non-JSON output to the JSON parser (server not ready, HTTP error page, or timeout); the parser traceback is a symptom. Check the endpoint first with `curl -sS --fail-with-body -m 10 -o /tmp/out.json -w '%{http_code}' URL`, wait for readiness, then parse the saved file.";
}

/**
 * Detect a signal tool whose `-f` pattern also matches the invoking shell's own
 * command line. `pkill -f chrome` cannot exclude the `bash -c '...pkill -f
 * chrome...'` process it runs in, so it kills its own shell (observed exit 137).
 * The bracket form `pkill -f '[c]hrome'` keeps the pattern from appearing
 * literally in the command line and is the copyable safe replacement.
 */
export function selfMatchingSignal(command: string): { reason: string; replacement: string; rewritten?: string } | null {
  // Only pgrep: a terminating pkill is blocked by host-operation safety with
  // the owned-task path, so a self-match advisory there is noise.
  if (typeof command !== "string" || !/\bpgrep\b/.test(command)) return null;
  const invocations = command.matchAll(/(?:^|[;&|]\s*|\bthen\s+|\bdo\s+|\$\(\s*)(?:\S*\/)?(pgrep)\b([^\n;&|)]*)/gi);
  for (const match of invocations) {
    const tool = match[1];
    // Redirections are not pgrep arguments; `2>/dev/null` is not a pattern.
    const argText = match[2].replace(/\s*(?:\d|&)?>>?\s*\S+/g, " ").trim();
    const args = tokenizeSimple(argText) ?? argText.split(/\s+/).filter(Boolean);
    const hasFullMatch = args.some((a) => a === "-f" || /^-[A-Za-z]*f$/.test(a) || a === "--full");
    if (!hasFullMatch) continue;
    const pattern = args.findLast((a) => !a.startsWith("-"));
    if (!pattern) continue;
    const literal = pattern.replace(/^['"]|['"]$/g, "");
    // A bracket expression (e.g. [c]hrome) does not appear literally, so pkill
    // cannot match the shell command line that contains it. Anything else does.
    if (/\[[^\]]*\]/.test(literal)) continue;
    if (!command.includes(literal)) continue;
    const escaped = literal.length > 0 ? `[${literal[0]}]${literal.slice(1)}` : literal;
    // The bracket form matches the same processes, so a plain pattern is
    // rewritten in place instead of spending a turn on a refusal. Patterns
    // whose first character is regex syntax or that carry quotes are not.
    const start = match.index! + match[0].length - match[2].length;
    let at = command.indexOf(pattern, start), end = at + pattern.length;
    if (at > 0 && /['"]/.test(command[at - 1]) && command[end] === command[at - 1]) { at--; end++; }
    const rewritten = /^[A-Za-z0-9_]/.test(literal) && !/['"\\$`]/.test(literal)
      && at >= start && end <= start + match[2].length
      ? `${command.slice(0, at)}'${escaped}'${command.slice(end)}` : undefined;
    return {
      reason: `\`${tool} -f ${literal}\` also matches this shell's own command line and can terminate the command (exit 137). Use the bracket form so the pattern is not literal in the command line.`,
      replacement: `${tool} -f '${escaped}'`,
      rewritten,
    };
  }
  return null;
}
