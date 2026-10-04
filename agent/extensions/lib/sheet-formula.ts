/** A spreadsheet formula evaluator for the formulas models actually write.
 *
 * It exists so a workbook can be saved with real cached results (previewers, pandas and
 * mail clients show cached values, not formulas) and so a formula that evaluates to an
 * error is caught while building, not discovered by the reader. Supported: numbers,
 * strings, TRUE/FALSE, cell and range references (A1, $A$1, A1:B9, A:A, Sheet2!A1,
 * 'My Sheet'!A1:B9), + - * / ^ & comparison operators, unary minus, percent literals, and
 *   math      SUM AVERAGE MIN MAX COUNT COUNTA COUNTBLANK PRODUCT MEDIAN STDEV STDEV.S STDEV.P VAR VAR.S VAR.P LARGE SMALL ROUND ROUNDUP ROUNDDOWN INT MOD POWER SQRT ABS SIGN CEILING FLOOR EXP LN PI SUMPRODUCT
 *   criteria  SUMIF SUMIFS COUNTIF COUNTIFS AVERAGEIF AVERAGEIFS MAXIFS MINIFS
 *   logic     IF IFS IFERROR IFNA SWITCH CHOOSE AND OR NOT ISBLANK ISNUMBER ISTEXT ISERROR
 *   text      CONCAT CONCATENATE TEXTJOIN LEN LEFT RIGHT MID UPPER LOWER PROPER TRIM SUBSTITUTE REPT FIND SEARCH EXACT VALUE TEXT
 *   date      DATE YEAR MONTH DAY EDATE EOMONTH DAYS WEEKDAY
 *   lookup    VLOOKUP HLOOKUP INDEX MATCH XLOOKUP
 * Anything else (volatile TODAY and NOW, array formulas, user functions) yields `unsupported`
 * so the caller leaves the cell uncached instead of guessing; Excel and LibreOffice recalculate
 * it on open. Comparison and criteria follow Excel: case-insensitive text, a blank equals "" and 0,
 * criteria such as ">=10", "<>x" and "ab*". Date serials use the 1900 system (1900-03-01 onward). */

export type CellValue = number | string | boolean | null;
export type FormulaResult = { ok: true; value: number | string | boolean } | { ok: false; error: string; unsupported?: boolean };
/** A cell is its value, or (for a formula cell the caller has not computed) its formula, or a settled error. */
export type SheetLookup = (sheet: string | undefined, col: number, row: number) => CellValue | { formula: string } | { error: string; unsupported?: boolean };
/** Used rows and columns of a sheet; whole-column references such as A:A need it and are unsupported without it. */
export type SheetExtent = (sheet: string | undefined) => { rows: number; cols: number } | undefined;

type Token = { t: "num" | "str" | "id" | "op" | "ref" | "range"; v: string };
type Grid = CellValue[] & { rows: number; cols: number };
type Arg = CellValue | Grid;

export const columnNumber = (letters: string): number => { let n = 0; for (const ch of letters.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n; };
export const columnName = (index: number): string => { let out = ""; for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + (n - 1) % 26) + out; return out; };

/** Functions Excel added after 2007. A file must store them as _xlfn.NAME( or Excel shows #NAME? until each cell is re-entered. */
const FUTURE = ["IFNA", "IFS", "SWITCH", "MAXIFS", "MINIFS", "CONCAT", "TEXTJOIN", "XLOOKUP", "XMATCH", "DAYS", "ISOWEEKNUM", "NUMBERVALUE", "XOR", "FORMULATEXT", "ISFORMULA", "STDEV.S", "STDEV.P", "VAR.S", "VAR.P", "RANK.EQ", "RANK.AVG",
  "PERCENTILE.INC", "PERCENTILE.EXC", "QUARTILE.INC", "QUARTILE.EXC", "NORM.DIST", "NORM.INV", "NORM.S.DIST", "NORM.S.INV", "CEILING.MATH", "FLOOR.MATH", "MODE.SNGL", "COVARIANCE.S", "COVARIANCE.P"];
/** Dynamic-array functions: besides the prefix they need array metadata a file written outside Excel cannot carry, so they are only reported. */
const DYNAMIC = ["UNIQUE", "SEQUENCE", "FILTER", "SORT", "SORTBY", "RANDARRAY", "LET", "LAMBDA", "TEXTBEFORE", "TEXTAFTER", "TEXTSPLIT", "VSTACK", "HSTACK", "TAKE", "DROP", "TOCOL", "TOROW", "CHOOSECOLS", "CHOOSEROWS"];
const callPattern = (names: string[]) => new RegExp(`(?<![\\w.])(${names.map(name => name.replace(/\./g, "\\.")).join("|")})\\(`, "gi");
const FUTURE_CALL = callPattern(FUTURE), DYNAMIC_CALL = callPattern(DYNAMIC);
const outsideStrings = (formula: string, edit: (part: string) => string): string => formula.split(/("(?:[^"]|"")*")/).map((part, index) => index % 2 ? part : edit(part)).join("");
/** Names of post-2007 functions this formula calls without the _xlfn. prefix (strings and already prefixed calls are ignored). */
export function unprefixedFutureFunctions(formula: string): string[] {
  const found = new Set<string>();
  outsideStrings(formula, part => { for (const re of [FUTURE_CALL, DYNAMIC_CALL]) { re.lastIndex = 0; for (const m of part.matchAll(re)) found.add(m[1].toUpperCase()); } return part; });
  return [...found];
}
export const dynamicArrayFunctions = (formula: string): string[] => unprefixedFutureFunctions(formula).filter(name => DYNAMIC.includes(name));
/** The form a file must store: IFS( becomes _xlfn.IFS( (calls inside text literals are left alone). */
export const prefixFutureFunctions = (formula: string): string => outsideStrings(formula, part => part.replace(FUTURE_CALL, (_whole, name: string) => `_xlfn.${name.toUpperCase()}(`));
/** True when the whole formula is one call to a function in `names`: DATE(2024,1,1) yes, DATE(2024,3,1)-DATE(2024,2,1) no. */
function isSingleCall(formula: string, names: RegExp): boolean {
  const text = formula.trim(), open = text.indexOf("(");
  if (open < 1 || !text.endsWith(")") || !names.test(text.slice(0, open).trim())) return false;
  let depth = 0, inText = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { if (inText && text[i + 1] === '"') i++; else inText = !inText; continue; }
    if (inText) continue;
    if (ch === "(") depth++; else if (ch === ")" && --depth === 0) return i === text.length - 1;
  }
  return false;
}
/** A formula that returns a date shows as a serial number unless the cell has a date format; the application sets that when a person types the formula, a file does not. */
export const inferFormulaFormat = (formula: string): "date" | "datetime" | undefined => isSingleCall(formula, /^(?:DATE|EDATE|EOMONTH)$/i) ? "date" : isSingleCall(formula, /^NOW$/i) ? "datetime" : undefined;

function tokenize(source: string): Token[] {
  const tokens: Token[] = []; let i = 0;
  const text = source.startsWith("=") ? source.slice(1) : source;
  const refPart = String.raw`\$?[A-Za-z]{1,3}\$?\d+`, colPart = String.raw`\$?[A-Za-z]{1,3}`;
  const sheetPart = String.raw`(?:'(?:[^']|'')+'|[A-Za-z_][\w.]*)!`;
  const range = new RegExp(String.raw`^(?:${sheetPart})?${refPart}:${refPart}`), ref = new RegExp(String.raw`^(?:${sheetPart})?${refPart}(?![\w(])`);
  const columns = new RegExp(String.raw`^(?:${sheetPart})?${colPart}:${colPart}(?![\w(])`);
  while (i < text.length) {
    const rest = text.slice(i), ch = text[i];
    if (/\s/.test(ch)) { i++; continue; }
    let m: RegExpExecArray | null;
    if ((m = range.exec(rest)) || (m = columns.exec(rest))) { tokens.push({ t: "range", v: m[0] }); i += m[0].length; continue; }
    if ((m = ref.exec(rest))) { tokens.push({ t: "ref", v: m[0] }); i += m[0].length; continue; }
    if ((m = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?%?/.exec(rest)) || (m = /^\.\d+%?/.exec(rest))) { tokens.push({ t: "num", v: m[0] }); i += m[0].length; continue; }
    if (ch === '"') { let j = i + 1, out = ""; while (j < text.length && !(text[j] === '"' && text[j + 1] !== '"')) { if (text[j] === '"') j++; out += text[j]; j++; } tokens.push({ t: "str", v: out }); i = j + 1; continue; }
    if ((m = /^[A-Za-z_][\w.]*/.exec(rest))) { tokens.push({ t: "id", v: m[0] }); i += m[0].length; continue; }
    if ((m = /^(?:<=|>=|<>|[-+*/^&=<>(),%])/.exec(rest))) { tokens.push({ t: "op", v: m[0] }); i += m[0].length; continue; }
    throw new Error(`Unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Unsupported extends Error {}
class FormulaError extends Error {}
const fail = (code: string): never => { throw new FormulaError(code); };

/** General number format: up to 15 significant digits, so 0.1+0.2 reads 0.3 as it does in a spreadsheet. */
const general = (n: number): string => Number.isFinite(n) ? String(Number(n.toPrecision(15))) : fail("#NUM!");
const toText = (v: CellValue): string => v === null ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : typeof v === "number" ? general(v) : v;
const truthy = (value: CellValue): boolean => typeof value === "boolean" ? value : typeof value === "number" ? value !== 0 : typeof value === "string" ? value.toUpperCase() === "TRUE" : false;
const isGrid = (arg: Arg): arg is Grid => Array.isArray(arg);
const asNumber = (value: CellValue): number => {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === null || value === "") return 0;
  const parsed = Number(value.trim());
  return value.trim() !== "" && Number.isFinite(parsed) ? parsed : fail("#VALUE!");
};
const scalar = (arg: Arg): CellValue => isGrid(arg) ? (arg.length === 1 ? arg[0] : fail("#VALUE!")) : arg;
const flat = (args: Arg[]): CellValue[] => args.flatMap(arg => isGrid(arg) ? [...arg] : [arg]);
/** Numbers inside a range or reference are the cells that are numbers; a literal argument is coerced. */
const numbers = (args: Arg[]): number[] => args.flatMap(arg => isGrid(arg) ? arg.filter((v): v is number => typeof v === "number") : [asNumber(arg)]);
const rank = (v: CellValue): number => typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2;
/** Spreadsheet ordering: numbers < text < booleans, text case-insensitive; a blank is 0 against a number and "" against text. */
function compare(left: CellValue, right: CellValue): number {
  let a = left, b = right;
  if (a === null && b === null) return 0;
  if (a === null) a = typeof b === "string" ? "" : typeof b === "boolean" ? false : 0;
  if (b === null) b = typeof a === "string" ? "" : typeof a === "boolean" ? false : 0;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (typeof a === "string") { const x = a.toLowerCase(), y = (b as string).toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
  return Number(a) - Number(b);
}
const same = (a: CellValue, b: CellValue) => compare(a, b) === 0;

/** COUNTIF-style criteria: a value, or text such as ">=10", "<>x", "=", "ab*". */
function criterion(value: CellValue): (cell: CellValue) => boolean {
  if (typeof value === "number") return cell => (typeof cell === "number" && cell === value) || (typeof cell === "string" && cell.trim() !== "" && Number(cell) === value);
  if (typeof value === "boolean") return cell => cell === value;
  const text = value === null ? "" : value;
  const op = /^(<=|>=|<>|<|>|=)/.exec(text)?.[1] ?? "", operand = text.slice(op.length);
  const numeric = operand.trim() !== "" && Number.isFinite(Number(operand)) ? Number(operand) : undefined;
  if (op === "" || op === "=" || op === "<>") {
    let test: (cell: CellValue) => boolean;
    if (operand === "") test = cell => cell === null || cell === "";
    else if (numeric !== undefined) test = cell => (typeof cell === "number" && cell === numeric) || (typeof cell === "string" && cell.trim() !== "" && Number(cell) === numeric);
    else {
      const source = operand.replace(/~([*?~])|[.+^${}()|[\]\\]|\*|\?/g, (whole, escaped?: string) => escaped ? `\\${escaped}` : whole === "*" ? "[\\s\\S]*" : whole === "?" ? "[\\s\\S]" : `\\${whole}`);
      const pattern = new RegExp(`^${source}$`, "i");
      test = cell => cell !== null && pattern.test(toText(cell));
    }
    return op === "<>" ? cell => !test(cell) : test;
  }
  if (numeric !== undefined) return cell => typeof cell === "number" && (op === "<" ? cell < numeric : op === ">" ? cell > numeric : op === "<=" ? cell <= numeric : cell >= numeric);
  return cell => typeof cell === "string" && (op === "<" ? compare(cell, operand) < 0 : op === ">" ? compare(cell, operand) > 0 : op === "<=" ? compare(cell, operand) <= 0 : compare(cell, operand) >= 0);
}

const SERIAL_EPOCH = Date.UTC(1899, 11, 30);
const toSerial = (year: number, month: number, day: number): number => Math.floor((Date.UTC(year, month - 1, day) - SERIAL_EPOCH) / 86_400_000);
function fromSerial(serial: number): Date {
  if (serial < 61) throw new Unsupported(); // before 1900-03-01 the 1900 leap-year quirk applies and is not modelled
  return new Date(SERIAL_EPOCH + Math.floor(serial) * 86_400_000);
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** TEXT(value, format) for the date and number formats that occur in practice; anything else is unsupported. */
function formatText(input: CellValue, pattern: string): string {
  let value = input;
  if (typeof value === "string") { if (value.trim() !== "" && Number.isFinite(Number(value))) value = Number(value); else return value; }
  const amount = asNumber(value);
  const literals: string[] = [];
  const format = pattern.split(";")[0].replace(/"([^"]*)"/g, (_whole, text: string) => `\u0001${literals.push(text) - 1}\u0002`);
  const restore = (text: string) => text.replace(/\u0001(\d+)\u0002/g, (_whole, index: string) => literals[Number(index)]);
  if (/[ymd]/i.test(format.replace(/\u0001\d+\u0002/g, ""))) {
    const when = fromSerial(amount);
    return restore(format.replace(/yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d/gi, (token) => {
      const t = token.toLowerCase();
      return t === "yyyy" ? String(when.getUTCFullYear()) : t === "yy" ? String(when.getUTCFullYear()).slice(-2) : t === "mmmm" ? MONTHS[when.getUTCMonth()] : t === "mmm" ? MONTHS[when.getUTCMonth()].slice(0, 3)
        : t === "mm" ? String(when.getUTCMonth() + 1).padStart(2, "0") : t === "m" ? String(when.getUTCMonth() + 1) : t === "dddd" ? WEEKDAYS[when.getUTCDay()] : t === "ddd" ? WEEKDAYS[when.getUTCDay()].slice(0, 3)
        : t === "dd" ? String(when.getUTCDate()).padStart(2, "0") : String(when.getUTCDate());
    }));
  }
  if (/e[+-]/i.test(format) || /[?/]/.test(format)) throw new Unsupported();
  const first = format.search(/[0#.]/), last = Math.max(format.lastIndexOf("0"), format.lastIndexOf("#"));
  if (first < 0 || last < first) throw new Unsupported();
  const prefix = format.slice(0, first), core = format.slice(first, last + 1), suffix = format.slice(last + 1);
  const percent = (prefix + suffix).includes("%"), [integerPattern, fractionPattern = ""] = core.split(".");
  const decimals = fractionPattern.length, optional = (fractionPattern.match(/#+$/) ?? [""])[0].length, minimum = (integerPattern.match(/0/g) ?? []).length;
  const scaled = percent ? amount * 100 : amount, factor = 10 ** decimals;
  const rounded = (Math.sign(scaled) * Math.round(Number((Math.abs(scaled) * factor).toPrecision(15)))) / factor;
  let [whole, fraction = ""] = Math.abs(rounded).toFixed(decimals).split(".");
  for (let trim = 0; trim < optional && fraction.endsWith("0"); trim++) fraction = fraction.slice(0, -1);
  whole = whole.padStart(minimum, "0"); if (whole === "0" && minimum === 0 && fraction) whole = "";
  if (integerPattern.includes(",")) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return restore(`${rounded < 0 ? "-" : ""}${prefix}${whole}${fraction ? `.${fraction}` : ""}${suffix}`);
}

export function evaluateFormula(formula: string, lookup: SheetLookup, currentSheet?: string, depth = 0, extent?: SheetExtent): FormulaResult {
  if (depth > 40) return { ok: false, error: "#REF!" };
  let tokens: Token[];
  try { tokens = tokenize(formula); } catch { return { ok: false, error: "#NAME?", unsupported: true }; }
  let at = 0;
  const peek = (offset = 0) => tokens[at + offset], next = () => tokens[at++];
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
      const inner = evaluateFormula(raw.formula, lookup, sheet ?? currentSheet, depth + 1, extent);
      if (!inner.ok) { if (inner.unsupported) throw new Unsupported(); throw new FormulaError(inner.error); }
      return inner.value;
    }
    return raw;
  };
  const single = (value: CellValue): Grid => Object.assign([value], { rows: 1, cols: 1 }) as unknown as Grid;
  const asGrid = (arg: Arg): Grid => isGrid(arg) ? arg : single(arg);
  const grid = (token: string): Grid => {
    const bang = token.lastIndexOf("!"), prefix = bang >= 0 ? token.slice(0, bang + 1) : "", [a, b] = token.slice(bang + 1).split(":");
    let from: { sheet?: string; col: number; row: number }, to: { sheet?: string; col: number; row: number };
    if (/\d/.test(a)) { from = parseRef(prefix + a); to = parseRef(prefix + b); }
    else {
      const sheet = prefix ? parseRef(`${prefix}A1`).sheet : undefined, size = extent?.(sheet ?? currentSheet);
      if (!size) throw new Unsupported();
      from = { sheet, col: columnNumber(a.replace("$", "")), row: 1 }; to = { sheet, col: columnNumber(b.replace("$", "")), row: Math.max(size.rows, 1) };
    }
    const top = Math.min(from.row, to.row), bottom = Math.max(from.row, to.row), left = Math.min(from.col, to.col), right = Math.max(from.col, to.col);
    if ((bottom - top + 1) * (right - left + 1) > 50000) throw new Unsupported();
    const out = [] as unknown as Grid;
    for (let r = top; r <= bottom; r++) for (let c = left; c <= right; c++) out.push(cell(from.sheet, c, r));
    out.rows = bottom - top + 1; out.cols = right - left + 1;
    return out;
  };
  const at2 = (g: Grid, r: number, c: number): CellValue => g[r * g.cols + c];
  const sameShape = (a: Grid, b: Grid) => a.rows === b.rows && a.cols === b.cols;
  /** Cells of the first range that satisfy every (range, criterion) pair that follows it. */
  const matching = (pairs: Arg[]): boolean[] => {
    const first = asGrid(pairs[0]), hits = first.map(() => true);
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const tested = asGrid(pairs[i]);
      if (!sameShape(first, tested)) fail("#VALUE!");
      const test = criterion(scalar(pairs[i + 1]));
      tested.forEach((v, index) => { if (!test(v)) hits[index] = false; });
    }
    return hits;
  };
  const pick = (values: Arg, hits: boolean[]): number[] => { const g = asGrid(values); if (g.length !== hits.length) fail("#VALUE!"); return g.flatMap((v, i) => hits[i] && typeof v === "number" ? [v] : []); };
  /** Numbers of `values` aligned with `target` (the first cell of `values` lines up with the first of `target`). */
  const aligned = (target: Grid, test: (cell: CellValue) => boolean, values: Grid): number[] => target.flatMap((v, i) => {
    if (!test(v)) return [];
    const r = Math.floor(i / target.cols), c = i % target.cols, s = r < values.rows && c < values.cols ? at2(values, r, c) : null;
    return typeof s === "number" ? [s] : [];
  });
  const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
  const lookupRow = (key: CellValue, keys: CellValue[], approximate: boolean): number => {
    if (!approximate) {
      const wildcard = typeof key === "string" && /[*?]/.test(key) ? criterion(key) : undefined;
      for (let i = 0; i < keys.length; i++) { const k = keys[i]; if (k !== null && rank(k) === rank(key) && (wildcard ? wildcard(k) : same(key, k))) return i; }
      return fail("#N/A");
    }
    let found = -1;
    for (let i = 0; i < keys.length; i++) { if (keys[i] === null || rank(keys[i]) !== rank(key)) continue; if (compare(keys[i], key) <= 0) found = i; else break; }
    return found >= 0 ? found : fail("#N/A");
  };
  const call = (name: string, args: Arg[]): CellValue => {
    const n = (i: number) => asNumber(scalar(args[i]));
    const text = (i: number) => toText(scalar(args[i]));
    const need = (min: number, max = min) => { if (args.length < min || args.length > max) fail("#VALUE!"); };
    const count = (i: number, fallback: number) => args[i] === undefined ? fallback : Math.trunc(n(i));
    switch (name) {
      case "SUM": return sum(numbers(args));
      case "PRODUCT": { const v = numbers(args); return v.length ? v.reduce((a, b) => a * b, 1) : 0; }
      case "AVERAGE": { const v = numbers(args); if (!v.length) fail("#DIV/0!"); return sum(v) / v.length; }
      case "MIN": { const v = numbers(args); return v.length ? Math.min(...v) : 0; }
      case "MAX": { const v = numbers(args); return v.length ? Math.max(...v) : 0; }
      case "MEDIAN": { const v = numbers(args).sort((a, b) => a - b); if (!v.length) fail("#NUM!"); const mid = v.length >> 1; return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2; }
      case "STDEV": case "STDEV.S": case "VAR": case "VAR.S": case "STDEV.P": case "STDEVP": case "VAR.P": case "VARP": {
        const v = numbers(args), population = /(?:\.P|P)$/.test(name), divisor = v.length - (population ? 0 : 1);
        if (divisor < 1) fail("#DIV/0!");
        const mean = sum(v) / v.length, variance = v.reduce((total, x) => total + (x - mean) ** 2, 0) / divisor;
        return name.startsWith("STDEV") ? Math.sqrt(variance) : variance;
      }
      case "LARGE": case "SMALL": { need(2); const v = numbers([args[0]]).sort((a, b) => name === "LARGE" ? b - a : a - b), k = Math.trunc(n(1)); if (k < 1 || k > v.length) fail("#NUM!"); return v[k - 1]; }
      case "COUNT": return flat(args).filter(v => typeof v === "number").length;
      case "COUNTA": return flat(args).filter(v => v !== null && v !== "").length;
      case "COUNTBLANK": return flat(args).filter(v => v === null || v === "").length;
      case "ROUND": case "ROUNDUP": case "ROUNDDOWN": {
        need(1, 2); const f = 10 ** count(1, 0), v = n(0) * f, a = Number(Math.abs(v).toPrecision(15));
        return (Math.sign(v) * (name === "ROUND" ? Math.round(a) : name === "ROUNDUP" ? Math.ceil(a) : Math.floor(a))) / f;
      }
      case "INT": need(1); return Math.floor(n(0));
      case "MOD": { need(2); const d = n(1); if (d === 0) fail("#DIV/0!"); return n(0) - d * Math.floor(n(0) / d); }
      case "POWER": { need(2); const r = n(0) ** n(1); return Number.isFinite(r) ? r : fail(n(0) === 0 ? "#DIV/0!" : "#NUM!"); }
      case "SQRT": { need(1); if (n(0) < 0) fail("#NUM!"); return Math.sqrt(n(0)); }
      case "ABS": need(1); return Math.abs(n(0));
      case "SIGN": need(1); return Math.sign(n(0));
      case "EXP": need(1); return Math.exp(n(0));
      case "LN": { need(1); if (n(0) <= 0) fail("#NUM!"); return Math.log(n(0)); }
      case "PI": need(0); return Math.PI;
      case "CEILING": case "FLOOR": {
        need(1, 2); const significance = args[1] === undefined ? 1 : n(1), v = n(0);
        if (significance === 0) return 0; if (v > 0 && significance < 0) fail("#NUM!");
        const q = Number((v / significance).toPrecision(15)); return (name === "CEILING" ? Math.ceil(q) : Math.floor(q)) * significance;
      }
      case "SUMPRODUCT": {
        const grids = args.map(asGrid); if (!grids.length || !grids.every(g => sameShape(g, grids[0]))) fail("#VALUE!");
        return grids[0].reduce((total, _v, i) => total + grids.reduce((p, g) => p * (typeof g[i] === "number" ? (g[i] as number) : 0), 1), 0);
      }
      case "SUMIF": { need(2, 3); const target = asGrid(args[0]); return sum(aligned(target, criterion(scalar(args[1])), asGrid(args[2] ?? args[0]))); }
      case "COUNTIF": { need(2); return asGrid(args[0]).filter(criterion(scalar(args[1]))).length; }
      case "AVERAGEIF": { need(2, 3); const picked = aligned(asGrid(args[0]), criterion(scalar(args[1])), asGrid(args[2] ?? args[0])); if (!picked.length) fail("#DIV/0!"); return sum(picked) / picked.length; }
      case "SUMIFS": { need(3, 255); if (args.length % 2 === 0) fail("#VALUE!"); return sum(pick(args[0], matching(args.slice(1)))); }
      case "COUNTIFS": { need(2, 254); if (args.length % 2) fail("#VALUE!"); return matching(args).filter(Boolean).length; }
      case "AVERAGEIFS": { need(3, 255); if (args.length % 2 === 0) fail("#VALUE!"); const v = pick(args[0], matching(args.slice(1))); if (!v.length) fail("#DIV/0!"); return sum(v) / v.length; }
      case "MAXIFS": case "MINIFS": { need(3, 255); if (args.length % 2 === 0) fail("#VALUE!"); const v = pick(args[0], matching(args.slice(1))); return v.length ? (name === "MAXIFS" ? Math.max(...v) : Math.min(...v)) : 0; }
      case "AND": case "OR": { const v = flat(args).filter(x => x !== null); if (!v.length) fail("#VALUE!"); return name === "AND" ? v.every(truthy) : v.some(truthy); }
      case "NOT": need(1); return !truthy(scalar(args[0]));
      case "ISBLANK": need(1); return scalar(args[0]) === null;
      case "ISNUMBER": need(1); return typeof scalar(args[0]) === "number";
      case "ISTEXT": need(1); return typeof scalar(args[0]) === "string";
      case "CONCAT": return flat(args).map(toText).join("");
      case "CONCATENATE": return args.map(arg => toText(scalar(arg))).join("");
      case "TEXTJOIN": { need(3, 255); const skip = truthy(scalar(args[1])); return flat(args.slice(2)).filter(v => !(skip && (v === null || v === ""))).map(toText).join(text(0)); }
      case "LEN": need(1); return text(0).length;
      case "LEFT": { need(1, 2); const k = count(1, 1); if (k < 0) fail("#VALUE!"); return text(0).slice(0, k); }
      case "RIGHT": { need(1, 2); const k = count(1, 1); if (k < 0) fail("#VALUE!"); return k === 0 ? "" : text(0).slice(-k); }
      case "MID": { need(3); const start = Math.trunc(n(1)), k = Math.trunc(n(2)); if (start < 1 || k < 0) fail("#VALUE!"); return text(0).slice(start - 1, start - 1 + k); }
      case "UPPER": need(1); return text(0).toUpperCase();
      case "LOWER": need(1); return text(0).toLowerCase();
      case "PROPER": need(1); return text(0).toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (_m, lead: string, letter: string) => lead + letter.toUpperCase());
      case "TRIM": need(1); return text(0).replace(/ +/g, " ").trim();
      case "SUBSTITUTE": {
        need(3, 4); const source = text(0), old = text(1), replacement = text(2);
        if (old === "") return source;
        if (args[3] === undefined) return source.split(old).join(replacement);
        const which = Math.trunc(n(3)); if (which < 1) fail("#VALUE!");
        let seen = 0, index = -1, from = 0;
        while ((index = source.indexOf(old, from)) >= 0) { if (++seen === which) return source.slice(0, index) + replacement + source.slice(index + old.length); from = index + old.length; }
        return source;
      }
      case "REPT": { need(2); const k = Math.trunc(n(1)); if (k < 0 || text(0).length * k > 32767) fail("#VALUE!"); return text(0).repeat(k); }
      case "FIND": case "SEARCH": {
        need(2, 3); const start = count(2, 1), within = text(1); if (start < 1 || start > within.length + 1) fail("#VALUE!");
        const found = (name === "SEARCH" ? within.toLowerCase() : within).indexOf(name === "SEARCH" ? text(0).toLowerCase() : text(0), start - 1);
        return found < 0 ? fail("#VALUE!") : found + 1;
      }
      case "EXACT": need(2); return text(0) === text(1);
      case "VALUE": {
        need(1); const v = scalar(args[0]); if (typeof v === "number") return v;
        const s = toText(v).trim().replace(/,/g, ""); if (s === "") return 0;
        const parsed = s.endsWith("%") ? Number(s.slice(0, -1)) / 100 : Number(s); return Number.isFinite(parsed) ? parsed : fail("#VALUE!");
      }
      case "TEXT": need(2); return formatText(scalar(args[0]), text(1));
      case "DATE": {
        need(3); const y = Math.trunc(n(0)), year = y >= 0 && y < 1900 ? y + 1900 : y;
        if (year < 1900 || year > 9999) fail("#NUM!");
        const serial = toSerial(year, Math.trunc(n(1)), Math.trunc(n(2))); if (serial < 61) throw new Unsupported(); return serial;
      }
      case "YEAR": need(1); return fromSerial(n(0)).getUTCFullYear();
      case "MONTH": need(1); return fromSerial(n(0)).getUTCMonth() + 1;
      case "DAY": need(1); return fromSerial(n(0)).getUTCDate();
      case "EDATE": case "EOMONTH": {
        need(2); const when = fromSerial(n(0)), target = new Date(Date.UTC(when.getUTCFullYear(), when.getUTCMonth() + Math.trunc(n(1)), 1));
        const year = target.getUTCFullYear(), month = target.getUTCMonth() + 1, lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
        return name === "EDATE" ? toSerial(year, month, Math.min(when.getUTCDate(), lastDay)) : toSerial(year, month, lastDay);
      }
      case "DAYS": need(2); return Math.trunc(n(0)) - Math.trunc(n(1));
      case "WEEKDAY": { need(1, 2); const day = fromSerial(n(0)).getUTCDay(), type = count(1, 1); return type === 1 ? day + 1 : type === 2 ? (day + 6) % 7 + 1 : type === 3 ? (day + 6) % 7 : fail("#NUM!"); }
      case "VLOOKUP": case "HLOOKUP": {
        need(3, 4); const table = asGrid(args[1]), index = Math.trunc(n(2)), vertical = name === "VLOOKUP";
        if (index < 1 || index > (vertical ? table.cols : table.rows)) fail("#REF!");
        const keys = vertical ? Array.from({ length: table.rows }, (_v, r) => at2(table, r, 0)) : Array.from({ length: table.cols }, (_v, c) => at2(table, 0, c));
        const flag = args[3] === undefined ? true : scalar(args[3]), found = lookupRow(scalar(args[0]), keys, typeof flag === "boolean" ? flag : asNumber(flag) !== 0);
        return vertical ? at2(table, found, index - 1) : at2(table, index - 1, found);
      }
      case "MATCH": {
        need(2, 3); const keys = asGrid(args[1]); if (keys.rows > 1 && keys.cols > 1) fail("#N/A");
        const kind = args[2] === undefined ? 1 : n(2), key = scalar(args[0]);
        if (kind === 0) return lookupRow(key, keys, false) + 1;
        if (kind > 0) return lookupRow(key, keys, true) + 1;
        let found = -1;
        for (let i = 0; i < keys.length; i++) { if (keys[i] === null || rank(keys[i]) !== rank(key)) continue; if (compare(keys[i], key) >= 0) found = i; else break; }
        return found >= 0 ? found + 1 : fail("#N/A");
      }
      case "INDEX": {
        need(2, 3); const table = asGrid(args[0]), r = Math.trunc(n(1)), c = args[2] === undefined ? undefined : Math.trunc(n(2));
        if (r < 0 || (c ?? 0) < 0) fail("#VALUE!");
        if (r === 0 || c === 0) throw new Unsupported(); // a whole row or column is an array result
        if (table.rows === 1 && c === undefined) { if (r > table.cols) fail("#REF!"); return table[r - 1]; }
        const col = c ?? 1; if (r > table.rows || col > table.cols) fail("#REF!"); return at2(table, r - 1, col - 1);
      }
      case "XLOOKUP": {
        need(3, 5); const keys = asGrid(args[1]), values = asGrid(args[2]);
        if ((args[4] !== undefined && n(4) !== 0) || (keys.rows > 1 && keys.cols > 1) || keys.length !== values.length) throw new Unsupported();
        try { return values[lookupRow(scalar(args[0]), keys, false)]; } catch (error) { if (error instanceof FormulaError && args[3] !== undefined) return scalar(args[3]); throw error; }
      }
      default: throw new Unsupported();
    }
  };
  const LAZY = new Set(["IF", "IFS", "IFERROR", "IFNA", "ISERROR", "SWITCH", "CHOOSE"]);
  const EAGER = new Set(["SUM", "PRODUCT", "AVERAGE", "MIN", "MAX", "MEDIAN", "STDEV", "STDEV.S", "STDEV.P", "STDEVP", "VAR", "VAR.S", "VAR.P", "VARP", "LARGE", "SMALL", "COUNT", "COUNTA", "COUNTBLANK", "ROUND", "ROUNDUP", "ROUNDDOWN", "INT", "MOD", "POWER", "SQRT", "ABS", "SIGN", "EXP", "LN", "PI", "CEILING", "FLOOR", "SUMPRODUCT",
    "SUMIF", "SUMIFS", "COUNTIF", "COUNTIFS", "AVERAGEIF", "AVERAGEIFS", "MAXIFS", "MINIFS", "AND", "OR", "NOT", "ISBLANK", "ISNUMBER", "ISTEXT", "CONCAT", "CONCATENATE", "TEXTJOIN", "LEN", "LEFT", "RIGHT", "MID", "UPPER", "LOWER", "PROPER", "TRIM", "SUBSTITUTE", "REPT",
    "FIND", "SEARCH", "EXACT", "VALUE", "TEXT", "DATE", "YEAR", "MONTH", "DAY", "EDATE", "EOMONTH", "DAYS", "WEEKDAY", "VLOOKUP", "HLOOKUP", "MATCH", "INDEX", "XLOOKUP"]);

  // Precedence climbing: comparison < concat < additive < multiplicative < power < unary < postfix percent.
  const comparison = (): CellValue => {
    let left = concat();
    for (;;) {
      const op = peek(); if (op?.t !== "op" || !["=", "<>", "<", ">", "<=", ">="].includes(op.v)) return left;
      next(); const right = concat(), order = compare(left, right);
      left = op.v === "=" ? order === 0 : op.v === "<>" ? order !== 0 : op.v === "<" ? order < 0 : op.v === ">" ? order > 0 : op.v === "<=" ? order <= 0 : order >= 0;
    }
  };
  const concat = (): CellValue => { let left = additive(); while (accept("&")) left = `${toText(left)}${toText(additive())}`; return left; };
  const additive = (): CellValue => { let left = term(); for (;;) { if (accept("+")) left = asNumber(left) + asNumber(term()); else if (accept("-")) left = asNumber(left) - asNumber(term()); else return left; } };
  const term = (): CellValue => { let left = power(); for (;;) { if (accept("*")) left = asNumber(left) * asNumber(power()); else if (accept("/")) { const d = asNumber(power()); if (d === 0) fail("#DIV/0!"); left = asNumber(left) / d; } else return left; } };
  const power = (): CellValue => { const base = unary(); return accept("^") ? asNumber(base) ** asNumber(power()) : base; };
  const unary = (): CellValue => { if (accept("-")) return -asNumber(unary()); if (accept("+")) return asNumber(unary()); return postfix(); };
  const postfix = (): CellValue => { let value = primary(); while (accept("%")) value = asNumber(value) / 100; return value; };
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
      if (LAZY.has(upper)) return lazyCall(upper);
      if (!EAGER.has(upper)) throw new Unsupported();
      const args: Arg[] = [];
      if (!accept(")")) {
        do {
          const p = peek(), after = peek(1);
          if (p?.t === "range") { next(); args.push(grid(p.v)); }
          else if (p?.t === "ref" && after?.t === "op" && (after.v === "," || after.v === ")")) { next(); const r = parseRef(p.v); args.push(single(cell(r.sheet, r.col, r.row))); } // a bare reference is a reference, not a literal
          else args.push(comparison());
        } while (accept(","));
        if (!accept(")")) throw new Error("Missing )");
      }
      return call(upper, args);
    }
    throw new Error(`Unexpected ${token.v}`);
  };
  // Functions that must not evaluate every argument: the untaken branch, or a fallback for a value that did not fail.
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
    const run = (index: number): CellValue => {
      const [from, to] = bounds[index], saved = at, original = tokens;
      at = from; tokens = original.slice(0, to);
      try { const value = comparison(); if (at < tokens.length) throw new Error("Unexpected token in argument"); return value; } finally { tokens = original; at = saved; }
    };
    const trap = (code?: string): { value?: CellValue; failed: boolean } => {
      try { return { value: run(0), failed: false }; } catch (error) { if (error instanceof FormulaError && (code === undefined || error.message === code)) return { failed: true }; throw error; }
    };
    try {
      switch (name) {
        case "IF": if (bounds.length < 2 || bounds.length > 3) fail("#VALUE!"); return truthy(run(0)) ? run(1) : (bounds[2] ? run(2) : false);
        case "IFERROR": { if (bounds.length !== 2) fail("#VALUE!"); const attempt = trap(); return attempt.failed ? run(1) : attempt.value!; }
        case "IFNA": { if (bounds.length !== 2) fail("#VALUE!"); const attempt = trap("#N/A"); return attempt.failed ? run(1) : attempt.value!; }
        case "ISERROR": { if (bounds.length !== 1) fail("#VALUE!"); return trap().failed; }
        case "IFS": { if (bounds.length < 2 || bounds.length % 2) fail("#VALUE!"); for (let i = 0; i < bounds.length; i += 2) if (truthy(run(i))) return run(i + 1); return fail("#N/A"); }
        case "SWITCH": { if (bounds.length < 3) fail("#VALUE!"); const subject = run(0); for (let i = 1; i + 1 < bounds.length; i += 2) if (same(subject, run(i))) return run(i + 1); return bounds.length % 2 === 0 ? run(bounds.length - 1) : fail("#N/A"); }
        case "CHOOSE": { if (bounds.length < 2) fail("#VALUE!"); const k = Math.trunc(asNumber(run(0))); return k >= 1 && k < bounds.length ? run(k) : fail("#VALUE!"); }
        default: throw new Unsupported();
      }
    } finally { at = end; }
  };
  try {
    const value = comparison();
    if (at < tokens.length) return { ok: false, error: "#NAME?", unsupported: true };
    if (value === null) return { ok: true, value: 0 };
    if (typeof value === "number" && !Number.isFinite(value)) return { ok: false, error: "#NUM!" };
    return { ok: true, value };
  } catch (error) {
    if (error instanceof FormulaError) return { ok: false, error: error.message };
    return { ok: false, error: "#NAME?", unsupported: true };
  }
}
