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
  if (!tokens || tokens.length < 2) return null;
  const [head, ...args] = tokens;

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
