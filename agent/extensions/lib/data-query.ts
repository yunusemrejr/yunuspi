/**
 * data_query helpers — pure, bounded JSON/YAML reading and querying.
 *
 * The tool wrapper (lib/small-tools.ts) owns file access; this module owns
 * parsing, path selection, filtering and conversion. All output is bounded so
 * a small model never receives an unbounded dump.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const MAX_OUTPUT_CHARS = 65536;
export const MAX_ITEMS = 200;
export const DEFAULT_LIMIT = 25;

type PathToken = { kind: "key"; value: string } | { kind: "index"; value: number };

/** Parse `a.b[0].c`, `.a`, `[2]` into tokens. Throws on unsupported syntax. */
export function parsePath(path: string): PathToken[] {
  const tokens: PathToken[] = [];
  let i = 0;
  while (i < path.length) {
    const c = path[i];
    if (c === "." ) { i++; continue; }
    if (c === "[") {
      const end = path.indexOf("]", i);
      if (end < 0) throw new Error(`Invalid path "${path}": missing "]"`);
      const inside = path.slice(i + 1, end).trim();
      if (!/^\d+$/.test(inside)) throw new Error(`Invalid path "${path}": only numeric indexes are supported`);
      tokens.push({ kind: "index", value: Number(inside) });
      i = end + 1;
      continue;
    }
    const match = /^[A-Za-z0-9_$-]+/.exec(path.slice(i));
    if (!match) throw new Error(`Invalid path "${path}" at character ${i + 1}`);
    tokens.push({ kind: "key", value: match[0] });
    i += match[0].length;
  }
  return tokens;
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value === null) return "null";
  return typeof value;
}

function availableKeys(value: unknown): string {
  if (Array.isArray(value)) return `array of ${value.length} items`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length ? `keys: ${keys.slice(0, 12).join(", ")}${keys.length > 12 ? ", …" : ""}` : "no keys";
  }
  return `value is ${describeType(value)}`;
}

/** Resolve a dotted/bracketed path. Errors carry the nearest available keys. */
export function selectPath(root: unknown, path: string): unknown {
  if (!path || path === ".") return root;
  let current = root;
  let walked = "";
  for (const token of parsePath(path)) {
    if (token.kind === "key") {
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        throw new Error(`Path "${path}" not found at "${walked || "."}": ${availableKeys(current)}`);
      }
      const record = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(record, token.value)) {
        throw new Error(`Path "${path}" not found: no key "${token.value}" at "${walked || "."}". ${availableKeys(current)}`);
      }
      current = record[token.value];
      walked += `${walked ? "." : ""}${token.value}`;
    } else {
      if (!Array.isArray(current)) {
        throw new Error(`Path "${path}" needs an array at "${walked || "."}" but found ${describeType(current)}`);
      }
      if (token.value >= current.length) {
        throw new Error(`Path "${path}" index [${token.value}] out of range at "${walked || "."}" (length ${current.length})`);
      }
      current = current[token.value];
      walked += `[${token.value}]`;
    }
  }
  return current;
}

/** Parse JSON first, then YAML when the text or an explicit format allows it. */
export function parseData(text: string, format?: "json" | "yaml" | string): unknown {
  if (typeof text !== "string") throw new Error("Input must be text");
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Empty input: no JSON/YAML content");
  if (trimmed.length > 2 * 1024 * 1024) throw new Error("Input is too large (limit 2 MiB)");
  if (format === "yaml" || /\.(?:ya?ml)$/i.test(format ?? "")) return parseYaml(trimmed);
  if (format === "json" || /\.json$/i.test(format ?? "")) {
    try {
      return JSON.parse(trimmed);
    } catch (e) {
      throw new Error(`Invalid JSON: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    // JSON-shaped text must fail as JSON, never silently re-parse as YAML.
    if (/^[\[{]/.test(trimmed)) throw new Error(`Invalid JSON: ${(e as Error).message.slice(0, 160)}`);
  }
  if (/^(?:---|\{|\[|- )/m.test(trimmed) || /^[A-Za-z0-9_."'-]+\s*:/m.test(trimmed)) {
    const value = parseYaml(trimmed);
    if (value !== undefined) return value;
  }
  throw new Error('Input is not valid JSON; pass a .json/.yaml file or use format:"yaml" for YAML text');
}

export type DataQueryResult = {
  value?: unknown;
  keys?: string[];
  count?: number;
  matched?: number;
  total?: number;
  items?: unknown[];
  format?: string;
  text?: string;
  truncated?: boolean;
  note?: string;
};

/** Execute one bounded data operation over parsed data. */
export function executeDataQuery(input: {
  op: string;
  data: unknown;
  path?: string;
  field?: string;
  equals?: unknown;
  format?: string;
  limit?: number;
}): DataQueryResult {
  const { op, data } = input;
  const limit = Math.min(Math.max(Number(input.limit) || DEFAULT_LIMIT, 1), MAX_ITEMS);
  const base = input.path ? selectPath(data, input.path) : data;

  if (op === "get") {
    return { value: boundValue(base, limit) };
  }
  if (op === "keys") {
    if (Array.isArray(base)) throw new Error(`keys expects an object, but "${input.path || "."}" is an array of ${base.length} items`);
    if (!base || typeof base !== "object") throw new Error(`keys expects an object, but "${input.path || "."}" is ${describeType(base)}`);
    return { keys: Object.keys(base as Record<string, unknown>).slice(0, MAX_ITEMS) };
  }
  if (op === "count") {
    if (Array.isArray(base)) return { count: base.length };
    if (base && typeof base === "object") return { count: Object.keys(base as Record<string, unknown>).length };
    throw new Error(`count expects an array or object, but "${input.path || "."}" is ${describeType(base)}`);
  }
  if (op === "filter") {
    if (!Array.isArray(base)) throw new Error(`filter expects an array, but "${input.path || "."}" is ${describeType(base)}`);
    if (typeof input.field !== "string" || !input.field) throw new Error("filter requires a field name");
    const matches = base.filter((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const value = (item as Record<string, unknown>)[input.field as string];
      return value === input.equals;
    });
    return {
      matched: matches.length,
      total: base.length,
      items: matches.slice(0, limit).map((item) => boundValue(item, limit)),
      ...(matches.length > limit ? { note: `showing ${limit} of ${matches.length} matches` } : {}),
    };
  }
  if (op === "convert") {
    const format = input.format;
    if (format === "json") return { format, ...boundedText(JSON.stringify(base, null, 2)) };
    if (format === "yaml") return { format, ...boundedText(stringifyYaml(base)) };
    if (format === "csv") return { format, ...boundedText(toCsv(base, limit)) };
    throw new Error('convert requires format: "json", "yaml" or "csv"');
  }
  throw new Error(`Unsupported data operation: ${op}`);
}

/** Keep large arrays/strings bounded inside one JSON result. */
export function boundValue(value: unknown, limit = DEFAULT_LIMIT): unknown {
  if (Array.isArray(value)) {
    if (value.length <= limit) return value;
    return { items: value.slice(0, limit), total: value.length, note: `showing ${limit} of ${value.length} items` };
  }
  if (typeof value === "string" && value.length > 8192) {
    return `${value.slice(0, 8192)}…[+${value.length - 8192} chars]`;
  }
  return value;
}

function boundedText(text: string): { text: string; truncated?: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text };
  return { text: text.slice(0, MAX_OUTPUT_CHARS), truncated: true };
}

/** CSV for an array of flat objects; header from the union of the first rows. */
export function toCsv(value: unknown, limit = MAX_ITEMS): string {
  if (!Array.isArray(value)) throw new Error("csv conversion expects an array of objects");
  const rows = value.slice(0, limit);
  const header: string[] = [];
  for (const row of rows.slice(0, 50)) {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      for (const key of Object.keys(row as Record<string, unknown>)) if (!header.includes(key)) header.push(key);
    }
  }
  if (!header.length) throw new Error("csv conversion needs at least one object with fields");
  const cell = (raw: unknown): string => {
    const text = raw === undefined || raw === null ? "" : typeof raw === "object" ? JSON.stringify(raw) : String(raw);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const lines = [header.join(",")];
  for (const row of rows) {
    const record = (row ?? {}) as Record<string, unknown>;
    lines.push(header.map((key) => cell(record[key])).join(","));
  }
  return lines.join("\n");
}
