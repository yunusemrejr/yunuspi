/** A small spreadsheet formula evaluator for the formulas models actually write.
 *
 * It exists so a workbook can be saved with real cached results (previewers, pandas and
 * mail clients show cached values, not formulas) and so a formula that evaluates to an
 * error is caught while building, not discovered by the reader. Supported: numbers,
 * strings, TRUE/FALSE, cell and range references (A1, $A$1, A1:B9, Sheet2!A1, 'My Sheet'!A1),
 * + - * / ^ & comparison operators, unary minus, percent literals, and the functions
 * SUM AVERAGE MIN MAX COUNT COUNTA ROUND ABS IF IFERROR AND OR NOT SUMPRODUCT? (no) CONCAT LEN.
 * Anything else yields `unsupported` so the caller leaves the cell uncached instead of guessing. */

export type CellValue = number | string | boolean | null;
export type FormulaResult = { ok: true; value: number | string | boolean } | { ok: false; error: string; unsupported?: boolean };
/** A cell is its value, or (for a formula cell the caller has not computed) its formula, or a settled error. */
export type SheetLookup = (sheet: string | undefined, col: number, row: number) => CellValue | { formula: string } | { error: string; unsupported?: boolean };

type Token = { t: "num" | "str" | "id" | "op" | "ref" | "range"; v: string };
const FUNCTIONS = new Set(["SUM", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA", "ROUND", "ABS", "IF", "IFERROR", "AND", "OR", "NOT", "CONCAT", "LEN"]);

export const columnNumber = (letters: string): number => { let n = 0; for (const ch of letters.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n; };
export const columnName = (index: number): string => { let out = ""; for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + (n - 1) % 26) + out; return out; };

function tokenize(source: string): Token[] {
  const tokens: Token[] = []; let i = 0;
  const text = source.startsWith("=") ? source.slice(1) : source;
  const refPart = String.raw`\$?[A-Za-z]{1,3}\$?\d+`;
  const sheetPart = String.raw`(?:'(?:[^']|'')+'|[A-Za-z_][\w.]*)!`;
  const range = new RegExp(String.raw`^(?:${sheetPart})?${refPart}:${refPart}`), ref = new RegExp(String.raw`^(?:${sheetPart})?${refPart}(?![\w(])`);
  while (i < text.length) {
    const rest = text.slice(i), ch = text[i];
    if (/\s/.test(ch)) { i++; continue; }
    let m: RegExpExecArray | null;
    if ((m = range.exec(rest))) { tokens.push({ t: "range", v: m[0] }); i += m[0].length; continue; }
    if ((m = ref.exec(rest))) { tokens.push({ t: "ref", v: m[0] }); i += m[0].length; continue; }
    if ((m = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?%?/.exec(rest))) { tokens.push({ t: "num", v: m[0] }); i += m[0].length; continue; }
    if (ch === '"') { let j = i + 1, out = ""; while (j < text.length && !(text[j] === '"' && text[j + 1] !== '"')) { if (text[j] === '"') j++; out += text[j]; j++; } tokens.push({ t: "str", v: out }); i = j + 1; continue; }
    if ((m = /^[A-Za-z_][\w.]*/.exec(rest))) { tokens.push({ t: "id", v: m[0] }); i += m[0].length; continue; }
    if ((m = /^(?:<=|>=|<>|[-+*/^&=<>(),%])/.exec(rest))) { tokens.push({ t: "op", v: m[0] }); i += m[0].length; continue; }
    throw new Error(`Unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Unsupported extends Error {}
class FormulaError extends Error {}

export function evaluateFormula(formula: string, lookup: SheetLookup, currentSheet?: string, depth = 0): FormulaResult {
  if (depth > 40) return { ok: false, error: "#REF!" };
  let tokens: Token[];
  try { tokens = tokenize(formula); } catch (error) { return { ok: false, error: "#NAME?", unsupported: true }; }
  let at = 0;
  const peek = () => tokens[at], next = () => tokens[at++];
  const accept = (value: string) => { if (peek()?.t === "op" && peek()!.v === value) { at++; return true; } return false; };
  const parseRef = (token: string): { sheet?: string; col: number; row: number } => {
    const bang = token.lastIndexOf("!"), sheet = bang >= 0 ? token.slice(0, bang).replace(/^'|'$/g, "").replace(/''/g, "'") : undefined;
    const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(token.slice(bang + 1))!;
    return { sheet, col: columnNumber(m[1]), row: Number(m[2]) };
  };
  const cell = (sheet: string | undefined, col: number, row: number): CellValue => {
    const raw = lookup(sheet ?? currentSheet, col, row);
    if (raw !== null && typeof raw === "object") {
      if ("error" in raw) { if (raw.unsupported) throw new Unsupported(); throw new FormulaError(raw.error); }
      const inner = evaluateFormula(raw.formula, lookup, sheet ?? currentSheet, depth + 1);
      if (!inner.ok) { if (inner.unsupported) throw new Unsupported(); throw new FormulaError(inner.error); }
      return inner.value;
    }
    return raw;
  };
  const rangeCells = (token: string): CellValue[] => {
    const [a, b] = token.slice(token.lastIndexOf("!") + 1).split(":"), prefix = token.includes("!") ? token.slice(0, token.lastIndexOf("!") + 1) : "";
    const from = parseRef(prefix + a), to = parseRef(prefix + b), out: CellValue[] = [];
    if ((Math.abs(to.row - from.row) + 1) * (Math.abs(to.col - from.col) + 1) > 20000) throw new Unsupported();
    for (let r = Math.min(from.row, to.row); r <= Math.max(from.row, to.row); r++) for (let c = Math.min(from.col, to.col); c <= Math.max(from.col, to.col); c++) out.push(cell(from.sheet, c, r));
    return out;
  };
  const number = (value: CellValue): number => {
    if (typeof value === "number") return value; if (typeof value === "boolean") return value ? 1 : 0; if (value === null || value === "") return 0;
    const parsed = Number(value); if (Number.isFinite(parsed)) return parsed; throw new FormulaError("#VALUE!");
  };
  type Arg = CellValue | CellValue[];
  const flatten = (args: Arg[]): CellValue[] => args.flatMap(arg => Array.isArray(arg) ? arg : [arg]);
  const numeric = (args: Arg[]): number[] => args.flatMap(arg => Array.isArray(arg) ? arg.filter((v): v is number => typeof v === "number") : [number(arg)]);
  const call = (name: string, args: Arg[]): CellValue => {
    switch (name) {
      case "SUM": return numeric(args).reduce((a, b) => a + b, 0);
      case "AVERAGE": { const n = numeric(args); if (!n.length) throw new FormulaError("#DIV/0!"); return n.reduce((a, b) => a + b, 0) / n.length; }
      case "MIN": { const n = numeric(args); return n.length ? Math.min(...n) : 0; }
      case "MAX": { const n = numeric(args); return n.length ? Math.max(...n) : 0; }
      case "COUNT": return flatten(args).filter(v => typeof v === "number").length;
      case "COUNTA": return flatten(args).filter(v => v !== null && v !== "").length;
      case "ROUND": { const digits = args[1] === undefined ? 0 : number(args[1] as CellValue), f = 10 ** digits, v = number(args[0] as CellValue) * f; return (Math.sign(v) * Math.round(Math.abs(v))) / f; }
      case "ABS": return Math.abs(number(args[0] as CellValue));
      case "LEN": return String(flatten(args)[0] ?? "").length;
      case "CONCAT": return flatten(args).map(v => v ?? "").join("");
      case "NOT": return !truthy(args[0] as CellValue);
      case "AND": return flatten(args).every(truthy);
      case "OR": return flatten(args).some(truthy);
      default: throw new Unsupported();
    }
  };
  const truthy = (value: CellValue): boolean => typeof value === "boolean" ? value : typeof value === "number" ? value !== 0 : typeof value === "string" ? value.toUpperCase() === "TRUE" : false;

  // Precedence climbing: comparison < concat < additive < multiplicative < power < unary < postfix percent.
  const comparison = (): CellValue => {
    let left = concat();
    for (;;) {
      const op = peek(); if (op?.t !== "op" || !["=", "<>", "<", ">", "<=", ">="].includes(op.v)) return left;
      next(); const right = concat();
      const a = typeof left === "string" && typeof right === "string" ? left.toLowerCase() : left, b = typeof left === "string" && typeof right === "string" ? right.toLowerCase() : right;
      left = op.v === "=" ? a === b : op.v === "<>" ? a !== b : op.v === "<" ? (a as number) < (b as number) : op.v === ">" ? (a as number) > (b as number) : op.v === "<=" ? (a as number) <= (b as number) : (a as number) >= (b as number);
    }
  };
  const concat = (): CellValue => { let left = additive(); while (accept("&")) left = `${left ?? ""}${additive() ?? ""}`; return left; };
  const additive = (): CellValue => { let left = term(); for (;;) { if (accept("+")) left = number(left) + number(term()); else if (accept("-")) left = number(left) - number(term()); else return left; } };
  const term = (): CellValue => { let left = power(); for (;;) { if (accept("*")) left = number(left) * number(power()); else if (accept("/")) { const d = number(power()); if (d === 0) throw new FormulaError("#DIV/0!"); left = number(left) / d; } else return left; } };
  const power = (): CellValue => { const base = unary(); return accept("^") ? number(base) ** number(power()) : base; };
  const unary = (): CellValue => { if (accept("-")) return -number(unary()); if (accept("+")) return number(unary()); return postfix(); };
  const postfix = (): CellValue => { let value = primary(); while (accept("%")) value = number(value) / 100; return value; };
  const primary = (): CellValue => {
    const token = next();
    if (!token) throw new Error("Unexpected end of formula");
    if (token.t === "num") return token.v.endsWith("%") ? Number(token.v.slice(0, -1)) / 100 : Number(token.v);
    if (token.t === "str") return token.v;
    if (token.t === "ref") { const r = parseRef(token.v); return cell(r.sheet, r.col, r.row); }
    if (token.t === "range") throw new Unsupported();
    if (token.t === "op" && token.v === "(") { const value = comparison(); if (!accept(")")) throw new Error("Missing )"); return value; }
    if (token.t === "id") {
      const upper = token.v.toUpperCase();
      if (upper === "TRUE") return true; if (upper === "FALSE") return false;
      if (!accept("(")) throw new Unsupported();
      if (!FUNCTIONS.has(upper)) throw new Unsupported();
      if (upper === "IF" || upper === "IFERROR") return lazyCall(upper);
      const args: Arg[] = [];
      if (!accept(")")) { do { const p = peek(); args.push(p?.t === "range" ? (next(), rangeCells(p.v)) : comparison()); } while (accept(",")); if (!accept(")")) throw new Error("Missing )"); }
      return call(upper, args);
    }
    throw new Error(`Unexpected ${token.v}`);
  };
  // IF/IFERROR evaluate only the branch they need, so the untaken branch cannot raise an error.
  const lazyCall = (name: string): CellValue => {
    const starts: number[] = [at]; let nesting = 0;
    for (let i = at; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.t === "op" && t.v === "(") nesting++;
      else if (t.t === "op" && t.v === ")") { if (nesting === 0) { starts.push(i + 1); break; } nesting--; }
      else if (t.t === "op" && t.v === "," && nesting === 0) starts.push(i + 1);
    }
    if (starts.length < 2) throw new Error("Missing )");
    const end = starts[starts.length - 1], bounds = starts.slice(0, -1).map((s, i) => [s, (starts[i + 1] ?? end) - 1] as const);
    const run = (index: number): CellValue => { const [from, to] = bounds[index]; const saved = at; at = from; const slice = tokens.slice(0, to); const original = tokens; tokens = slice; try { return comparison(); } finally { tokens = original; at = saved; } };
    try {
      if (name === "IF") { const result = truthy(run(0)) ? (bounds[1] ? run(1) : true) : (bounds[2] ? run(2) : false); at = end; return result; }
      try { const value = run(0); at = end; return value; } catch (error) { if (error instanceof FormulaError) { const value = bounds[1] ? run(1) : ""; at = end; return value; } throw error; }
    } finally { at = end; }
  };
  try {
    const value = comparison();
    if (at < tokens.length) return { ok: false, error: "#NAME?", unsupported: true };
    if (value === null) return { ok: true, value: 0 };
    return { ok: true, value };
  } catch (error) {
    if (error instanceof FormulaError) return { ok: false, error: error.message };
    return { ok: false, error: "#NAME?", unsupported: true };
  }
}
