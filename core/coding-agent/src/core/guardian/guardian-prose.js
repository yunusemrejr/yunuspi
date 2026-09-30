/** Native document receipts for proportional completion. These are content
 * hashes and bounded classifications, never a synthetic test result. */
import { createHash } from "node:crypto";
import { basename, relative } from "node:path";

const MAX_BYTES = 16 * 1024;
const MAX_CHANGED_BYTES = 1024;
const hash = text => createHash("sha256").update(text, "utf8").digest("hex");
const bounded = text => typeof text === "string" && Buffer.byteLength(text, "utf8") <= MAX_BYTES && text.split("\n").length <= 200;
const risk = /\b(?:tests?|testing|build|lint|typecheck|compile|security|authentication|authorization|permission|policy|configuration|config|deploy|release|production|behavior|behaviour|runtime|api|algorithm|refactor|implement|migration|requirements?|contracts?|vulnerabilit\w*|regression|integration|pytest|vitest|jest|shellcheck|password|secret|credentials?|tokens?|must|shall|ports?|firewall|encryption)\b/i;

export function directProseRequest(text) {
  return typeof text === "string" && text.length <= 2048
    && /\b(?:typos?|spelling|grammar|punctuation|wording|proofread|copy\s?edit)\b/i.test(text)
    && !risk.test(text) && !/\b(?:run|execute|perform)\b[^\n]{0,80}\b(?:checks?|suites?|validation)\b/i.test(text);
}

export function proseToolAllowed(name, args) {
  if (["read", "edit", "write", "grep", "find", "ls"].includes(name)) return true;
  return name === "bash" && readOnlyDiscoveryShell(args?.command);
}

function discoverySegment(segment) {
  // The only redirection admitted is literal stderr discard, at the end.
  const source = segment.trim().replace(/\s+2\s*>\s*\/dev\/null\s*$/, "");
  const words = [];
  let word = "", quote, started = false, quoted = false;
  const push = () => { if (started) words.push({ text: word, quoted }); word = ""; started = false; quoted = false; };
  for (const ch of source) {
    // No escapes, expansion, scripts, redirection or pipeline syntax. Reject
    // it inside quotes too: this intentionally narrow grammar is literal.
    if (/[\\`$|<>&;(){}\r\n\x00]/.test(ch)) return false;
    if (quote) {
      if (ch === quote) quote = undefined;
      else word += ch;
    } else if (ch === '"' || ch === "'") { quote = ch; quoted = true; started = true; }
    else if (/\s/.test(ch)) push();
    else { word += ch; started = true; }
  }
  if (quote) return false;
  push();
  if (!words.length || words.length > 12 || words.some(token => !token.text || !(token.quoted ? /^[A-Za-z0-9_ ./~^*?:,!+@%#=-]+$/ : /^[A-Za-z0-9_./~=-]+$/).test(token.text))) return false;
  const [head, ...args] = words;
  if (head.quoted) return false;
  const text = args.map(token => token.text);
  if (head.text === "pwd") return !args.length || args.length === 1 && ["-L", "-P", "--logical", "--physical"].includes(text[0]);
  const literalPath = token => /^[A-Za-z0-9_./~ -]+$/.test(token.text) && !token.text.startsWith("-");
  if (head.text === "ls") return args.every(token => /^-[A-Za-z]+$/.test(token.text) || /^(?:--all|--almost-all|--directory|--human-readable|--recursive|--color=never)$/.test(token.text) || literalPath(token));
  if (head.text !== "grep") return false;
  let at = 0;
  while (at < args.length && args[at].text.startsWith("-")) {
    const flag = args[at++].text;
    if (flag === "--") break;
    if (!/^-[rRnHhilLcqsFEwoxvaz]+$/.test(flag) && !/^--(?:recursive|line-number|ignore-case|fixed-strings|word-regexp|line-regexp|count|files-with-matches|files-without-match|quiet|no-messages|extended-regexp|basic-regexp|with-filename|no-filename|color=never)$/.test(flag)) return false;
  }
  // A literal pattern and named files avoid stdin or process substitutions.
  return args.length - at >= 2 && args.slice(at + 1).every(literalPath);
}

export function readOnlyDiscoveryShell(command) {
  if (typeof command !== "string" || !command.trim() || command.length > 512 || /[\r\n\x00\\`$|(){}]/.test(command)) return false;
  const segments = [];
  let quote, start = 0;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (ch === ";" || ch === "&") return false;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ";" || ch === "&") {
      if (ch === "&" && command[i + 1] !== "&") return false;
      segments.push(command.slice(start, i));
      if (ch === "&") i++;
      start = i + 1;
    }
  }
  if (quote) return false;
  segments.push(command.slice(start));
  return segments.length <= 4 && segments.every(discoverySegment);
}

export function prosePath(cwd, file) {
  const local = relative(cwd, file).replaceAll("\\", "/");
  return local && !local.startsWith("../") && !local.startsWith("/")
    && /\.(?:md|rst|txt)$/i.test(file)
    && !risk.test(local.replace(/[._/-]/g, " "))
    && !/(?:^|\/)(?:\.[^/]+|core|src|agent|config|scripts?|tests?|security|polic(?:y|ies)|deploy(?:ment)?|runbooks?)(?:\/|$)/i.test(local)
    && !/^(?:AGENTS|SKILL|SYSTEM|PROMPT|CONTRIBUTING|SECURITY|POLICY|LICENSE|NOTICE|INSTALL|SETUP|OPERATIONS|OPS|AUTH|DEPLOY|RELEASE|RUNBOOK)(?:[._-]|$)/i.test(basename(file));
}

function proseLine(line) {
  return !/^ {4}|^\t|[`~]{3}|`|[{}<>=;]|:\/\/|\b[\w$.]+\(|^\s*(?:\$\s|#!|(?:npm|pnpm|yarn|node|python[23]?|bash|sh|sudo|curl|wget|git|ssh|rm|cp|mv|chmod|chown|export|set|echo|printf|env|sed|awk|perl|tee|find|SELECT|INSERT|UPDATE|DELETE)\s)|^\s*\.\.\s+[\w-]+::/i.test(line)
    && !risk.test(line);
}

// Inspect the actual changed line's context, so a plain token inside an
// unchanged fenced or reStructuredText literal block is not treated as prose.
function proseRange(text, from, to) {
  const lines = text.split("\n");
  let fence, literal = false;
  for (let i = 0, at = 0; i < lines.length; i++) {
    const line = lines[i], end = at + line.length;
    const marker = line.match(/^\s*(```+|~~~+)/)?.[1];
    if (marker) fence = fence === marker[0] ? undefined : fence ?? marker[0];
    const touched = end >= from && at <= to;
    if (touched && (fence || marker || literal && /^\s+\S/.test(line) || !proseLine(line))) return false;
    if (line.trim() && !/^\s/.test(line)) literal = /::$/.test(line);
    at = end + 1;
  }
  return true;
}

export function documentReadEvidence(file, text, complete) {
  if (!/\.(?:md|rst|txt)$/i.test(file) || !complete || !bounded(text)) return undefined;
  return { path: file, hash: hash(text), complete: true, bytes: Buffer.byteLength(text, "utf8"), plain: proseRange(text, 0, text.length) };
}

export function documentMutationEvidence(file, before, after) {
  if (!/\.(?:md|rst|txt)$/i.test(file) || !bounded(after) || before !== undefined && !bounded(before)) return undefined;
  // Writes have no old-content receipt. Guardian additionally requires a
  // preceding bounded plain read and a current full read after the write.
  if (before === undefined) return { path: file, hash: hash(after), changedBytes: Buffer.byteLength(after, "utf8"), proseOnly: Buffer.byteLength(after, "utf8") <= MAX_CHANGED_BYTES && proseRange(after, 0, after.length), rewrite: true };
  let start = 0, oldEnd = before.length, newEnd = after.length;
  while (start < oldEnd && start < newEnd && before[start] === after[start]) start++;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  const changedBytes = Buffer.byteLength(before.slice(start, oldEnd), "utf8") + Buffer.byteLength(after.slice(start, newEnd), "utf8");
  return { path: file, hash: hash(after), changedBytes, proseOnly: changedBytes > 0 && changedBytes <= MAX_CHANGED_BYTES && proseRange(before, start, oldEnd) && proseRange(after, start, newEnd), rewrite: false };
}
