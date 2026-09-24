/** code_quality: dependency-free DRY, slop, prose and complexity checks over
 * explicit paths, directories or the files changed against a revision. */
import { Type } from "typebox";
import { codeQuality } from "./lib/code-quality.ts";

const choices = (values: string[]) => Type.Union(values.map(value => Type.Literal(value)));

export default function codeQualityTools(pi: any) {
  pi.registerTool({
    name: "code_quality",
    label: "Code quality",
    description: "Measure code and prose quality without installing anything or running project code. duplicates: token clone detection across files or a whole tree (renamed mode catches copies with different names and constants), clone classes, duplicated-line share; with changed:true reports only clones touching files changed against base (DRY check for a branch). slop: placeholders and elided code, debug leftovers, swallowed errors, redundant booleans, commented-out code, type escapes, repeated literals, unused imports. prose: stock AI-sounding phrases with replacements, readability, sentence length, passive voice, hedges, fillers, dash density for Markdown/text/HTML. complexity: per-function cyclomatic complexity, length, nesting, parameters and async-without-await for JS/TS/Python. Advisory findings with file:line.",
    promptSnippet: "Find duplicated code, code slop, prose slop and complexity hotspots",
    promptGuidelines: [
      "Before claiming a refactor or feature is clean, run code_quality duplicates with changed:true to catch copy-pasted logic, and slop on the changed files.",
    ],
    parameters: Type.Object({
      operation: choices(["duplicates", "slop", "prose", "complexity"]),
      paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 64, description: "Files or directories inside the workspace; default is the workspace root" })),
      changed: Type.Optional(Type.Boolean({ description: "Focus on files changed against base plus untracked files" })),
      base: Type.Optional(Type.String({ minLength: 1, maxLength: 120, description: "Base revision for changed (default HEAD)" })),
      mode: Type.Optional(choices(["renamed", "exact"])),
      minTokens: Type.Optional(Type.Integer({ minimum: 20, maximum: 1000 })),
      minLines: Type.Optional(Type.Integer({ minimum: 2, maximum: 200 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 80 })),
    }),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: any) {
      const deadline = AbortSignal.timeout(60_000);
      const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const { parserFor } = await import("./pi-lens/semantic-radar/extract.mjs");
      const result = await codeQuality(params, ctx?.cwd || process.cwd(), bounded, parserFor);
      let text = JSON.stringify(result);
      if (text.length > 24_000) text = JSON.stringify({ ...result, truncated: true, findings: (result as any).findings?.slice(0, 20), clones: (result as any).clones?.slice(0, 10), files: (result as any).files?.slice?.(0, 6) });
      return { content: [{ type: "text", text }], details: result };
    },
  });
}
