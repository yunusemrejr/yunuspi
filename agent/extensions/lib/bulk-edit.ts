/**
 * bulk_edit helpers — pure matching, replacement and preview logic.
 *
 * The tool wrapper (extensions/bulk-edit.ts) owns scoping, file I/O and the
 * preview→apply token. This module never touches the filesystem.
 */

import { createHash } from "node:crypto";

export type BulkOptions = { isRegex?: boolean; ignoreCase?: boolean };
export type BulkPlanEntry = { path: string; matches: number; preview: string[] };

export function compilePattern(pattern: string, options: BulkOptions): RegExp {
  if (typeof pattern !== "string" || !pattern) throw new Error("pattern is required");
  if (pattern.length > 200) throw new Error("pattern must be at most 200 characters");
  const source = options.isRegex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let flags = "g";
  if (options.ignoreCase) flags += "i";
  try {
    return new RegExp(source, flags);
  } catch (error) {
    throw new Error(`Invalid pattern: ${(error as Error).message.slice(0, 120)}`);
  }
}

/** Count and apply a replacement. Literal mode keeps `$` sequences literal. */
export function applyPattern(content: string, regex: RegExp, replacement: string, literal: boolean): { updated: string; matches: number } {
  if (typeof replacement !== "string" || replacement.length > 1000) throw new Error("replacement must be a string up to 1000 characters");
  const matches = [...content.matchAll(regex)].length;
  if (!matches) return { updated: content, matches: 0 };
  const repl = literal ? replacement.replaceAll("$", "$$") : replacement;
  return { updated: content.replace(regex, repl), matches };
}

/** First differing lines, bounded, as compact `- old` / `+ new` pairs. */
export function changedPreview(original: string, updated: string, max = 3): string[] {
  const before = original.split("\n");
  const after = updated.split("\n");
  const out: string[] = [];
  for (let i = 0; i < before.length || i < after.length; i++) {
    if (before[i] !== after[i]) {
      out.push(`- ${(before[i] ?? "").slice(0, 200)}\n+ ${(after[i] ?? "").slice(0, 200)}`);
      if (out.length >= max) break;
    }
  }
  return out;
}

export function contentHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** Deterministic plan token: apply only succeeds while every input is unchanged. */
export function planToken(entries: Array<{ path: string; hash: string; matches: number }>, pattern: string, replacement: string, options: BulkOptions): string {
  const payload = JSON.stringify({
    pattern,
    replacement,
    isRegex: !!options.isRegex,
    ignoreCase: !!options.ignoreCase,
    files: [...entries].sort((a, b) => a.path.localeCompare(b.path)).map((entry) => [entry.path, entry.hash, entry.matches]),
  });
  return createHash("sha256").update(payload).digest("hex");
}
