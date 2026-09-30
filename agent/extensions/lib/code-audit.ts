/** Dependency-free, table-driven source audit: security, backend, efficiency,
 * coding patterns and UI-source rules. Pure functions over source text; no
 * project code runs, nothing is installed, no model is called. Every finding is
 * advisory evidence with a line, a severity and a concrete fix. The rules are
 * deliberately high-precision cues that need a human decision, not verdicts:
 * `code_quality` owns duplication, slop, prose and complexity. */
import path from "node:path";
import { codeLexicalMask } from "./code-lexical-mask.ts";
import { collectSources, changedFiles, type SourceFile } from "./code-quality.ts";
import { inspectUiSource } from "./slop-guidance-signals.ts";
import { refineQuality, qualityNeedsContext, qualityExcerpt, protectedQualityText } from "./quality-refinement.ts";

export type Domain = "security" | "backend" | "efficiency" | "patterns" | "ui";
export type Severity = "high" | "medium" | "low";
export const DOMAINS: Domain[] = ["security", "backend", "efficiency", "patterns", "ui"];
export interface AuditFinding { domain: Domain; rule: string; severity: Severity; line: number; message: string; fix: string; excerpt?: string; }

type Lang = "js" | "py" | "go" | "php" | "sh" | "css" | "html" | "markup" | "any";
type Scope = "line" | "statement" | "loop" | "handler" | "async-py";
interface Rule {
  id: string; domain: Domain; severity: Severity; langs: Lang[]; re: RegExp; message: string; fix: string;
  /** line: one row; statement: rows joined to balanced parens; loop/handler/async-py: only rows inside those bodies. */
  scope?: Scope;
  /** Match the lexically masked code (strings and comments blanked, the default for JS) or the raw text. */
  on?: "code" | "raw";
  /** Reject a match when this also matches the statement (or its raw remainder). */
  unless?: RegExp;
  /** Reject when this matches anywhere in the file. */
  fileUnless?: RegExp;
  /** Only when this matches somewhere in the file. */
  fileIf?: RegExp;
  /** Skip files that are tests, fixtures, examples or scripts. Secrets ignore this. */
  live?: boolean;
  /** Custom severity from the matched text. */
  grade?: (match: string, statement: string) => Severity | undefined;
  /** JS only: skip when the body of the block that opens at the match contains this (a try/catch, for example). */
  bodyUnless?: RegExp;
  /** Only rows before the first match of this regex in the file (a script before </head>). */
  before?: RegExp;
  /** The match legitimately begins inside a string literal (credential formats). */
  inside?: boolean;
}

const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec|specs|fixtures?|__fixtures__|examples?|samples?|docs?|benchmarks?|e2e|mocks?|scripts?|bin)\/|[._-](?:test|spec|bench|stories|fixture|example|sample)\.[a-z]+$/i;
const VENDORED = /(?:^|\/)(?:node_modules|vendor|dist|build|coverage|\.git|\.next|target)\/|\.(?:min|generated|bundle)\.[a-z]+$/i;
const PLACEHOLDER = /example|dummy|fake|placeholder|changeme|change[-_]me|your[-_ ]|xxxx|<[^>]+>|\$\{|\{\{|process\.env|os\.environ|getenv|\.\.\.|redacted|sample|test/i;
const DB_RECEIVER = "(?:db|database|prisma|pool|conn|connection|client|knex|sequelize|repo|repository|model|collection|orm|em|supabase|mongo|redis|cursor|cur|session|tx|trx)";
const SQL_WORDS = "\\b(?:select\\s[^;]*?\\sfrom|insert\\s+into|update\\s+\\w+\\s+set|delete\\s+from|drop\\s+table)\\b";
const SECRET_NAMES = "(?:password|passwd|secret|api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|private[_-]?key|cookie|bearer)";
const USER_INPUT_JS = "(?:req|request)\\.(?:params|query|body|headers|cookies)";
const USER_INPUT_PY = "request\\.(?:args|form|json|values|GET|POST|data|files|get_json\\(\\))";
const RANDOM_TARGET = "(?:token|secret|session|nonce|csrf|otp|api_?key|password|salt|reset|verification)";

const RULES: Rule[] = [
  // ───────────────────────────── security ─────────────────────────────
  { id: "hardcoded-provider-key", domain: "security", severity: "high", langs: ["any"], on: "raw", inside: true, unless: /x{6,}|\.{3}|example|your[-_]|<[^>]+>|redacted/i,
    re: /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk_live_[0-9a-zA-Z]{24,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}|AIza[0-9A-Za-z_-]{35}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----)/,
    message: "A credential with a recognizable provider format is committed in source.", fix: "Revoke it now, load it from the environment or a secret manager, and keep the file out of version control." },
  { id: "hardcoded-secret", domain: "security", severity: "medium", langs: ["any"], on: "raw",
    re: new RegExp(`\\b(?:pass(?:word|wd)?|secret|api[_-]?key|access[_-]?key|auth[_-]?token|private[_-]?key|client[_-]?secret)["']?\\s*[:=]\\s*["']([^"'\\s]{14,})["']`, "i"),
    grade: match => { const value = /["']([^"'\s]+)["']$/.exec(match)?.[1] ?? ""; return value.length >= 16 && /[0-9]/.test(value) && /[A-Za-z]/.test(value) && !PLACEHOLDER.test(value) ? "medium" : "low"; },
    unless: /["'](?:https?:|\/|\.\/)/, message: "A literal that looks like a secret is assigned to a credential-named variable.", fix: "Read it from configuration at runtime; keep only a non-secret default or a placeholder in source." },
  { id: "code-execution", domain: "security", severity: "high", langs: ["js"], scope: "statement", re: /\b(?:eval|new\s+Function)\s*\(/,
    message: "eval or new Function executes text as code.", fix: "Parse data with JSON.parse, dispatch through a lookup table, or pass a function instead of a string.", live: true,
    // Strings are blanked in the masked code, so an empty argument list means a literal.
    unless: /\b(?:eval|Function)\s*\(\s*(?:,\s*)*\)/ },
  { id: "code-execution", domain: "security", severity: "high", langs: ["py"], re: /(?<![\w.])(?:eval|exec)\s*\(\s*(?!["'][^"'{%]*["']\s*[,)])/,
    message: "eval or exec runs a non-literal string as code.", fix: "Use ast.literal_eval for data, or a dispatch table for behavior.", live: true },
  { id: "command-injection", domain: "security", severity: "high", langs: ["js"], scope: "statement", on: "raw", live: true,
    // Bare exec()/execSync() or child_process.exec: db.exec and regex.exec are not shells.
    re: /(?:(?<![\w$.])|\b(?:child_process|childProcess|cp)\.)(?:exec|execSync)\s*\(\s*(?:`[^`]*\$\{|["'][^"']*["']\s*\+\s*[A-Za-z_$(]|[A-Za-z_$][\w$.]*\s*\+)|\bspawn(?:Sync)?\s*\([^;]*\bshell\s*:\s*true[^;]*(?:\$\{|\+\s*[A-Za-z_$])/,
    message: "A shell command is built from interpolated or concatenated values.", fix: "Use execFile/spawn with an argument array and no shell so values cannot become shell syntax." },
  { id: "command-injection", domain: "security", severity: "high", langs: ["py"], scope: "statement", on: "raw", live: true,
    re: /\bos\.(?:system|popen)\s*\(\s*(?:f["']|["'][^"']*["']\s*(?:%|\+|\.format)|[A-Za-z_]\w*\s*\+)|\bsubprocess\.\w+\([^)]*shell\s*=\s*True/s,
    unless: /\bsubprocess\.\w+\(\s*["'][^"'{%]*["']\s*,[^)]*shell\s*=\s*True/s,
    message: "A shell command is built from interpolated values or runs with shell=True.", fix: "Pass an argument list to subprocess.run without shell=True; use shlex.quote only when a shell is unavoidable." },
  { id: "sql-injection", domain: "security", severity: "high", langs: ["js"], scope: "statement", on: "raw", live: true,
    re: new RegExp(`\\b(?:query|execute|exec|raw|\\$queryRawUnsafe|\\$executeRawUnsafe|unsafe|prepare)\\s*\\(\\s*(?:\`[^\`]*${SQL_WORDS}[^\`]*\\$\\{|["'][^"'\\n]*${SQL_WORDS}[^"'\\n]*["']\\s*\\+\\s*[A-Za-z_$(])`, "is"),
    grade: (_match, statement) => {
      // Constants, placeholder lists and joined parameterized conditions are the standard safe builders.
      const parts = [...statement.matchAll(/\$\{([^}]*)\}/g)].map(m => m[1]);
      if (parts.length && parts.every(part => /^\s*[A-Z][A-Z0-9_]*\s*$|[pP]laceholders?|["']\?["']|\bjoin\(/.test(part))) return undefined;
      const tainted = /\b(?:req|request|params|query|body|input|user|args|argv|form|payload)\b/;
      // A value spliced after = < > , ( or a quote is the classic injection; a variable in identifier position (FROM ${table}) is medium.
      const inValuePosition = (part: string) => { const at = statement.indexOf("${" + part + "}"); return at > 0 && /(?:[=<>,('"]|\blike|\bin)\s*$/i.test(statement.slice(Math.max(0, at - 12), at)); };
      return (parts.length ? parts.some(part => tainted.test(part) || inValuePosition(part)) : true) ? "high" : "medium";
    },
    message: "SQL text is assembled from interpolated or concatenated values.", fix: "Use placeholders ($1/?/named) with a values array, or the driver's tagged-template form, never string building." },
  { id: "sql-injection", domain: "security", severity: "high", langs: ["py"], scope: "statement", on: "raw", live: true,
    re: new RegExp(`\\.(?:execute|executemany|raw|read_sql(?:_query)?)\\s*\\(\\s*(?:f["'][^"'\\n]*${SQL_WORDS}[^"'\\n]*\\{|["'][^"'\\n]*${SQL_WORDS}[^"'\\n]*["']\\s*(?:%|\\+|\\.format))`, "is"),
    message: "SQL text is assembled with an f-string, % formatting, format() or concatenation.", fix: "Pass parameters as the second argument (cursor.execute(sql, params)) or use the ORM's bound expressions." },
  { id: "sql-injection", domain: "security", severity: "high", langs: ["go"], scope: "statement", on: "raw", live: true,
    re: /\.(?:Query|QueryRow|Exec)(?:Context)?\(\s*(?:[\w.]+,\s*)?(?:fmt\.Sprintf\(|"[^"]*(?:select|insert|update|delete)[^"]*"\s*\+)/i,
    message: "SQL text is built with fmt.Sprintf or concatenation.", fix: "Use $1/? placeholders and pass the values as arguments." },
  { id: "xss-sink", domain: "security", severity: "medium", langs: ["js"], on: "raw", live: true,
    re: /\.(?:innerHTML|outerHTML)\s*\+?=(?!=)\s*(?!\s*(?:'[^'\\]*'|"[^"\\]*"|`[^`$\\]*`)\s*;?\s*$)[^\n]+|\bdocument\.write(?:ln)?\s*\(\s*(?!["'][^"']*["']\s*\))|\binsertAdjacentHTML\s*\(\s*["'][^"']+["']\s*,\s*(?!["'][^"'$]*["']\s*\))/,
    grade: match => /\blocation\b|document\.cookie|\.value\b|\b(?:req|params|searchParams|localStorage|event\.data|message)\b/.test(match) ? "high"
      // A prebuilt template string is usually escaped where it is built; plain interpolation is not.
      : /=\s*[\w$.]*(?:html|markup|template|tpl|rendered)\w*\s*;?\s*$/i.test(match) ? "low" : "medium",
    unless: /\b(?:DOMPurify|sanitize\w*|escapeHtml|escape\w*|purify)\b/,
    message: "A non-literal string reaches an HTML sink.", fix: "Use textContent or DOM construction; if HTML is required, sanitize with a vetted library at this boundary." },
  { id: "xss-sink", domain: "security", severity: "medium", langs: ["markup"], on: "raw", live: true, unless: /\b(?:DOMPurify|sanitize\w*|purify)\b/,
    re: /\bdangerouslySetInnerHTML\b|\bv-html\s*=|\{@html\s/, message: "Raw HTML rendering is enabled for a value.", fix: "Render text by default; sanitize the HTML with a vetted library where rich content is required." },
  { id: "unsafe-deserialization", domain: "security", severity: "medium", langs: ["py"], on: "raw", live: true,
    re: /\b(?:c?[Pp]ickle|dill|marshal|jsonpickle)\.(?:loads?|decode)\(|\byaml\.load\((?![^)]*Loader\s*=\s*(?:yaml\.)?C?Safe)|\bshelve\.open\(/,
    message: "Deserialization that can execute code is used.", fix: "Use json, yaml.safe_load or a schema-validated format for anything not produced by this process." },
  { id: "tls-verification-off", domain: "security", severity: "high", langs: ["js", "py", "go", "php"], on: "raw", live: true,
    re: /\brejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED["']?\s*[\]=:]\s*["']?0|\bverify\s*=\s*False\b|_create_unverified_context|InsecureSkipVerify\s*:\s*true|CURLOPT_SSL_VERIFYPEER\s*,\s*(?:false|0)/,
    message: "TLS certificate verification is disabled.", fix: "Trust the right CA (NODE_EXTRA_CA_CERTS, cafile, cert pool) instead of disabling verification." },
  { id: "weak-randomness", domain: "security", severity: "medium", langs: ["js"], scope: "statement", live: true,
    re: new RegExp(`${RANDOM_TARGET}[^;\\n]{0,80}Math\\.random\\(|Math\\.random\\([^;\\n]{0,80}${RANDOM_TARGET}`, "i"), on: "raw",
    message: "Math.random feeds a token, secret, session or similar value.", fix: "Use crypto.randomUUID(), crypto.randomBytes() or crypto.getRandomValues()." },
  { id: "weak-randomness", domain: "security", severity: "medium", langs: ["py"], live: true, on: "raw",
    re: new RegExp(`${RANDOM_TARGET}[^\\n]{0,80}\\brandom\\.(?:random|randint|choice|choices|randrange|getrandbits)\\(|\\brandom\\.(?:random|randint|choice|choices|randrange|getrandbits)\\([^\\n]{0,80}${RANDOM_TARGET}`, "i"),
    message: "The random module feeds a token, secret or session value.", fix: "Use the secrets module (secrets.token_urlsafe, secrets.choice)." },
  { id: "weak-hash", domain: "security", severity: "medium", langs: ["js", "py", "php", "go"], on: "raw", live: true,
    re: /\b(?:createHash\(\s*["'](?:md5|sha1)["']|hashlib\.(?:md5|sha1)\(|md5\s*\(|sha1\s*\(|crypto\.createCipher\(|md5\.New\(|sha1\.New\()/,
    grade: (match, statement) => /createCipher/.test(match) || /pass(?:word|wd)|secret|token/i.test(statement) ? "high" : "low",
    message: "MD5, SHA-1 or createCipher is used; for passwords or signatures it is broken.", fix: "Passwords: argon2/bcrypt/scrypt. Integrity or signing: SHA-256 or better. Cipher: createCipheriv with a random IV and an AEAD mode." },
  { id: "cors-credentials-open", domain: "security", severity: "high", langs: ["js", "py", "go", "php"], scope: "statement", on: "raw", live: true,
    re: /\bcors\s*\(\s*\{[^}]*\borigin\s*:\s*(?:true|["']\*["'])[^}]*\bcredentials\s*:\s*true|\bcors\s*\(\s*\{[^}]*\bcredentials\s*:\s*true[^}]*\borigin\s*:\s*(?:true|["']\*["'])/is,
    message: "CORS reflects or allows every origin while credentials are enabled.", fix: "Allow an explicit origin list; never combine a wildcard or reflected origin with credentials." },
  { id: "cors-credentials-open", domain: "security", severity: "high", langs: ["js", "py", "go", "php"], on: "raw", live: true, fileIf: /Allow-Credentials["']?\s*[,:=]\s*["']?true/i,
    re: /Access-Control-Allow-Origin["']?\s*[,:=]\s*["']?\*/, message: "Access-Control-Allow-Origin is * while the file also enables credentials.", fix: "Echo an allowlisted origin, never a wildcard, when credentials are allowed." },
  { id: "cookie-flags", domain: "security", severity: "medium", langs: ["js", "py", "go", "php"], on: "raw", live: true,
    re: /\bhttpOnly\s*:\s*false|\bsecure\s*:\s*false|SESSION_COOKIE_(?:SECURE|HTTPONLY)\s*=\s*False|\bsameSite\s*:\s*["']none["'](?![^}]*secure\s*:\s*true)/i,
    message: "A cookie is configured without HttpOnly, Secure or a safe SameSite.", fix: "Session cookies: httpOnly true, secure true, sameSite lax or strict." },
  { id: "jwt-misuse", domain: "security", severity: "high", langs: ["js", "py", "go", "php"], on: "raw", live: true,
    re: /\balgorithms?\s*:\s*\[[^\]]*["']none["']|\bignoreExpiration\s*:\s*true|verify_signature["']?\s*:\s*False|\bverify_exp["']?\s*:\s*False/i,
    message: "JWT verification accepts unsigned tokens or ignores signature or expiry.", fix: "Pin the algorithm list to the one you sign with and verify signature and expiry." },
  { id: "debug-enabled", domain: "security", severity: "medium", langs: ["py"], on: "raw", live: true,
    re: /\.run\([^)]*\bdebug\s*=\s*True|^\s*DEBUG\s*=\s*True\b/m,
    message: "Debug mode is hard-coded on; it exposes an interactive console and stack traces.", fix: "Read DEBUG from the environment and default to false in production." },
  { id: "path-traversal", domain: "security", severity: "high", langs: ["js"], scope: "statement", on: "raw", live: true,
    re: new RegExp(`\\b(?:readFile|readFileSync|createReadStream|writeFile|writeFileSync|sendFile|unlink|unlinkSync|rm|rmSync|readdir|readdirSync|stat|access)\\s*\\([^;]*\\b${USER_INPUT_JS}`),
    unless: /\b(?:basename|resolve)\s*\(/, message: "A request value flows into a filesystem path.", fix: "Resolve against a fixed base, reject results outside it, or map an id to a path via an allowlist." },
  { id: "path-traversal", domain: "security", severity: "high", langs: ["py"], scope: "statement", on: "raw", live: true,
    re: new RegExp(`\\b(?:open|send_file|send_from_directory|os\\.path\\.join|Path)\\s*\\([^)]*\\b${USER_INPUT_PY}`), unless: /secure_filename|basename/,
    message: "A request value flows into a filesystem path.", fix: "Use secure_filename or resolve against a fixed base and reject paths that escape it." },
  { id: "open-redirect", domain: "security", severity: "medium", langs: ["js", "py"], on: "raw", live: true,
    re: new RegExp(`\\bres\\.redirect\\(\\s*${USER_INPUT_JS}|\\bredirect\\(\\s*${USER_INPUT_PY}`),
    message: "A request value chooses the redirect target.", fix: "Redirect only to relative paths or an allowlist of hosts." },
  { id: "ssrf", domain: "security", severity: "medium", langs: ["js", "py"], on: "raw", live: true,
    re: new RegExp(`\\b(?:fetch|axios(?:\\.\\w+)?|got|request|https?\\.get|urlopen|requests\\.\\w+|httpx\\.\\w+)\\(\\s*${USER_INPUT_JS.replace("(?:req|request)", "(?:req|request)")}|\\b(?:urlopen|requests\\.\\w+|httpx\\.\\w+)\\(\\s*${USER_INPUT_PY}`),
    message: "A request value chooses the URL the server fetches.", fix: "Allowlist hosts, block private and link-local ranges, and do not follow redirects blindly." },
  { id: "pipe-to-shell", domain: "security", severity: "medium", langs: ["sh"], on: "raw", live: true, re: /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b|\bchmod\s+(?:-R\s+)?0?777\b/,
    message: "A script pipes a download into a shell or grants world-writable permissions.", fix: "Download, verify a checksum or signature, then run; use the least permissive mode." },
  { id: "eval-shell", domain: "security", severity: "medium", langs: ["sh"], on: "raw", live: true, re: /\beval\s+["']?\$/, message: "eval of a variable in shell.", fix: "Avoid eval; use arrays and explicit commands." },

  // ───────────────────────────── backend ─────────────────────────────
  { id: "mass-assignment", domain: "backend", severity: "medium", langs: ["js"], scope: "statement", on: "raw", live: true,
    re: /\b(?:create|insert|insertOne|insertMany|update|updateOne|updateMany|findByIdAndUpdate|findOneAndUpdate|save|set|build|upsert)\s*\(\s*(?:[^()]*,\s*)?(?:\{\s*\.\.\.\s*)?(?:req|request)\.body\s*[,)}]|\bnew\s+[A-Z]\w*\s*\(\s*(?:req|request)\.body\s*\)|Object\.assign\(\s*[\w.]+\s*,\s*(?:req|request)\.body\s*[,)]/,
    message: "The whole request body is written to a model.", fix: "Validate with a schema and pick the allowed fields explicitly so clients cannot set role, ownerId or other protected columns." },
  { id: "mass-assignment", domain: "backend", severity: "medium", langs: ["py"], on: "raw", live: true,
    re: /\*\*\s*request\.(?:json|form|data|get_json\(\)|POST)\b|\.update\(\s*request\.(?:json|form|data|POST)\b/,
    message: "The whole request payload is expanded into a model or dict.", fix: "Validate with a schema (pydantic, marshmallow, a form) and pass only the allowed fields." },
  { id: "error-detail-leak", domain: "backend", severity: "medium", langs: ["js"], scope: "statement", on: "raw", live: true,
    re: /\bres\.(?:status\(\s*\d+\s*\)\.)?(?:send|json)\(\s*(?:[^;]*\b(?:err|error|e)\.stack\b|(?:err|error|e)\s*\)|\{\s*(?:error|message|stack)\s*:\s*(?:err|error|e)\.stack)/,
    message: "An error or stack trace is sent to the client.", fix: "Log the error server-side with a request id and return a generic message and the id." },
  { id: "error-detail-leak", domain: "backend", severity: "medium", langs: ["py"], on: "raw", live: true,
    re: /\breturn\b[^\n]*(?:traceback\.format_exc\(\)|str\(\s*(?:e|err|exc|error)\s*\))/, message: "An exception message or traceback is returned to the client.", fix: "Log it server-side and return a generic error with a correlation id." },
  { id: "secret-in-log", domain: "backend", severity: "medium", langs: ["js"], live: true,
    re: new RegExp(`\\b(?:console|logger|log|winston|pino)\\.?\\w*\\s*\\([^)]*\\b${SECRET_NAMES}\\b`, "i"),
    message: "A credential-named value is passed to a log call.", fix: "Log an identifier, never the credential; add a redaction list to the logger." },
  { id: "secret-in-log", domain: "backend", severity: "medium", langs: ["py"], on: "raw", live: true,
    re: new RegExp(`\\b(?:print|logging\\.\\w+|logger\\.\\w+|log\\.\\w+)\\([^)]*(?:\\{[^}]*\\b${SECRET_NAMES}\\b[^}]*\\}|%s[^)]*,\\s*\\w*\\b${SECRET_NAMES}\\b)`, "i"),
    message: "A credential-named value is formatted into a log line.", fix: "Log an identifier, never the credential." },
  { id: "missing-timeout", domain: "backend", severity: "medium", langs: ["py"], scope: "statement", on: "raw", live: true,
    re: /\b(?:requests\.(?:get|post|put|patch|delete|head|request)|urllib\.request\.urlopen|urlopen|httpx\.(?:get|post|put|patch|delete))\s*\(/, unless: /\btimeout\s*=/,
    message: "An outbound HTTP call has no timeout and can hang a worker forever.", fix: "Pass timeout=(connect, read), for example timeout=(3.05, 10), or configure a session default." },
  { id: "missing-timeout", domain: "backend", severity: "medium", langs: ["go"], on: "raw", live: true,
    re: /\bhttp\.(?:Get|Post|PostForm|Head)\(|\bhttp\.Client\{\s*\}|\bhttp\.ListenAndServe\(/,
    message: "The default HTTP client or server has no timeouts.", fix: "Use &http.Client{Timeout: ...} and an http.Server with Read/Write/Idle timeouts." },
  { id: "missing-timeout", domain: "backend", severity: "low", langs: ["js"], scope: "statement", on: "raw", live: true,
    re: /\baxios(?:\.(?:get|post|put|patch|delete|request|create))?\s*\(/, unless: /\btimeout\s*:/, fileUnless: /\btimeout\s*:|defaults\.timeout/,
    message: "An axios client has no timeout anywhere in this file; the default is unlimited.", fix: "Set timeout on the instance or per call, and abort on shutdown with a signal." },
  { id: "unbounded-body", domain: "backend", severity: "medium", langs: ["go"], on: "raw", live: true, re: /\b(?:ioutil|io)\.ReadAll\(\s*r(?:eq)?\.Body\s*\)/, fileUnless: /MaxBytesReader/,
    message: "The whole request body is read without a size limit.", fix: "Wrap it with http.MaxBytesReader(w, r.Body, limit)." },
  { id: "async-route-unhandled", domain: "backend", severity: "medium", langs: ["js"], on: "code", live: true, scope: "line",
    fileIf: /(?:from\s+["']express["']|require\(\s*["']express["']\s*\))/, fileUnless: /express-async-errors|express-async-handler|asyncHandler|catchAsync|wrapAsync|["']express["']\s*:\s*["']\^?5/,
    re: /\.(?:get|post|put|patch|delete|all)\s*\([^)]*\basync\b[^{]*\{/, bodyUnless: /\btry\b|\.catch\s*\(|\bnext\s*\(/,
    message: "An async Express handler has no try/catch; Express 4 does not forward its rejection, so the request hangs.", fix: "Wrap the handler (asyncHandler), catch and call next(err), or upgrade to Express 5." },
  { id: "sync-io-in-handler", domain: "backend", severity: "medium", langs: ["js"], scope: "handler", live: true, fileIf: /\b(?:express|fastify|koa|hono|restify|hapi|elysia|createServer|@nestjs|next\/server|NextResponse)\b/,
    re: /\b(?:readFileSync|writeFileSync|appendFileSync|readdirSync|statSync|existsSync|mkdirSync|copyFileSync|execSync|spawnSync|pbkdf2Sync|scryptSync|randomFillSync|gzipSync|gunzipSync|deflateSync|inflateSync|brotliCompressSync|hashSync|compareSync)\s*\(/,
    message: "A synchronous call blocks the event loop inside a request handler.", fix: "Use the promise API (fs/promises, async crypto/zlib) so other requests keep running." },
  { id: "blocking-in-async", domain: "backend", severity: "medium", langs: ["py"], scope: "async-py", live: true,
    re: /\btime\.sleep\(|\brequests\.(?:get|post|put|patch|delete|head|request)\(|\bsubprocess\.(?:run|call|check_output|check_call)\(|\burllib\.request\.urlopen\(/,
    message: "A blocking call runs inside an async function and stalls the event loop.", fix: "Use await asyncio.sleep, httpx.AsyncClient/aiohttp, asyncio.create_subprocess_exec, or run_in_executor." },
  { id: "connection-per-request", domain: "backend", severity: "medium", langs: ["js"], scope: "handler", live: true, fileIf: /\b(?:express|fastify|koa|hono|restify|hapi|elysia|createServer|@nestjs|next\/server|NextResponse)\b/,
    re: /\bnew\s+(?:Pool|PrismaClient|Redis|MongoClient|Client)\s*\(|\b(?:createConnection|createPool|MongoClient\.connect|mysql\.createConnection)\s*\(/,
    message: "A database client is created inside a request handler and leaks connections under load.", fix: "Create the pool or client once at module scope and reuse it." },
  { id: "query-in-loop", domain: "backend", severity: "medium", langs: ["js"], scope: "loop", live: true,
    re: /\bawait\s+(?:[\w$]+\.)*(?:(?:db|database|prisma|pool|conn|connection|knex|sequelize|orm|supabase|mongo|redis|cursor|tx|trx)|[\w$]*(?:Repository|Repo|Model|Collection|Db|DB|Pool|Client))[\w$]*\.\w+\s*\(|\bawait\s+[\w$.]+\.(?:findOne|findUnique|findFirst|findById|findByPk|findMany|findAll|insertOne|updateOne|deleteOne|query|execute)\s*\(/,
    message: "A database call runs once per loop iteration (N+1).", fix: "Batch it: one query with IN/ANY, a JOIN, findMany({ where: { id: { in } } }), or a bulk insert." },
  { id: "query-in-loop", domain: "backend", severity: "medium", langs: ["py"], scope: "loop", live: true,
    re: /\b(?:cursor|cur|conn|connection|db|session)\.(?:execute|query|get|add|scalar)\(|\.objects\.(?:get|filter|create|exclude)\(|\bsession\.query\(/,
    message: "A database call runs once per loop iteration (N+1).", fix: "Batch it: select_related/prefetch_related, an IN clause, executemany or bulk_create." },
  { id: "defer-in-loop", domain: "backend", severity: "medium", langs: ["go"], scope: "loop", live: true, re: /^\s*defer\s/, message: "defer inside a loop holds every resource until the function returns.", fix: "Move the body into a function so each iteration's defer runs, or close explicitly." },

  // ───────────────────────────── efficiency ─────────────────────────────
  { id: "reduce-spread", domain: "efficiency", severity: "medium", langs: ["js"], scope: "statement", on: "code", live: true,
    re: /\.reduce\(\s*(?:async\s*)?\(\s*(\w+)[^)]*\)\s*=>\s*(?:\(\s*)?(?:\{\s*\.\.\.\s*\1\b|\[\s*\.\.\.\s*\1\b)/,
    message: "reduce copies the accumulator with spread on every step, which is O(n²).", fix: "Mutate a local accumulator, use Object.fromEntries/Map, or push to an array." },
  { id: "regexp-in-loop", domain: "efficiency", severity: "low", langs: ["js"], scope: "loop", on: "raw", re: /\bnew\s+RegExp\(\s*(["'])[^"']*\1\s*[,)]/, live: true,
    message: "A constant regular expression is rebuilt every iteration.", fix: "Hoist it to a module-level constant." },
  { id: "sync-io-in-loop", domain: "efficiency", severity: "low", langs: ["js"], scope: "loop", re: /\b(?:readFileSync|existsSync|statSync|readdirSync|execSync|spawnSync)\s*\(/, live: true,
    message: "Synchronous file or process work repeats inside a loop.", fix: "Read once outside the loop, or use async I/O with bounded concurrency." },
  { id: "passive-listener", domain: "efficiency", severity: "low", langs: ["js"], scope: "statement", on: "raw", live: true,
    re: /\baddEventListener\(\s*["'](?:scroll|wheel|mousewheel|touchstart|touchmove)["']\s*,[^;]*\)/, unless: /\bpassive\s*:/,
    message: "A scroll or touch listener is not marked passive and can delay scrolling.", fix: "Pass { passive: true } unless the handler calls preventDefault." },
  { id: "pandas-iterrows", domain: "efficiency", severity: "low", langs: ["py"], on: "raw", live: true, re: /\.iterrows\(\)|\.apply\([^)]*axis\s*=\s*1/,
    message: "Row-wise pandas iteration is orders of magnitude slower than vectorized code.", fix: "Use vectorized column operations, merge, groupby or numpy." },
  { id: "transition-all", domain: "efficiency", severity: "low", langs: ["css"], on: "raw", re: /\btransition\s*:\s*all\b/, live: true,
    message: "transition: all animates every property, including layout-triggering ones.", fix: "List the properties (opacity, transform, color) that actually change." },
  { id: "css-import", domain: "efficiency", severity: "low", langs: ["css"], on: "raw", re: /^\s*@import\s+(?:url\()?["']?(?:https?:)?\/\//m, live: true,
    message: "A remote @import serializes the download and blocks rendering.", fix: "Use a <link rel=\"preload\"> or self-host and bundle the stylesheet." },
  { id: "blocking-script", domain: "efficiency", severity: "medium", langs: ["html"], on: "raw", live: true, scope: "statement", before: /<\/head>/i,
    re: /<script\b(?![^>]*\b(?:defer|async|type\s*=\s*["']module["']|nomodule)\b)[^>]*\bsrc\s*=[^>]*>/i,
    message: "A synchronous external script blocks parsing.", fix: "Add defer (order-preserving) or type=\"module\"; async for independent scripts." },

  // ───────────────────────────── patterns ─────────────────────────────
  { id: "throw-string", domain: "patterns", severity: "medium", langs: ["js"], on: "raw", re: /\bthrow\s+["'`]/, live: false,
    message: "A string or number is thrown; it has no stack trace and breaks instanceof checks.", fix: "throw new Error(message) (or a typed subclass with a cause)." },
  { id: "mutable-default", domain: "patterns", severity: "medium", langs: ["py"], on: "raw", re: /\bdef\s+\w+\([^)]*=\s*(?:\[\]|\{\}|set\(\)|dict\(\)|list\(\))/, live: false,
    message: "A mutable default argument is shared across every call.", fix: "Default to None and create the object inside the function." },
  { id: "bare-except", domain: "patterns", severity: "medium", langs: ["py"], on: "raw", re: /^\s*except\s*:/m, live: false,
    message: "A bare except also catches KeyboardInterrupt and SystemExit.", fix: "Catch the specific exceptions you can handle, or Exception at a boundary." },
  { id: "is-literal", domain: "patterns", severity: "medium", langs: ["py"], on: "raw", re: /\bis\s+(?:not\s+)?(?:["'](?!\s*["'])|\d)/, live: false,
    message: "is compares identity, not value, for a literal.", fix: "Use == / != for values; reserve is for None, True, False." },
  { id: "open-without-with", domain: "patterns", severity: "low", langs: ["py"], on: "raw", re: /^\s*\w+\s*=\s*open\(/m, live: false, message: "A file is opened without a context manager and leaks on error.", fix: "with open(...) as f:" },
  { id: "promise-constructor", domain: "patterns", severity: "low", langs: ["js"], scope: "statement", on: "code", live: false, re: /\bnew\s+Promise\s*\([^)]*\)\s*(?:=>)?\s*\{[^}]*\.then\s*\(/s,
    message: "A new Promise wraps an existing promise (explicit construction antipattern).", fix: "Return the inner promise, or use async/await." },
  { id: "catch-rethrow", domain: "patterns", severity: "low", langs: ["js"], scope: "statement", on: "code", live: false, re: /\bcatch\s*\(\s*(\w+)\s*\)\s*\{\s*throw\s+\1\s*;?\s*\}/,
    message: "A catch block only rethrows the same error.", fix: "Remove it, or add context (new Error(msg, { cause }))." },
  { id: "json-clone", domain: "patterns", severity: "low", langs: ["js"], on: "code", live: false, re: /JSON\.parse\(\s*JSON\.stringify\(/, message: "JSON round-trip used as a deep clone drops Dates, Maps, undefined and cycles.", fix: "structuredClone(value)." },
  { id: "boolean-trap", domain: "patterns", severity: "low", langs: ["js", "py", "go"], on: "code", live: false, re: /\w\(\s*[^()\n]*\b(?:true|false|True|False)\s*,\s*(?:true|false|True|False)\b/,
    message: "Adjacent boolean literals in a call are unreadable at the call site.", fix: "Use an options object or named arguments." },
  { id: "nested-ternary", domain: "patterns", severity: "low", langs: ["js"], on: "code", live: false, re: /\?[^:?\n]*\?[^:\n]*:[^:\n]*:/, message: "Nested ternaries hide the decision table.", fix: "Use if/else, a lookup object or an early return." },
  { id: "array-index-key", domain: "patterns", severity: "low", langs: ["markup"], on: "raw", live: false, re: /\bkey=\{\s*(?:i|idx|index)\s*\}/,
    message: "An array index is used as a React key; reordering corrupts state.", fix: "Use a stable id from the data." },
  { id: "var-declaration", domain: "patterns", severity: "low", langs: ["js"], on: "code", live: false, re: /^\s*var\s+\w/m, message: "var is function-scoped and hoisted.", fix: "Use const, or let where reassigned." },
  { id: "shell-no-strict-mode", domain: "patterns", severity: "low", langs: ["sh"], on: "raw", live: false, re: /^#!.*\b(?:ba|z)?sh\b/m, fileUnless: /\bset\s+-[a-z]*e|set\s+-o\s+errexit|set\s+-euo/,
    message: "The script does not stop on errors or unset variables.", fix: "Add set -euo pipefail after the shebang." },

  // ───────────────────────────── ui source ─────────────────────────────
  { id: "img-without-alt", domain: "ui", severity: "medium", langs: ["markup", "html"], scope: "statement", on: "raw", live: true, re: /<img\b(?![^>]*\balt\s*=)(?![^>]*\{\s*\.\.\.)[^>]*>/,
    message: "An image has no alt attribute; screen readers announce the filename.", fix: "alt=\"description\" for content, alt=\"\" for decoration." },
  { id: "zoom-disabled", domain: "ui", severity: "medium", langs: ["html", "markup"], on: "raw", live: true, re: /user-scalable\s*=\s*(?:no|0)|maximum-scale\s*=\s*1(?:\.0)?\b/i,
    message: "The viewport blocks pinch zoom (WCAG 1.4.4).", fix: "Remove user-scalable=no and maximum-scale." },
  { id: "focus-outline-removed", domain: "ui", severity: "medium", langs: ["css"], on: "raw", live: true, re: /\boutline\s*:\s*(?:none|0)\b/, fileUnless: /:focus-visible|:focus-within|focus\s*:\s*ring|box-shadow[^;]*focus/,
    message: "The focus outline is removed and no replacement focus style exists in this file.", fix: "Style :focus-visible with a visible ring instead of removing the outline." },
  { id: "positive-tabindex", domain: "ui", severity: "medium", langs: ["html", "markup"], on: "raw", live: true, re: /\btabindex\s*=\s*["'{]?\s*[1-9]/i,
    message: "A positive tabindex overrides the natural focus order.", fix: "Use tabindex=0 or -1 and fix the DOM order." },
  { id: "click-on-non-interactive", domain: "ui", severity: "medium", langs: ["html", "markup"], scope: "statement", on: "raw", live: true,
    re: /<(?:div|span|li|p|img)\b(?=[^>]*\bon[Cc]lick\s*=)(?![^>]*\brole\s*=)[^>]*>/, message: "A click handler sits on a non-interactive element: no keyboard access or role.", fix: "Use <button> (or <a href>); otherwise add role, tabindex=0 and key handlers." },
  { id: "html-without-lang", domain: "ui", severity: "medium", langs: ["html"], on: "raw", live: true, re: /<html\b(?![^>]*\blang\s*=)[^>]*>/i, message: "The root element has no lang attribute.", fix: "<html lang=\"en\"> (or the page language)." },
  { id: "missing-viewport", domain: "ui", severity: "medium", langs: ["html"], on: "raw", live: true, re: /<head\b/i, fileUnless: /name\s*=\s*["']viewport["']|<\?php|\{\{|\{%|<%/,
    message: "A complete HTML document has no viewport meta; mobile browsers render at desktop width.", fix: "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" },
  { id: "autoplay-with-sound", domain: "ui", severity: "medium", langs: ["html", "markup"], scope: "statement", on: "raw", live: true, re: /<(?:video|audio)\b(?=[^>]*\bautoplay\b)(?![^>]*\bmuted\b)[^>]*>/i,
    message: "Media autoplays with sound; browsers block it and it is hostile to users.", fix: "Add muted (and playsinline) for background video, or wait for a user gesture." },
  { id: "tiny-text", domain: "ui", severity: "medium", langs: ["css", "html", "markup"], on: "raw", live: true, re: /\bfont-size\s*:\s*(?:[0-9]|1[01])(?:\.\d+)?px\b/, grade: match => /:\s*(?:1[01])(?:\.\d+)?px/.test(match) ? "low" : "medium",
    message: "Text under 12px is hard to read (under 10px fails most accessibility reviews).", fix: "Use at least 12px for captions and 16px for body copy; size in rem." },
  { id: "viewport-height", domain: "ui", severity: "low", langs: ["css"], on: "raw", live: true, re: /\bheight\s*:\s*100vh\b/, message: "100vh overflows behind mobile browser toolbars.", fix: "Use 100dvh (with a 100vh fallback) or min-height." },
  { id: "target-blank-rel", domain: "ui", severity: "low", langs: ["html", "markup"], scope: "statement", on: "raw", live: true, re: /<a\b(?=[^>]*\btarget\s*=\s*["']_blank["'])(?![^>]*\brel\s*=\s*["'{][^"']*noopener)[^>]*>/i,
    message: "target=_blank without rel=noopener gives the new page access to window.opener in older browsers.", fix: "Add rel=\"noopener noreferrer\"." },
];

// ─────────────────────────────── scanning ───────────────────────────────

const JS_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/i;
const CONFIG_FILE = /(?:^|\/)(?:\.env(?:\.[\w.-]+)?|[\w.-]+\.(?:json|ya?ml|toml|ini|cfg|conf|properties|tf|tfvars)|Dockerfile[\w.-]*|\.npmrc)$/i;
const LOCKFILE = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock|go\.sum)$/i;
const langsOf = (file: string): Set<Lang> => {
  const ext = path.extname(file).toLowerCase(), out = new Set<Lang>(["any"]);
  if (JS_FILE.test(file)) out.add("js");
  if (/\.(?:jsx|tsx|vue|svelte)$/.test(ext)) out.add("markup");
  if (ext === ".py") out.add("py");
  if (ext === ".go") out.add("go");
  if (ext === ".php") { out.add("php"); out.add("html"); out.add("markup"); }
  if (/^\.(?:sh|bash|zsh)$/.test(ext)) out.add("sh");
  if (/^\.(?:css|scss|less)$/.test(ext)) out.add("css");
  if (/^\.html?$/.test(ext) || ext === ".vue" || ext === ".svelte") { out.add("html"); out.add("markup"); }
  return out;
};
/** Source and config files the audit reads; vendored, generated and lock files never. */
export const auditable = (file: string) => {
  const normalized = file.replaceAll("\\", "/");
  return !VENDORED.test(normalized) && !LOCKFILE.test(normalized) && (langsOf(normalized).size > 1 || CONFIG_FILE.test(normalized));
};

/** Index of the "}" closing the block whose "{" is at `open` in blanked code. */
function closeBrace(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) { const c = code[i]; if (c === "{") depth++; else if (c === "}" && --depth === 0) return i; }
  return code.length - 1;
}
/** Line ranges (1-based, inclusive) of brace bodies opened by regex matches that end at "{". */
function braceBodies(code: string, opener: RegExp, lineAt: (index: number) => number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of code.matchAll(opener)) { const open = m.index! + m[0].length - 1; out.push([lineAt(open), lineAt(closeBrace(code, open))]); }
  return out;
}
/** Bodies of for/while (balanced header), do and forEach-callback loops in blanked JS/Go code. */
function loopBodies(code: string, lineAt: (index: number) => number, headers: RegExp): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of code.matchAll(headers)) {
    let i = m.index! + m[0].length, depth = 1;
    for (; i < code.length && depth > 0; i++) { if (code[i] === "(") depth++; else if (code[i] === ")") depth--; }
    while (i < code.length && /\s/.test(code[i])) i++;
    if (code[i] === "{") out.push([lineAt(i), lineAt(closeBrace(code, i))]);
  }
  return out;
}
/** Indentation-delimited blocks after header rows (Python). */
function indentBodies(rows: string[], header: RegExp): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < rows.length; i++) {
    if (!header.test(rows[i])) continue;
    const base = /^\s*/.exec(rows[i])![0].length; let end = i;
    for (let j = i + 1; j < rows.length; j++) {
      if (!rows[j].trim()) continue;
      if (/^\s*/.exec(rows[j])![0].length <= base) break;
      end = j;
    }
    if (end > i) out.push([i + 2, end + 1]);
  }
  return out;
}
const within = (ranges: Array<[number, number]>, line: number) => ranges.some(([a, b]) => line >= a && line <= b);
/** Row `from` joined with following rows until brackets balance (bounded). */
function statementAt(rows: string[], from: number): string {
  let depth = 0, text = "";
  for (let i = from; i < Math.min(rows.length, from + 14); i++) {
    text += (i > from ? "\n" : "") + rows[i];
    for (const c of rows[i]) { if (c === "(" || c === "{" || c === "[") depth++; else if (c === ")" || c === "}" || c === "]") depth--; }
    if (depth <= 0) break;
  }
  return text;
}
/** True when `index` of a raw row sits inside a string literal or a trailing comment. */
function inStringOrComment(row: string, index: number, hash: boolean): boolean {
  let quote = "";
  for (let i = 0; i < index; i++) {
    const c = row[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (hash ? c === "#" : c === "/" && row[i + 1] === "/") return true;
  }
  return quote !== "";
}
const rank: Record<Severity, number> = { high: 3, medium: 2, low: 1 };
const COMPILED = new Map<Rule, RegExp>();
const compiled = (rule: Rule) => COMPILED.get(rule) ?? (COMPILED.set(rule, new RegExp(rule.re.source, rule.re.flags.replace(/[gy]/g, ""))), COMPILED.get(rule)!);

/** Audit one file. `lines` limits findings to a changed span; `domains` filters rules. */
export function auditSource(file: string, source: string, options: { domains?: Domain[]; lines?: [number, number]; minSeverity?: Severity } = {}): AuditFinding[] {
  const normalized = file.replaceAll("\\", "/");
  if (source.length > 512 * 1024 || VENDORED.test(normalized) || LOCKFILE.test(normalized)) return [];
  const langs = langsOf(normalized);
  const testish = TEST_PATH.test(normalized) || (source.startsWith("#!") && /\.(?:mjs|cjs|js)$/.test(normalized));
  const wanted = new Set(options.domains ?? DOMAINS), floor = rank[options.minSeverity ?? "low"];
  const rules = RULES.filter(rule => wanted.has(rule.domain) && rule.langs.some(l => langs.has(l)) && !(rule.live && testish));
  if (!rules.length) return [];
  const raw = source.split("\n");
  const js = langs.has("js"), py = langs.has("py"), hash = py || langs.has("sh");
  const maskedText = js ? codeLexicalMask(source).code : source;
  const code = maskedText.split("\n");
  const offsets: number[] = []; { let at = 0; for (const row of raw) { offsets.push(at); at += row.length + 1; } }
  const lineAt = (index: number) => { let lo = 0, hi = offsets.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (offsets[mid] <= index) lo = mid; else hi = mid - 1; } return lo + 1; };
  const spansOf = (kind: Scope): Array<[number, number]> => {
    if (kind === "loop") {
      if (js) return [...loopBodies(maskedText, lineAt, /\b(?:for(?:\s+await)?|while)\s*\(/g), ...braceBodies(maskedText, /\bdo\s*\{|\.forEach\s*\(\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>\s*\{/g, lineAt)];
      if (py) return indentBodies(raw, /^\s*(?:async\s+)?(?:for|while)\b.*:\s*(?:#.*)?$/);
      return langs.has("go") ? braceBodies(source, /\bfor\b[^{\n]*\{/g, lineAt) : [];
    }
    if (kind === "handler") return js ? braceBodies(maskedText, /\(\s*(?:_?req|_?request)\b[^)]*\b(?:res|reply|response|next)\b[^)]*\)\s*(?::\s*[\w<>[\], |]+)?\s*(?:=>)?\s*\{|\.(?:get|post|put|patch|delete|use|all)\s*\((?:[^()]|\([^()]*\))*?(?:async\s*)?\(\s*(?:ctx|c)\b[^)]*\)\s*=>\s*\{/g, lineAt) : [];
    if (kind === "async-py") return py ? indentBodies(raw, /^\s*async\s+def\b.*:\s*(?:#.*)?$/) : [];
    return [];
  };
  const cache = new Map<Scope, Array<[number, number]>>();
  const spans = (kind: Scope) => cache.get(kind) ?? (cache.set(kind, spansOf(kind)), cache.get(kind)!);
  const out: AuditFinding[] = [], perRule = new Map<string, number>();
  const inRange = (line: number) => !options.lines || (line >= options.lines[0] && line <= options.lines[1]);
  const isComment = (i: number) => hash ? /^\s*#/.test(raw[i]) : /^\s*(?:\/\/|\/\*|\*|<!--)/.test(raw[i]);
  for (const rule of rules) {
    const re = compiled(rule), scope = rule.scope ?? "line";
    // Markup and stylesheet rules match attribute values, which are strings by nature.
    const guardStrings = !rule.inside && !rule.langs.every(l => l === "html" || l === "markup" || l === "css");
    const useRaw = rule.on === "raw" || (!js && rule.on !== "code");
    // Cheap whole-file rejection before any per-row work.
    if (!re.test(useRaw ? source : maskedText)) continue;
    if ((rule.fileIf && !rule.fileIf.test(source)) || (rule.fileUnless && rule.fileUnless.test(source))) continue;
    const rows = useRaw ? raw : code;
    const ranges = scope === "loop" || scope === "handler" || scope === "async-py" ? spans(scope) : undefined;
    if (ranges && !ranges.length) continue;
    const stopAt = rule.before ? (() => { const at = source.search(rule.before); return at < 0 ? Infinity : at; })() : Infinity;
    for (let i = 0; i < rows.length && offsets[i] < stopAt; i++) {
      const line = i + 1;
      if (!inRange(line) || (ranges && !within(ranges, line)) || !rows[i].trim() || isComment(i)) continue;
      const text = scope === "statement" ? statementAt(rows, i) : rows[i];
      const match = re.exec(text);
      // Multi-row statements report once, at the row where the match begins.
      if (!match || match.index >= rows[i].length || offsets[i] + match.index >= stopAt) continue;
      if (guardStrings && inStringOrComment(raw[i], match.index, hash)) continue;
      if (rule.unless && rule.unless.test(text)) continue;
      if (rule.bodyUnless) {
        const open = offsets[i] + match.index + match[0].length - 1;
        if (maskedText[open] === "{" && rule.bodyUnless.test(maskedText.slice(open, closeBrace(maskedText, open) + 1))) continue;
      }
      const severity = rule.grade ? rule.grade(match[0], text) : rule.severity;
      if (!severity || rank[severity] < floor) continue;
      const seen = perRule.get(rule.id) ?? 0;
      if (seen >= 6) continue;
      perRule.set(rule.id, seen + 1);
      out.push({ domain: rule.domain, rule: rule.id, severity, line, message: rule.message, fix: rule.fix, excerpt: raw[i].trim().slice(0, 140) });
    }
  }
  const unique = new Map<string, AuditFinding>();
  for (const f of out) unique.set(`${f.rule}:${f.line}`, f);
  return [...unique.values()].sort((a, b) => rank[b.severity] - rank[a.severity] || a.line - b.line).slice(0, 60);
}

/** Whole-file UI source cues (design-slop doctrine) expressed as audit findings. */
export function uiSlopFindings(file: string, source: string, direction?: string): AuditFinding[] {
  try {
    return inspectUiSource(file, source, { direction }).findings.map(f => ({ domain: "ui" as const, rule: f.key, severity: "medium" as const, line: 0, message: f.check.slice(0, 260), fix: "Check supplied direction and complete component; verify by rendering and interaction." }));
  } catch { return []; }
}

export interface AuditReport { domains: Domain[]; scope: { files: number; skipped: number; truncated: boolean }; counts: { total: number; bySeverity: Record<Severity, number>; byRule: Record<string, number> }; findings: Array<AuditFinding & { file: string }>; semantic?: Awaited<ReturnType<typeof refineQuality>>; omitted?: number; note: string; }

/** Run an audit over explicit paths, a directory or the files changed against a revision. */
export async function codeAudit(params: any, cwd: string, signal?: AbortSignal, refinement: { pi?: unknown; judge?: any } = {}): Promise<AuditReport> {
  const domains = (Array.isArray(params.domains) && params.domains.length ? params.domains : DOMAINS).filter((d: string): d is Domain => (DOMAINS as string[]).includes(d));
  if (!domains.length) throw new Error(`domains must be from ${DOMAINS.join(", ")}`);
  const minSeverity: Severity = ["high", "medium", "low"].includes(params.minSeverity) ? params.minSeverity : "low";
  const limit = Math.max(1, Math.min(120, Number.isInteger(params.limit) ? params.limit : 40));
  const inputs: string[] = Array.isArray(params.paths) && params.paths.length ? params.paths.slice(0, 64).map(String) : [];
  const changed = params.changed === true ? await changedFiles(cwd, params.base ?? "HEAD", signal) : undefined;
  if (changed && !inputs.length && !changed.length) return { domains, scope: { files: 0, skipped: 0, truncated: false }, counts: { total: 0, bySeverity: { high: 0, medium: 0, low: 0 }, byRule: {} }, findings: [], note: "No changed files against the base revision." };
  const scope = await collectSources(cwd, inputs.length ? inputs : changed ? changed.slice(0, 200) : ["."], file => auditable(file) || /\.(?:html?|vue|svelte|php)$/i.test(file));
  const findings: Array<AuditFinding & { file: string }> = [];
  for (const file of scope.files as SourceFile[]) {
    signal?.throwIfAborted();
    for (const f of auditSource(file.path, file.source, { domains, minSeverity })) findings.push({ ...f, file: file.path });
    if (domains.includes("ui") && rank.medium >= rank[minSeverity]) for (const f of uiSlopFindings(file.path, file.source, params.direction)) findings.push({ ...f, file: file.path });
  }
  findings.sort((a, b) => rank[b.severity] - rank[a.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  const counts = { total: findings.length, bySeverity: { high: 0, medium: 0, low: 0 } as Record<Severity, number>, byRule: {} as Record<string, number> };
  for (const f of findings) { counts.bySeverity[f.severity]++; counts.byRule[f.rule] = (counts.byRule[f.rule] ?? 0) + 1; }
  const sourceByPath = new Map(scope.files.map(file => [file.path, file.source]));
  const protectedSources = new Set(scope.files.filter(file => protectedQualityText(file.source)).map(file => file.path));
  const semantic = await refineQuality(findings.filter(f => qualityNeedsContext(f.rule)).map((f, i) => ({ id: `${f.file}:${f.line}:${i}`, file: f.file, line: f.line, rule: f.rule,
    protected: protectedSources.has(f.file), evidence: qualityExcerpt(f.rule, sourceByPath.get(f.file)!, f.line) })),
    { ...refinement, semantic: params.semantic, direction: params.direction, protectedPaths: params.protectedPaths, signal });
  return { domains, scope: { files: scope.files.length, skipped: scope.skipped, truncated: scope.truncated }, counts, findings: findings.slice(0, limit), omitted: Math.max(0, findings.length - limit), semantic,
    note: "Static cues from source text only: no data-flow analysis, no execution. Each finding names the fix; keep intentional cases (trusted input, admin scripts) and verify the rest by reproducing the failure or by a test. No findings does not mean secure or fast." };
}
