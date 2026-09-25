/** Dependency-free code quality measurements: token clone detection (DRY),
 * code "slop" patterns, prose quality and function complexity. Pure functions
 * over source text plus one bounded workspace walker. No project code runs,
 * nothing is installed, no model is called. Every result is advisory
 * evidence with locations; intentional repetition and style are allowed. */
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const exec = promisify(execFile);

// ─────────────────────────────── languages ────────────────────────────────

export type Family = "c" | "python" | "ruby" | "shell" | "css" | "html" | "sql";
const FAMILIES: Record<string, Family> = {
  ".js": "c", ".mjs": "c", ".cjs": "c", ".jsx": "c", ".ts": "c", ".mts": "c", ".cts": "c", ".tsx": "c", ".java": "c", ".kt": "c", ".kts": "c",
  ".scala": "c", ".c": "c", ".h": "c", ".cc": "c", ".cpp": "c", ".cxx": "c", ".hpp": "c", ".cs": "c", ".go": "c", ".rs": "c", ".swift": "c",
  ".dart": "c", ".php": "c", ".vue": "html", ".svelte": "html", ".py": "python", ".pyi": "python", ".rb": "ruby", ".sh": "shell", ".bash": "shell",
  ".zsh": "shell", ".css": "css", ".scss": "css", ".less": "css", ".html": "html", ".htm": "html", ".sql": "sql",
};
export const familyOf = (file: string): Family | undefined => FAMILIES[path.extname(file).toLowerCase()];
const words = (text: string) => new Set(text.split(/\s+/).filter(Boolean));
// Keywords stay literal under renamed normalization; everything else that
// looks like a word is an identifier. Sets are per family and case-sensitive
// except SQL, so a TypeScript `Type` or `join` is an identifier.
const KEYWORDS: Record<Family, Set<string>> = {
  c: words("abstract as assert async await break case catch class const continue default defer delete do else enum export extends false final finally fn for from func function go goto if impl implements import in instanceof interface is let loop match mod module move mut namespace new nil null package private protected pub public return static struct super switch this throw throws trait true try type typeof undefined unsafe use var void where while with yield"),
  python: words("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case"),
  ruby: words("BEGIN END alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield"),
  shell: words("if then else elif fi case esac for select while until do done in function time"),
  css: new Set(), html: new Set(),
  sql: words("select from where join inner left right outer full cross on group by order having insert into values update set delete create table alter drop index view as and or not null is in exists between like limit offset union all distinct case when then else end primary key foreign references default"),
};
const keywordOf = (word: string, family: Family) => family === "sql" ? KEYWORDS.sql.has(word.toLowerCase()) : family === "css" || family === "html" ? true : KEYWORDS[family].has(word);
// A `/` starts a regular expression after an operator, an opening bracket, a
// separator or one of these keywords; after a value it divides.
const REGEX_BEFORE = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
/** A template literal from its opening backtick: the end offset and the
 * `${…}` expression ranges, with nested templates, strings and braces
 * balanced. Expressions are lexed as code by the caller. */
function templateLiteral(source: string, start: number): { end: number; expressions: Array<[number, number]> } {
  const expressions: Array<[number, number]> = [];
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") return { end: i + 1, expressions };
    if (c === "$" && source[i + 1] === "{") {
      const from = i + 2;
      let depth = 1;
      i = from;
      let previous = "(";
      while (i < source.length && depth > 0) {
        const d = source[i];
        if (d === "\\") { i += 2; continue; }
        if (d === "`") { i = templateLiteral(source, i).end; previous = "`"; continue; }
        if (d === '"' || d === "'") { i++; while (i < source.length && source[i] !== d && source[i] !== "\n") i += source[i] === "\\" ? 2 : 1; i++; previous = d; continue; }
        if (d === "/" && source[i + 1] === "/") { while (i < source.length && source[i] !== "\n") i++; continue; }
        if (d === "/" && source[i + 1] === "*") { const close = source.indexOf("*/", i + 2); i = close < 0 ? source.length : close + 2; continue; }
        if (d === "/" && /[(,=:[!&|?{};+\-*%<>~^]/.test(previous)) { const end = regexLiteral(source, i); if (end > 0) { i = end; previous = "/"; continue; } }
        if (d === "{") depth++;
        else if (d === "}" && --depth === 0) break;
        if (!/\s/.test(d)) previous = d;
        i++;
      }
      expressions.push([from, i]);
      i++;
      continue;
    }
    i++;
  }
  return { end: source.length, expressions };
}
function regexLiteral(source: string, index: number): number {
  let i = index + 1, inClass = false;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "\n") return -1;
    if (inClass) { if (c === "]") inClass = false; }
    else if (c === "[") inClass = true;
    else if (c === "/") { i++; while (i < source.length && /[a-z]/i.test(source[i])) i++; return i; }
    i++;
  }
  return -1;
}

export interface Token { text: string; norm: string; line: number; }
const LEXERS: Record<Family, RegExp> = {
  c: /(\s+)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(0x[\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[a-zA-Z]*)|([A-Za-z_$@][\w$]*)|(\S)/y,
  python: /(\s+)|(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|[rbfuRBFU]{0,2}"(?:\\.|[^"\\\n])*"|[rbfuRBFU]{0,2}'(?:\\.|[^'\\\n])*')|(0x[\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[jJ]?)|([A-Za-z_][\w]*)|(\S)/y,
  ruby: /(\s+)|(#[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\d[\d_]*(?:\.\d+)?)|([A-Za-z_@$][\w]*[?!]?)|(\S)/y,
  shell: /(\s+)|(#[^\n]*)|("(?:\\.|[^"\\])*"|'[^']*')|(\d+)|([A-Za-z_][\w-]*)|(\S)/y,
  css: /(\s+)|(\/\*[\s\S]*?\*\/|\/\/[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(#[\da-fA-F]{3,8}\b|-?\d*\.?\d+(?:px|rem|em|%|vh|vw|s|ms|deg|fr)?)|([A-Za-z_-][\w-]*)|(\S)/y,
  html: /(\s+)|(<!--[\s\S]*?-->)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\d+)|([A-Za-z_][\w-]*)|(\S)/y,
  sql: /(\s+)|(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:''|[^'])*'|"(?:[^"])*")|(\d+(?:\.\d+)?)|([A-Za-z_][\w$]*)|(\S)/y,
};

/** Tokens with line numbers and a normalized form: identifiers become `$`,
 * literals `0` and `""` (keywords and punctuation stay), so clones that
 * differ only in names and constants still match. */
export function tokenize(source: string, family: Family): Token[] {
  const lexer = new RegExp(LEXERS[family].source, "y"), out: Token[] = [];
  let line = 1, index = 0;
  const count = (text: string) => { for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) line++; };
  while (index < source.length) {
    if (family === "c" && source[index] === "`") {
      const template = templateLiteral(source, index), text = source.slice(index, template.end);
      out.push({ text, norm: '""', line });
      for (const [from, to] of template.expressions) {
        const offset = line + source.slice(index, from).split("\n").length - 1;
        for (const token of tokenize(source.slice(from, to), family)) out.push({ ...token, line: token.line + offset - 1 });
      }
      count(text);
      index = template.end;
      continue;
    }
    if (family === "c" && source[index] === "/" && source[index + 1] !== "/" && source[index + 1] !== "*" && (!out.length || REGEX_BEFORE.has(out[out.length - 1].text))) {
      const end = regexLiteral(source, index);
      if (end > 0) { out.push({ text: source.slice(index, end), norm: '""', line }); index = end; continue; }
    }
    lexer.lastIndex = index;
    const match = lexer.exec(source);
    if (!match || !match[0]) { index++; continue; }
    index = lexer.lastIndex;
    const [text, space, comment, string, num, word] = match;
    if (space || comment) { count(text); continue; }
    const startLine = line;
    if (string) { count(text); out.push({ text, norm: '""', line: startLine }); continue; }
    if (num) { out.push({ text, norm: "0", line }); continue; }
    if (word) { out.push({ text, norm: keywordOf(word, family) ? word : "$", line }); continue; }
    out.push({ text, norm: text, line });
  }
  return out;
}

// ─────────────────────────────── duplicates ───────────────────────────────

export interface SourceFile { path: string; source: string; }
export interface CloneFragment { path: string; start: number; end: number; tokens: number; }
export interface Clone { a: CloneFragment; b: CloneFragment; lines: number; tokens: number; kind: "exact" | "renamed"; renamed: string[]; preview: string[]; }
export interface DuplicateReport {
  files: number; tokens: number; clones: Clone[]; groups: Array<{ occurrences: CloneFragment[]; lines: number; kind: string; repetitive?: boolean }>;
  duplicatedLines: number; duplicatedPercent: number; byFile: Array<{ path: string; duplicatedLines: number; percent: number }>; truncated: boolean;
}

// Declarations and data tables (interface fields, option lists, records)
// repeat by design; a clone worth extracting contains logic: control flow
// or assignment. A sequence repeating with a short period is a list.
const LOGIC = new Set(["if", "else", "for", "while", "return", "switch", "case", "throw", "try", "catch", "await", "yield", "break", "continue", "new",
  "function", "def", "elif", "except", "raise", "with", "lambda", "fn", "match", "loop", "unless", "until", "rescue", "select", "from", "where", "join"]);
function hasLogic(tokens: Token[], start: number, length: number): boolean {
  let logic = 0;
  for (let i = start; i < start + length; i++) {
    const t = tokens[i].text;
    if (LOGIC.has(t) || (t === "=" && tokens[i + 1]?.text !== "=" && tokens[i + 1]?.text !== ">" && tokens[i - 1]?.text !== "=" && tokens[i - 1]?.text !== "!" && tokens[i - 1]?.text !== "<" && tokens[i - 1]?.text !== ">")) logic++;
    if (logic >= 3) return true;
  }
  return false;
}
function periodic(keys: number[], start: number, length: number): boolean {
  for (let period = 1; period <= 16 && period < length / 3; period++) {
    let same = 0;
    for (let i = start; i + period < start + length; i++) if (keys[i] === keys[i + period]) same++;
    if (same / (length - period) >= 0.8) return true;
  }
  return false;
}
const hashToken = (text: string) => { let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619); return h >>> 0; };

/** Winnowing over normalized token k-grams, then maximal extension of each
 * matching pair. `focus` limits reports to clones touching those files (for
 * example the changed files of a branch against the whole repository). */
export function findDuplicates(files: SourceFile[], options: { minTokens?: number; minLines?: number; mode?: "renamed" | "exact"; focus?: Set<string>; focusLines?: Map<string, [number, number]>; limit?: number } = {}): DuplicateReport {
  const minTokens = Math.max(20, options.minTokens ?? 50), minLines = Math.max(2, options.minLines ?? 5), limit = options.limit ?? 40;
  const k = Math.min(minTokens, 18), window = 6, renamed = (options.mode ?? "renamed") === "renamed";
  const docs = files.map(file => {
    const family = familyOf(file.path)!;
    const tokens = tokenize(file.source, family);
    return { file, family, tokens, keys: tokens.map(token => hashToken(renamed ? token.norm : token.text)) };
  });
  const index = new Map<number, Array<[number, number]>>();
  let totalTokens = 0;
  for (let d = 0; d < docs.length; d++) {
    const { keys } = docs[d];
    totalTokens += keys.length;
    if (keys.length < k) continue;
    const grams: number[] = [];
    for (let i = 0; i + k <= keys.length; i++) {
      let h = 0;
      for (let j = 0; j < k; j++) h = (Math.imul(h, 31) + keys[i + j]) >>> 0;
      grams.push(h);
    }
    let last = -1;
    for (let start = 0; start + window <= grams.length; start++) {
      let best = start;
      for (let i = start + 1; i < start + window; i++) if (grams[i] <= grams[best]) best = i;
      if (best === last) continue;
      last = best;
      const list = index.get(grams[best]) ?? [];
      if (list.length < 64) list.push([d, best]);
      index.set(grams[best], list);
    }
  }
  const seen = new Set<string>(), clones: Clone[] = [];
  let truncated = false;
  const focus = options.focus;
  for (const positions of index.values()) {
    if (positions.length < 2 || positions.length > 48) continue;
    for (let x = 0; x < positions.length; x++) for (let y = x + 1; y < positions.length; y++) {
      let [da, ia] = positions[x], [db, ib] = positions[y];
      if (da > db || (da === db && ia > ib)) [da, ia, db, ib] = [db, ib, da, ia];
      const A = docs[da], B = docs[db];
      if (A.family !== B.family) continue;
      if (focus && !focus.has(A.file.path) && !focus.has(B.file.path)) continue;
      const offsetKey = `${da}:${db}:${ib - ia}`;
      // Extend backwards and forwards to the maximal equal run.
      let s = 0;
      while (ia - s - 1 >= 0 && ib - s - 1 >= 0 && A.keys[ia - s - 1] === B.keys[ib - s - 1] && (da !== db || ib - s - 1 > ia)) s++;
      const a0 = ia - s, b0 = ib - s;
      const key = `${offsetKey}:${a0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let n = 0;
      while (a0 + n < A.keys.length && b0 + n < B.keys.length && A.keys[a0 + n] === B.keys[b0 + n] && (da !== db || a0 + n < b0)) n++;
      if (n < minTokens) continue;
      if (!hasLogic(A.tokens, a0, n) || periodic(A.keys, a0, n)) continue;
      const aStart = A.tokens[a0].line, aEnd = A.tokens[a0 + n - 1].line, bStart = B.tokens[b0].line, bEnd = B.tokens[b0 + n - 1].line;
      if (Math.min(aEnd - aStart, bEnd - bStart) + 1 < minLines) continue;
      const lines = options.focusLines;
      if (lines) {
        const hit = (p: string, s0: number, e0: number) => { const r = lines.get(p); return !!r && s0 <= r[1] && e0 >= r[0]; };
        if (!hit(A.file.path, aStart, aEnd) && !hit(B.file.path, bStart, bEnd)) continue;
      }
      const names = new Map<string, string>();
      let exact = true;
      for (let i = 0; i < n; i++) {
        const p = A.tokens[a0 + i], q = B.tokens[b0 + i];
        if (p.text !== q.text) { exact = false; if (p.norm === "$" && names.size < 6) names.set(p.text, q.text); }
      }
      const preview = A.file.source.split("\n").slice(aStart - 1, Math.min(aEnd, aStart + 2)).map(line => line.trim().slice(0, 120));
      clones.push({ a: { path: A.file.path, start: aStart, end: aEnd, tokens: n }, b: { path: B.file.path, start: bStart, end: bEnd, tokens: n }, lines: Math.max(aEnd - aStart, bEnd - bStart) + 1, tokens: n,
        kind: exact ? "exact" : "renamed", renamed: [...names].map(([p, q]) => `${p}→${q}`), preview });
      if (clones.length >= 2000) { truncated = true; break; }
    }
    if (truncated) break;
  }
  // Drop clones contained in a longer clone between the same two files.
  clones.sort((p, q) => q.tokens - p.tokens);
  const kept: Clone[] = [];
  const within = (inner: CloneFragment, outer: CloneFragment) => inner.path === outer.path && inner.start >= outer.start && inner.end <= outer.end;
  for (const clone of clones) if (!kept.some(other => (within(clone.a, other.a) && within(clone.b, other.b)) || (within(clone.a, other.b) && within(clone.b, other.a)))) kept.push(clone);
  // Group pairs sharing a fragment into clone classes (A~B, A~C → {A,B,C}).
  const groups: DuplicateReport["groups"] = [];
  const same = (p: CloneFragment, q: CloneFragment) => p.path === q.path && Math.abs(p.start - q.start) <= 2 && Math.abs(p.end - q.end) <= 2;
  for (const clone of kept) {
    const home = groups.find(group => group.occurrences.some(o => same(o, clone.a) || same(o, clone.b)));
    if (home) { for (const fragment of [clone.a, clone.b]) if (!home.occurrences.some(o => same(o, fragment))) home.occurrences.push(fragment); if (clone.kind === "renamed") home.kind = "renamed"; }
    else groups.push({ occurrences: [clone.a, clone.b], lines: clone.lines, kind: clone.kind });
  }
  // Overlapping windows over one repetitive stretch are one region, not a
  // dozen clones: merge each group's overlapping fragments per file.
  for (const group of groups) {
    const merged: CloneFragment[] = [];
    for (const fragment of [...group.occurrences].sort((p, q) => p.path.localeCompare(q.path) || p.start - q.start)) {
      const last = merged.at(-1);
      if (last && last.path === fragment.path && fragment.start <= last.end + 2) { last.end = Math.max(last.end, fragment.end); last.tokens = Math.max(last.tokens, fragment.tokens); (group as any).repetitive = true; }
      else merged.push({ ...fragment });
    }
    group.occurrences = merged;
    group.lines = Math.max(...merged.map(f => f.end - f.start + 1));
  }
  const covered = new Map<string, Set<number>>();
  for (const clone of kept) for (const f of [clone.a, clone.b]) { const set = covered.get(f.path) ?? new Set<number>(); for (let l = f.start; l <= f.end; l++) set.add(l); covered.set(f.path, set); }
  const totalLines = docs.reduce((sum, d) => sum + d.file.source.split("\n").length, 0);
  const duplicatedLines = [...covered.values()].reduce((sum, set) => sum + set.size, 0);
  const byFile = [...covered].map(([p, set]) => ({ path: p, duplicatedLines: set.size, percent: Math.round(set.size / Math.max(1, docs.find(d => d.file.path === p)!.file.source.split("\n").length) * 1000) / 10 }))
    .sort((p, q) => q.duplicatedLines - p.duplicatedLines).slice(0, 20);
  return { files: docs.length, tokens: totalTokens, clones: kept.slice(0, limit), groups: groups.sort((p, q) => q.occurrences.length * q.lines - p.occurrences.length * p.lines).slice(0, limit),
    duplicatedLines, duplicatedPercent: Math.round(duplicatedLines / Math.max(1, totalLines) * 1000) / 10, byFile, truncated: truncated || kept.length > limit };
}

// ──────────────────────────────── code slop ────────────────────────────────

export interface Finding { rule: string; line: number; message: string; excerpt?: string; }
const TESTISH = /(?:^|\/)(?:tests?|__tests__|spec|specs|fixtures?|examples?|scripts?|bin|benchmarks?|e2e)\/|[._-](?:test|spec|bench|stories)\.[a-z]+$|(?:^|\/)(?:cli|main)\.[cm]?[jt]s$/i;

/** High-precision code smells that generated or hurried code often carries.
 * `lines` restricts findings to a changed span. */
export function codeSlop(file: string, source: string, lines?: [number, number]): Finding[] {
  const family = familyOf(file);
  if (!family || source.length > 512 * 1024) return [];
  const rows = source.split("\n"), out: Finding[] = [];
  const js = /\.(?:[cm]?[jt]sx?)$/i.test(file), ts = /\.[cm]?tsx?$/i.test(file), py = family === "python";
  const inRange = (line: number) => !lines || (line >= lines[0] && line <= lines[1]);
  const add = (rule: string, line: number, message: string) => { if (inRange(line) && out.length < 40) out.push({ rule, line, message, excerpt: rows[line - 1]?.trim().slice(0, 140) }); };
  // Command-line entry points print by design.
  const testish = TESTISH.test(file.replaceAll("\\", "/")) || rows[0]?.startsWith("#!") || /\bprocess\.argv\b|import\.meta\.url\s*===|require\.main\s*===\s*module|if __name__ == ["']__main__["']/.test(source);
  const comment = family === "python" || family === "ruby" || family === "shell" ? /^\s*#\s?(.*)$/ : /^\s*(?:\/\/|\/\*+|\*)\s?(.*)$/;
  let narrating = 0, commented: number[] = [];
  const flushCommented = (end: number) => {
    if (commented.length >= 3) add("commented-out-code", commented[0], `${commented.length} consecutive commented-out code lines (L${commented[0]}–L${end}): delete dead code; version control keeps history.`);
    commented = [];
  };
  rows.forEach((row, i) => {
    const line = i + 1, text = row.trim();
    const c = comment.exec(row);
    if (c) {
      const body = c[1].trim();
      if (/^(?:\.\.\.\s*)?(?:\(?rest of (?:the )?(?:code|file|implementation|function|class)|(?:existing|previous|other|remaining) code (?:here|remains|unchanged|stays|goes)|same as (?:before|above))\b/i.test(body)
        || /^\.\.\.\s*(?:unchanged|same|etc\.?)?\s*\.{0,3}$/i.test(body) || /^\.\.\.\s*\(?(?:rest|existing|other)\b/i.test(body))
        add("placeholder-elision", line, "Elision comment standing in for code (\"... rest of code\"): the real code is missing here.");
      else if (/\b(?:TODO|FIXME)\b[:\s-]*(?:implement|add (?:real|actual)|replace (?:with|this)|fill in|finish)/i.test(body) || /\byour (?:code|logic|implementation) here\b/i.test(body))
        add("placeholder-implementation", line, "Placeholder marks unimplemented behavior; implement it or report the gap explicitly.");
      if (/^(?:step \d+[:.)]|(?:first|then|next|finally),? (?:we |let's )|(?:initialize|increment|decrement|loop (?:through|over)|iterate (?:through|over)|check if|return (?:the )?(?:result|value)|create (?:a )?new|call (?:the )?|define (?:the |a )?|import (?:the )?|set (?:the )?\w+ to)\b)/i.test(body)) narrating++;
      // Only line comments count as commented-out code: JSDoc examples are
      // documentation, not dead code.
      const code = body.replace(/^\/+\s*/, "");
      const lineComment = /^\s*(?:\/\/|#)/.test(row);
      if (lineComment && ((/[;{}]\s*$/.test(code) && /[=(.]/.test(code)) || /^(?:const|let|var|return|if|for|while|import|export|def|class|print|console\.)\b.*[=(:]/.test(code))) commented.push(line);
      else flushCommented(line - 1);
      return;
    }
    flushCommented(line - 1);
    if (!testish) {
      if (js && /\bconsole\.(?:log|debug|trace|dir)\s*\(/.test(text)) add("debug-leftover", line, "console output left in library code; use the project's logger or remove it.");
      if (js && /^debugger\s*;?$/.test(text)) add("debug-leftover", line, "debugger statement.");
      if (py && /\b(?:breakpoint\(\)|pdb\.set_trace\(\)|import pdb\b)/.test(text)) add("debug-leftover", line, "Python debugger hook left in code.");
      if (/\.rs$/i.test(file) && /\bdbg!\(/.test(text)) add("debug-leftover", line, "dbg! macro left in code.");
      if (/\.php$/i.test(file) && /\b(?:var_dump|dd|dump)\s*\(/.test(text)) add("debug-leftover", line, "Debug dump left in code.");
      if (family === "ruby" && /\bbinding\.(?:pry|irb)\b/.test(text)) add("debug-leftover", line, "Debugger binding left in code.");
    }
    if (/\bthrow new Error\((["'`])(?:not implemented|todo|implement me)[^"'`]*\1\)|raise NotImplementedError\(?\s*(["'])(?:todo|implement)/i.test(text)) add("placeholder-implementation", line, "Unimplemented stub on a live path.");
    if (/\?\s*true\s*:\s*false\b|\?\s*false\s*:\s*true\b/.test(text)) add("redundant-boolean", line, "Ternary returning a boolean literal: use the condition itself (or its negation).");
    // Strict `=== true` is a deliberate check on untyped data; loose equality
    // with a boolean literal coerces and is almost always a mistake.
    if (js && /(?<![=!])[=!]=\s*(?:true|false)\b|\b(?:true|false)\s*[=!]=(?!=)/.test(text)) add("redundant-boolean", line, "Loose comparison with a boolean literal coerces the other side: test the value directly or compare strictly.");
    if (py && /==\s*(?:True|False)\b/.test(text)) add("redundant-boolean", line, "Comparison with True/False: test the value directly or use `is`.");
    if (js && /(\b[\w.$]+)\s*!==\s*null\s*&&\s*\1\s*!==\s*undefined|(\b[\w.$]+)\s*!==\s*undefined\s*&&\s*\2\s*!==\s*null/.test(text)) add("verbose-null-check", line, "Double null/undefined check: `x != null` or optional chaining says the same.");
    if (py && /^except\s*:/.test(text)) add("bare-except", line, "Bare except catches KeyboardInterrupt and SystemExit too; catch the specific exceptions.");
    if (ts && /\bas any\b|:\s*any\b(?![\w-])/.test(text) && !testish) add("type-escape", line, "`any` switches off type checking here; prefer a precise type or `unknown` with narrowing.");
    if (/@ts-ignore|@ts-nocheck/.test(text)) add("type-escape", line, "Type error silenced; fix the type or use @ts-expect-error with a reason.");
    if (/[\u{1F300}-\u{1FAFF}\u{2705}\u{274C}\u{2728}\u{1F680}]/u.test(text) && /(?:console\.\w+|print|log(?:ger)?\.\w+|echo)\s*\(?\s*["'`]/.test(text)) add("emoji-log", line, "Emoji in log output: logs are parsed and grepped; keep them plain.");
  });
  flushCommented(rows.length);
  // Swallowed errors: a catch/except whose whole body only logs or passes.
  const whole = lines ? rows.slice(Math.max(0, lines[0] - 3), lines[1] + 3).join("\n") : source;
  const base = lines ? Math.max(0, lines[0] - 3) : 0;
  const lineAt = (offset: number) => base + whole.slice(0, offset).split("\n").length;
  if (js) for (const match of whole.matchAll(/catch\s*(?:\(\s*\w*\s*\))?\s*\{\s*(?:console\.(?:log|error|warn)\([^;{}]*\)\s*;?\s*)?\}/g))
    if (/console\./.test(match[0]) || !/\/\/|\/\*/.test(match[0])) add("swallowed-error", lineAt(match.index!), "catch block logs or ignores the error and continues: handle it, rethrow, or document why it is safe.");
  if (py) for (const match of whole.matchAll(/except[^\n:]*:\s*\n(\s+)(?:pass|print\([^\n]*\)|logging\.\w+\([^\n]*\)|logger\.\w+\([^\n]*\))\s*\n(?!\1\S)/g))
    add("swallowed-error", lineAt(match.index!), "except block only passes or logs: handle the error, re-raise, or document why continuing is safe.");
  if (js) for (const match of whole.matchAll(/if\s*\(([^()]*(?:\([^()]*\))*[^()]*)\)\s*\{?\s*return\s+(true|false)\s*;?\s*\}?\s*(?:else\s*)?\{?\s*return\s+(true|false)\s*;?\s*\}?/g))
    if (match[2] !== match[3]) add("redundant-boolean", lineAt(match.index!), `if/else returning ${match[2]}/${match[3]}: return the condition${match[2] === "false" ? " negated" : ""} directly.`);
  if (narrating >= 3) add("narrating-comments", lines?.[0] ?? 1, `${narrating} comments narrate what the next line does ("Initialize…", "Loop through…"): keep comments for why, not what.`);
  // Repeated magic strings: the same long literal four or more times.
  const counts = new Map<string, number[]>();
  for (const match of source.matchAll(/(["'])([^"'\n]{8,80})\1/g)) {
    if (/^(?:https?:|\.{0,2}\/|[\w-]+\.[a-z]{2,4}$)/.test(match[2]) || /\s{2}/.test(match[2])) continue;
    const at = source.slice(0, match.index!).split("\n").length;
    counts.set(match[2], [...(counts.get(match[2]) ?? []), at]);
  }
  for (const [value, at] of counts) if (at.length >= 4 && at.some(inRange)) add("repeated-literal", at.find(inRange)!, `"${value.slice(0, 40)}" appears ${at.length} times (L${at.slice(0, 5).join(", L")}): one named constant keeps them in sync.`);
  return out;
}

/** Identifier uses per line from the token stream (template expressions are
 * lexed as code) plus identifiers inside Python f-string fields. */
function identifierUses(source: string, family: Family): Array<{ name: string; line: number }> {
  const out: Array<{ name: string; line: number }> = [];
  for (const token of tokenize(source, family)) {
    // Any word can be a use: keyword sets span languages (Java's `assert` is
    // an ordinary identifier in JavaScript).
    if (/^[A-Za-z_$][\w$]*$/.test(token.text)) out.push({ name: token.text, line: token.line });
    else if (family === "python" && token.norm === '""' && /^[fF][rR]?["']|^[rR][fF]["']/.test(token.text)) {
      // f-string fields: identifiers inside {…}, skipping {{ escapes.
      for (const match of token.text.replace(/\{\{|\}\}/g, "  ").matchAll(/\{([^{}]*)\}/g)) for (const name of match[1].split(/[:!]/)[0].match(/[A-Za-z_][\w]*/g) ?? []) out.push({ name, line: token.line });
    }
  }
  return out;
}
/** Imported names never referenced again in the same file (JS/TS, Python). */
export function unusedImports(file: string, source: string): Finding[] {
  const out: Finding[] = [], js = /\.(?:[cm]?[jt]sx?)$/i.test(file), py = /\.pyi?$/i.test(file);
  if ((!js && !py) || (py && /__init__\.pyi?$/.test(file))) return out;
  const lineOf = (offset: number) => source.slice(0, offset).split("\n").length;
  const statements: Array<{ names: string[]; from: number; to: number }> = [];
  if (js) for (const match of source.matchAll(/^\s*import\s+(?:type\s+)?([^'";]+?)\s+from\s+['"][^'"]+['"]/gm)) {
    const clause = match[1], names: string[] = [];
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) for (const part of braces[1].split(",")) { const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim(); if (name) names.push(name); }
    const head = clause.replace(/\{[^}]*\}/, "").replace(/\*\s+as\s+[\w$]+/, "").replace(/,/g, " ").trim();
    for (const part of head.split(/\s+/).filter(Boolean)) if (part !== "as") names.push(part);
    const star = /\*\s+as\s+([\w$]+)/.exec(clause); if (star) names.push(star[1]);
    statements.push({ names, from: lineOf(match.index!), to: lineOf(match.index! + match[0].length) });
  }
  if (py) for (const match of source.matchAll(/^(?:from\s+[\w.]+\s+)?import\s+([^\n#(]+)$/gm)) {
    const names = match[1].split(",").map(part => part.trim().split(/\s+as\s+/).pop()!.trim().split(".")[0]).filter(name => /^\w+$/.test(name) && name !== "annotations");
    statements.push({ names, from: lineOf(match.index!), to: lineOf(match.index! + match[0].length) });
  }
  if (!statements.length) return out;
  const inImport = (line: number) => statements.some(statement => line >= statement.from && line <= statement.to);
  const used = new Set(identifierUses(source, py ? "python" : "c").filter(use => !inImport(use.line)).map(use => use.name));
  for (const statement of statements) for (const name of new Set(statement.names))
    // React's default import is required by the classic JSX runtime.
    if (/^[\w$]+$/.test(name) && name !== "React" && !used.has(name)) out.push({ rule: "unused-import", line: statement.from, message: `\`${name}\` is imported but never used.` });
  return out.slice(0, 20);
}

// ──────────────────────────────── prose ───────────────────────────────────

const PROSE_PATTERNS: Array<[RegExp, string]> = [
  [/\bdelv(?:e|es|ing) (?:into|deeper)\b/gi, "explore, examine, look at"], [/\b(?:rich |vibrant )?tapestry\b/gi, "mix, range (or cut)"], [/\b(?:a |is a |stands as a )?testament to\b/gi, "shows, proves"],
  [/\bmeticulous(?:ly)?\b/gi, "careful(ly)"], [/\bseamless(?:ly)?\b/gi, "smooth, without extra steps"], [/\bleverag(?:e|es|ed|ing)\b/gi, "use"], [/\butiliz(?:e|es|ed|ing)\b/gi, "use"],
  [/\brobust\b/gi, "reliable, strong (say how)"], [/\bcutting[- ]edge\b/gi, "new, the specific capability"], [/\bgame[- ]chang(?:er|ing)\b/gi, "the specific change"], [/\bunlock(?:s|ing)? (?:the )?(?:full |true )?(?:potential|power)\b/gi, "the concrete benefit"],
  [/\belevat(?:e|es|ing) (?:your|the)\b/gi, "improve, raise"], [/\bembark(?:s|ing)? on\b/gi, "start, begin"], [/\bnavigat(?:e|ing) the (?:complexities|landscape|world|intricacies)\b/gi, "handle, work through"],
  [/\bin (?:today'?s|the) (?:fast[- ]paced|ever[- ]changing|rapidly evolving|digital) (?:world|landscape|age|era)\b/gi, "(cut; start with the point)"], [/\bever[- ]evolving\b/gi, "changing"],
  [/\bit(?:'s| is) (?:important|worth|crucial) (?:to note|noting|to remember)(?: that)?\b/gi, "(cut; state the point)"], [/\bin conclusion\b/gi, "(cut)"], [/\bin the (?:realm|world) of\b/gi, "in"],
  [/\b(?:pivotal|paramount)\b/gi, "important, central"], [/\bfoster(?:s|ing)?\b/gi, "build, encourage"], [/\bharness(?:es|ing)? the power\b/gi, "use"], [/\bunleash(?:es|ing)?\b/gi, "release, enable"],
  [/\bsupercharg(?:e|es|ed|ing)\b/gi, "speed up, improve"], [/\brevolutioniz(?:e|es|ed|ing)\b/gi, "change"], [/\btransformative\b/gi, "the specific effect"], [/\bholistic\b/gi, "complete, whole"],
  [/\bsynerg(?:y|ies|istic)\b/gi, "combined effect"], [/\bempower(?:s|ing)?\b/gi, "let, help"], [/\bstreamlin(?:e|es|ed|ing)\b/gi, "simplify, speed up"], [/\blet'?s dive (?:in|into|deeper)\b/gi, "(cut)"],
  [/\bdive (?:deep|deeper) into\b/gi, "explore, examine"], [/\blook no further\b/gi, "(cut)"], [/\bwhether you'?re an? [\w -]{2,30} or an? /gi, "name the reader"], [/\bat its core\b/gi, "(cut)"],
  [/\ba (?:myriad|plethora) of\b/gi, "many"], [/\bnestled\b/gi, "located"], [/\bbustling\b/gi, "busy"], [/\bshowcas(?:e|es|ing)\b/gi, "shows"], [/\bboasts?\b/gi, "has"], [/\bunderscor(?:e|es|ing)\b/gi, "shows, stresses"],
  [/\bcrucial(?:ly)?\b/gi, "important (or cut)"], [/\bnotably,/gi, "(cut)"], [/\bmoreover,|\bfurthermore,/gi, "also (or cut)"], [/\bin summary,/gi, "(cut)"], [/\bimagine a world\b/gi, "(state the claim)"],
  [/\bnext[- ]generation\b/gi, "the specific generation or capability"], [/\bstate[- ]of[- ]the[- ]art\b/gi, "the specific capability"], [/\bworld[- ]class\b/gi, "the specific standard met"],
  [/\bbest[- ]in[- ]class\b/gi, "the specific comparison"], [/\bAI[- ]powered\b/gi, "the capability, not the technology"], [/\b(?:AI-assisted|AI-generated|generated by AI|written with AI)\b/gi, "(cut unless the reader needs provenance)"],
  [/\bfrictionless\b/gi, "the specific step removed"], [/\b(?:limitless|endless) possibilities\b/gi, "the concrete options"], [/\bbuilt for everyone\b/gi, "the named reader"],
  [/\btake your [\w ]{2,24} to the next level\b/gi, "the concrete improvement"], [/\bcarefully curated\b/gi, "(cut the praise; show the selection)"], [/\bthoughtfully (?:designed|crafted)\b/gi, "(cut the praise)"],
  [/\bprivacy by design\b/gi, "the specific practice"], [/\b(?:military-grade|bank-level)\b/gi, "the specific standard"], [/\b256[- ]bit\b/gi, "name only where the reader decides on it"],
];
const HEDGES = /\b(?:might|may|could|perhaps|possibly|potentially|arguably|somewhat|fairly|relatively)\b/gi;
const FILLERS = /\b(?:very|really|just|actually|basically|literally|truly|simply|quite|extremely|incredibly)\b/gi;
const syllables = (word: string) => { const w = word.toLowerCase().replace(/[^a-z]/g, ""); if (w.length <= 3) return 1; const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g); return Math.max(1, groups?.length ?? 1); };

export interface ProseReport {
  words: number; sentences: number; averageSentence: number; longSentences: number; readingEase: number; grade: number;
  emDashesPer100: number; hedgesPer100: number; fillersPer100: number; passiveShare: number; exclamations: number;
  findings: Finding[]; phrases: Array<{ phrase: string; count: number; try: string }>;
}
/** Prose measurements and stock-phrase findings for Markdown, text or copy.
 * Code blocks, inline code, URLs, front matter and HTML tags are skipped. */
export function proseReport(text: string): ProseReport {
  const cleaned = text.replace(/^---\n[\s\S]*?\n---\n/, m => m.replace(/[^\n]/g, " ")).replace(/```[\s\S]*?```/g, m => m.replace(/[^\n]/g, " ")).replace(/`[^`\n]*`/g, " ")
    .replace(/<[^>\n]+>/g, " ").replace(/https?:\/\/\S+/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  const lines = cleaned.split("\n");
  const body = lines.filter(line => !/^\s*(?:#|\||[-*+] \[.\])/.test(line)).join("\n");
  const words = body.match(/[A-Za-z][A-Za-z'’-]*/g) ?? [];
  const sentences = body.split(/(?<=[.!?])\s+|\n{2,}/).map(s => s.trim()).filter(s => /[A-Za-z]{2}/.test(s));
  const lengths = sentences.map(s => (s.match(/[A-Za-z][A-Za-z'’-]*/g) ?? []).length);
  const syl = words.reduce((sum, w) => sum + syllables(w), 0);
  const perSentence = words.length / Math.max(1, sentences.length), perWord = syl / Math.max(1, words.length);
  const per100 = (n: number) => Math.round(n / Math.max(1, words.length) * 1000) / 10;
  const passive = sentences.filter(s => /\b(?:is|are|was|were|be|been|being)\s+(?:\w+ly\s+)?\w+(?:ed|en)\b/i.test(s)).length;
  const findings: Finding[] = [], phrases = new Map<string, { count: number; try: string }>();
  lines.forEach((line, i) => {
    for (const [pattern, suggestion] of PROSE_PATTERNS) for (const match of line.matchAll(pattern)) {
      const key = match[0].toLowerCase();
      const row = phrases.get(key) ?? { count: 0, try: suggestion }; row.count++; phrases.set(key, row);
      if (findings.length < 40) findings.push({ rule: "stock-phrase", line: i + 1, message: `"${match[0]}" → ${suggestion}`, excerpt: line.trim().slice(0, 140) });
    }
    if (/^#{1,3}\s+(?:introduction|conclusion|final thoughts|key takeaways|wrapping up|in summary)\s*$/i.test(line.trim())) findings.push({ rule: "boilerplate-heading", line: i + 1, message: "Generic section heading: name what the section says." });
    if (/^#{1,3}\s+(?:how this (?:site|website|page) works|how it was built|our process|under the hood)\s*$/i.test(line.trim()) || /<h[12]\b[^>]*>\s*(?:how this (?:site|website|page) works|how it was built|our process|under the hood)\s*</i.test(line)) findings.push({ rule: "transparency-heading", line: i + 1, message: "Meta heading about the site itself: cut unless this page documents those subjects." });
    if (/\b\d+(?:\.\d+)?\s*x\b|\b\d{2,3}%\s+(?:faster|smarter|better|cheaper|more \w+|accurate|efficient)\b/i.test(line) && !/measured|study|survey|benchmark|tested|based on|report|data|customers|teams/i.test(lines.slice(Math.max(0, i - 2), i + 3).join("\n"))) findings.push({ rule: "metric-without-basis", line: i + 1, message: "Metric claim without a nearby basis: add measured-where/on-what/against-what, or cut the number." });
    if (/^\s*[-*]\s*(?:\p{Extended_Pictographic})/u.test(line)) findings.push({ rule: "emoji-bullet", line: i + 1, message: "Emoji as bullet decoration: plain bullets read as more credible." });
  });
  const triads = (body.match(/\b\w+(?: \w+)?, \w+(?: \w+)?,? and \w+/g) ?? []).length;
  if (sentences.length >= 6 && triads / sentences.length > 0.3) findings.push({ rule: "rule-of-three", line: 1, message: `${triads} "X, Y and Z" triads in ${sentences.length} sentences: vary rhythm; not every list has three items.` });
  const openers = new Map<string, number>();
  for (const s of sentences) { const first = s.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, ""); if (first) openers.set(first, (openers.get(first) ?? 0) + 1); }
  for (const [word, count] of openers) if (count >= 4 && count / sentences.length > 0.2 && !["the", "a", "i"].includes(word)) findings.push({ rule: "repeated-opener", line: 1, message: `${count} sentences start with "${word}": vary openings.` });
  const dashes = (body.match(/—|\s--\s/g) ?? []).length;
  if (words.length >= 150 && dashes / words.length * 100 > 1.2) findings.push({ rule: "dash-density", line: 1, message: `${dashes} em dashes in ${words.length} words: use commas, colons or full stops for most of them.` });
  lengths.forEach((n, i) => { if (n > 38 && findings.length < 60) findings.push({ rule: "long-sentence", line: Math.max(1, lines.findIndex(line => line.includes(sentences[i].slice(0, 30))) + 1), message: `${n}-word sentence: split it.` }); });
  return {
    words: words.length, sentences: sentences.length, averageSentence: Math.round(perSentence * 10) / 10, longSentences: lengths.filter(n => n > 30).length,
    readingEase: Math.round(206.835 - 1.015 * perSentence - 84.6 * perWord), grade: Math.max(0, Math.round((0.39 * perSentence + 11.8 * perWord - 15.59) * 10) / 10),
    emDashesPer100: per100(dashes), hedgesPer100: per100((body.match(HEDGES) ?? []).length), fillersPer100: per100((body.match(FILLERS) ?? []).length),
    passiveShare: Math.round(passive / Math.max(1, sentences.length) * 100), exclamations: (body.match(/!(?=\s|$)/g) ?? []).length,
    findings, phrases: [...phrases].map(([phrase, row]) => ({ phrase, ...row })).sort((a, b) => b.count - a.count).slice(0, 15),
  };
}

// ────────────────────────────── complexity ────────────────────────────────

export interface FunctionMetrics { name: string; line: number; lines: number; params: number; cyclomatic: number; nesting: number; async?: boolean; awaits?: number; }
const DECISIONS = new Set(["if_statement", "for_statement", "for_in_statement", "for_of_statement", "while_statement", "do_statement", "switch_case", "catch_clause", "ternary_expression", "conditional_expression",
  "elif_clause", "except_clause", "case_clause", "match_arm", "if_expression", "while_expression", "for_expression", "list_comprehension", "boolean_operator"]);
const FUNCTIONS = new Set(["function_declaration", "function_expression", "arrow_function", "method_definition", "generator_function_declaration", "function_definition", "function", "method"]);
const NESTING = new Set(["if_statement", "for_statement", "for_in_statement", "for_of_statement", "while_statement", "do_statement", "switch_statement", "try_statement", "with_statement", "match_statement"]);

/** Function metrics from a tree-sitter tree (JS/TS/Python grammars). */
export function functionMetrics(root: any, limit = 400): FunctionMetrics[] {
  const out: FunctionMetrics[] = [];
  const visit = (node: any, fn: FunctionMetrics | undefined, depth: number) => {
    if (out.length >= limit) return;
    let current = fn, nextDepth = depth;
    if (FUNCTIONS.has(node.type)) {
      const nameNode = node.childForFieldName?.("name") ?? (node.parent?.type === "variable_declarator" ? node.parent.childForFieldName?.("name") : node.parent?.type === "pair" ? node.parent.childForFieldName?.("key") : undefined);
      const params = node.childForFieldName?.("parameters") ?? node.childForFieldName?.("parameter");
      current = { name: nameNode?.text?.slice(0, 60) ?? "(anonymous)", line: node.startPosition.row + 1, lines: node.endPosition.row - node.startPosition.row + 1,
        params: params ? params.namedChildCount ?? 0 : 0, cyclomatic: 1, nesting: 0, async: /^async\b/.test(node.text), awaits: 0 };
      out.push(current); nextDepth = 0;
    } else if (current) {
      if (DECISIONS.has(node.type)) current.cyclomatic++;
      if (node.type === "binary_expression" && /^(?:&&|\|\||\?\?)$/.test(node.childForFieldName?.("operator")?.text ?? node.child?.(1)?.text ?? "")) current.cyclomatic++;
      if (node.type === "await_expression" || node.type === "await") current.awaits = (current.awaits ?? 0) + 1;
      if (NESTING.has(node.type)) { nextDepth = depth + 1; current.nesting = Math.max(current.nesting, nextDepth); }
    }
    for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i), current, nextDepth);
  };
  visit(root, undefined, 0);
  return out;
}
export function complexityFindings(metrics: FunctionMetrics[]): Finding[] {
  const out: Finding[] = [];
  for (const m of metrics) {
    const reasons: string[] = [];
    if (m.cyclomatic > 12) reasons.push(`cyclomatic ${m.cyclomatic}`);
    if (m.lines > 80) reasons.push(`${m.lines} lines`);
    if (m.nesting > 4) reasons.push(`nesting ${m.nesting}`);
    if (m.params > 5) reasons.push(`${m.params} parameters`);
    if (reasons.length) out.push({ rule: "complex-function", line: m.line, message: `${m.name}: ${reasons.join(", ")}; split by responsibility or extract the branches.` });
    if (m.async && !m.awaits && m.lines > 2) out.push({ rule: "async-without-await", line: m.line, message: `${m.name} is async but never awaits: drop async or await the promise it forgets.` });
  }
  return out.sort((a, b) => b.message.length - a.message.length).slice(0, 30);
}

// ─────────────────────────────── discovery ────────────────────────────────

const IGNORED_DIRS = /^(?:node_modules|\.git|\.hg|\.svn|dist|build|out|target|vendor|coverage|\.next|\.nuxt|\.svelte-kit|\.cache|__pycache__|\.venv|venv|env|\.tox|\.mypy_cache|\.pytest_cache|\.pi|\.idea|\.vscode|bower_components|third_party|site-packages|backups)$/;
const GENERATED = /(?:\.min\.[a-z]+|\.bundle\.js|\.generated\.[a-z]+|-lock\.json|\.lock|\.map|\.d\.ts)$/i;
export interface Collected { files: SourceFile[]; skipped: number; truncated: boolean; }
/** Collect supported source files under explicit paths, inside the workspace,
 * without following symlinks, within file-count and byte budgets. */
export async function collectSources(cwd: string, inputs: string[], accept: (file: string) => boolean, budget = { files: 1500, bytes: 24 * 1024 * 1024, fileBytes: 512 * 1024 }): Promise<Collected> {
  const root = await fs.realpath(cwd);
  const files: SourceFile[] = [];
  let bytes = 0, skipped = 0, truncated = false;
  const inside = (p: string) => { const r = path.relative(root, p); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };
  const add = async (abs: string) => {
    if (files.length >= budget.files || bytes >= budget.bytes) { truncated = true; return; }
    if (!accept(abs) || GENERATED.test(abs)) { skipped++; return; }
    const stat = await fs.lstat(abs).catch(() => undefined);
    if (!stat?.isFile() || stat.size > budget.fileBytes) { skipped++; return; }
    const source = await fs.readFile(abs, "utf8").catch(() => undefined);
    if (source === undefined || source.includes("\0")) { skipped++; return; }
    // Minified or data-like files: very long average lines.
    const newlines = (source.match(/\n/g) ?? []).length + 1;
    if (source.length / newlines > 400) { skipped++; return; }
    bytes += stat.size;
    files.push({ path: path.relative(root, abs) || path.basename(abs), source });
  };
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 24 || truncated) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) return;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (!IGNORED_DIRS.test(entry.name)) await walk(abs, depth + 1); }
      else if (entry.isFile()) await add(abs);
    }
  };
  for (const input of inputs.slice(0, 64)) {
    const abs = path.resolve(root, input);
    const real = await fs.realpath(abs).catch(() => undefined);
    if (!real || !inside(real)) throw new Error(`Path escapes the workspace or does not exist: ${input}`);
    const stat = await fs.stat(real);
    if (stat.isDirectory()) await walk(real, 0); else await add(real);
  }
  const unique = new Map(files.map(file => [file.path, file]));
  return { files: [...unique.values()], skipped, truncated };
}

/** Files changed against a base revision plus untracked files (read-only git). */
export async function changedFiles(cwd: string, base = "HEAD", signal?: AbortSignal): Promise<string[]> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]{0,119}$/.test(base)) throw new Error("base is not a valid revision");
  const git = (args: string[]) => exec("git", ["-c", "core.quotepath=off", ...args], { cwd, signal, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }).then(r => r.stdout);
  const tracked = await git(["diff", "--name-only", "--relative", "--diff-filter=ACMR", base, "--"]);
  const untracked = await git(["ls-files", "--others", "--exclude-standard"]);
  return [...new Set([...tracked.split("\n"), ...untracked.split("\n")].map(s => s.trim()).filter(Boolean))].slice(0, 400);
}
export const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Same-directory files of the same language family plus other paths (for
 * example files edited earlier in the session), within small budgets. Used
 * by the edit hook to spot a new block that repeats nearby code. */
export async function neighborSources(cwd: string, file: string, others: string[], budget = { files: 24, bytes: 2 * 1024 * 1024, fileBytes: 256 * 1024 }): Promise<SourceFile[]> {
  const root = await fs.realpath(cwd), family = familyOf(file);
  if (!family) return [];
  const out: SourceFile[] = [];
  let bytes = 0;
  const take = async (rel: string) => {
    if (out.length >= budget.files || bytes >= budget.bytes || rel === file || familyOf(rel) !== family || GENERATED.test(rel)) return;
    const abs = path.resolve(root, rel), relative = path.relative(root, abs);
    if (relative.startsWith("..") || path.isAbsolute(relative) || out.some(f => f.path === relative)) return;
    const stat = await fs.lstat(abs).catch(() => undefined);
    if (!stat?.isFile() || stat.size > budget.fileBytes) return;
    const source = await fs.readFile(abs, "utf8").catch(() => undefined);
    if (source === undefined || source.includes("\0")) return;
    bytes += stat.size; out.push({ path: relative, source });
  };
  for (const other of others) await take(other);
  const dir = path.dirname(path.resolve(root, file));
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) if (entry.isFile()) await take(path.relative(root, path.join(dir, entry.name)));
  return out;
}

// ─────────────────────────────── the tool ─────────────────────────────────

const CODE = (file: string) => !!familyOf(file);
const PROSE = (file: string) => /\.(?:md|mdx|markdown|txt|rst|adoc|html?)$/i.test(file);
const compactFinding = (file: string) => (f: Finding) => ({ file, line: f.line, rule: f.rule, message: f.message, ...(f.excerpt ? { excerpt: f.excerpt } : {}) });

/** Run one code_quality operation. Results are bounded, located and advisory. */
export async function codeQuality(params: any, cwd: string, signal?: AbortSignal, parserFor?: (ext: string) => Promise<any>) {
  const operation = params.operation;
  if (!["duplicates", "slop", "prose", "complexity"].includes(operation)) throw new Error("operation must be duplicates, slop, prose or complexity");
  const limit = Math.max(1, Math.min(80, Number.isInteger(params.limit) ? params.limit : 25));
  const changed = params.changed === true ? await changedFiles(cwd, params.base ?? "HEAD", signal) : undefined;
  const accept = operation === "prose" ? PROSE : CODE;
  const inputs: string[] = Array.isArray(params.paths) && params.paths.length ? params.paths.slice(0, 64).map(String) : [];
  if (operation === "duplicates") {
    // Index the whole requested scope; report clones that touch the focus.
    const scope = await collectSources(cwd, inputs.length ? inputs : ["."], accept);
    const focus = changed ? new Set(changed.filter(accept)) : undefined;
    if (changed && !focus!.size) return { operation, changed: 0, note: "No changed source files against the base revision." };
    const report = findDuplicates(scope.files, { minTokens: params.minTokens, minLines: params.minLines, mode: params.mode, focus, limit });
    return {
      operation, scope: { files: report.files, tokens: report.tokens, skipped: scope.skipped, truncated: scope.truncated || report.truncated, ...(focus ? { focus: focus.size } : {}) },
      duplicatedLines: report.duplicatedLines, duplicatedPercent: report.duplicatedPercent,
      groups: report.groups.map(group => ({ occurrences: group.occurrences.map(o => `${o.path}:${o.start}-${o.end}`), lines: group.lines, kind: group.kind, ...(group.repetitive ? { repetitive: "overlapping copies of one pattern: consider a loop or table" } : {}) })),
      clones: report.clones.slice(0, limit).map(clone => ({ a: `${clone.a.path}:${clone.a.start}-${clone.a.end}`, b: `${clone.b.path}:${clone.b.start}-${clone.b.end}`, lines: clone.lines, tokens: clone.tokens, kind: clone.kind, ...(clone.renamed.length ? { renamed: clone.renamed } : {}), preview: clone.preview })),
      byFile: report.byFile.slice(0, 10),
      note: "Token clones (renamed mode ignores identifier and literal differences). Extract a shared function, component or constant when the copies must change together; leave coincidental or deliberately independent code alone (tests, generated code, protocol tables).",
    };
  }
  const targets = changed ? changed.filter(accept) : [];
  const scope = await collectSources(cwd, changed ? (targets.length ? targets : []) : inputs.length ? inputs : ["."], accept, { files: operation === "prose" ? 200 : 400, bytes: 12 * 1024 * 1024, fileBytes: 512 * 1024 });
  if (changed && !targets.length) return { operation, changed: 0, note: "No changed files of this kind against the base revision." };
  if (operation === "prose") {
    const files = scope.files.map(file => ({ file: file.path, report: proseReport(file.source) })).filter(row => row.report.words >= 30);
    const worst = [...files].sort((a, b) => b.report.findings.length / Math.max(1, b.report.words) - a.report.findings.length / Math.max(1, a.report.words));
    return {
      operation, scope: { files: files.length, skipped: scope.skipped, truncated: scope.truncated },
      files: worst.slice(0, limit).map(({ file, report }) => ({ file, words: report.words, readingEase: report.readingEase, grade: report.grade, averageSentence: report.averageSentence, longSentences: report.longSentences,
        passivePercent: report.passiveShare, hedgesPer100: report.hedgesPer100, fillersPer100: report.fillersPer100, emDashesPer100: report.emDashesPer100, exclamations: report.exclamations,
        phrases: report.phrases.slice(0, 8), findings: report.findings.slice(0, 12).map(compactFinding(file)) })),
      note: "Reading ease: 60–70 is plain English, below 30 is dense. Stock phrases are replaced with specific claims, not synonyms. This measures prose patterns, not authorship or correctness.",
    };
  }
  if (operation === "slop") {
    // Per-line rules that can repeat dozens of times in one file are folded
    // into one finding per file so rarer, sharper findings stay visible.
    const FOLD = new Set(["type-escape", "repeated-literal"]);
    const findings = scope.files.flatMap(file => {
      const all = [...codeSlop(file.path, file.source), ...unusedImports(file.path, file.source)];
      const folded = [...FOLD].flatMap(rule => { const hits = all.filter(f => f.rule === rule); return hits.length > 2 ? [{ rule, line: hits[0].line, message: `${hits.length}× ${rule} (first ${hits.slice(0, 4).map(h => `L${h.line}`).join(", ")}): ${hits[0].message}` }] : hits; });
      return [...all.filter(f => !FOLD.has(f.rule)), ...folded].map(compactFinding(file.path));
    });
    const counts: Record<string, number> = {};
    for (const f of findings) counts[f.rule] = (counts[f.rule] ?? 0) + 1;
    return { operation, scope: { files: scope.files.length, skipped: scope.skipped, truncated: scope.truncated }, counts, findings: findings.slice(0, limit * 2),
      note: "Advisory patterns (placeholders, debug leftovers, swallowed errors, redundant booleans, dead code, type escapes, repeated literals, unused imports). Keep intentional cases; fix the rest at the source." };
  }
  // complexity
  if (!parserFor) throw new Error("Complexity needs the installed tree-sitter grammars");
  const rows: any[] = [];
  let unsupported = 0;
  for (const file of scope.files) {
    signal?.throwIfAborted();
    const parser = await parserFor(path.extname(file.path).toLowerCase()).catch(() => null);
    if (!parser) { unsupported++; continue; }
    const tree = parser.parse(file.source);
    try { for (const m of functionMetrics(tree.rootNode)) rows.push({ file: file.path, ...m }); } finally { tree.delete?.(); }
  }
  rows.sort((a, b) => b.cyclomatic * Math.log2(2 + b.lines) - a.cyclomatic * Math.log2(2 + a.lines));
  const findings = scope.files.flatMap(file => complexityFindings(rows.filter(r => r.file === file.path)).map(compactFinding(file.path)));
  return { operation, scope: { files: scope.files.length - unsupported, unsupported, functions: rows.length, truncated: scope.truncated },
    hotspots: rows.slice(0, limit).map(r => ({ at: `${r.file}:${r.line}`, name: r.name, cyclomatic: r.cyclomatic, lines: r.lines, nesting: r.nesting, params: r.params })),
    findings: findings.slice(0, limit),
    note: "JS/TS/Python via tree-sitter. Cyclomatic counts decision points; thresholds (12, 80 lines, nesting 4, 5 params) mark candidates for splitting, not defects." };
}
