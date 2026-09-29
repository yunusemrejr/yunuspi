/** code_audit: static security, backend, efficiency, pattern and UI-source
 * audit over paths, the workspace or the current diff. Read-only,
 * dependency-free and model-free. The same rules run automatically after
 * edits (see source-check.ts); this tool is the whole-tree form. SVG review
 * lives in svg_inspect (art-direction.ts). */
import { Type } from "typebox";
import { codeAudit, DOMAINS } from "./lib/code-audit.ts";
import { choices } from "./lib/tool-schema.ts";

const reply = (result: unknown, limit = 24_000) => {
  const text = JSON.stringify(result);
  return { content: [{ type: "text", text: text.length > limit ? JSON.stringify({ ...(result as object), truncated: true, findings: (result as any).findings?.slice(0, 15) }) : text }], details: result };
};

export default function codeAuditTool(pi: any) {
  pi.registerTool({
    name: "code_audit",
    label: "Code audit",
    description: "Static audit of source for security (injection, secrets, deserialization, TLS, CORS, cookies, JWT, path traversal, SSRF), backend (timeouts, N+1, mass assignment, error leaks, blocking calls, unhandled async routes), efficiency, coding patterns and UI source (alt text, focus, zoom, tiny text, design-slop cues). JS/TS, Python, Go, PHP, shell, CSS, HTML, JSX/Vue/Svelte, config files. Paths, the workspace, or changed:true for the diff. Each finding has file:line, severity and rule; each rule's message and fix are listed once. Cues, not data-flow proof; no findings does not mean secure. Also runs automatically after edits.",
    promptSnippet: "Audit source for security, backend, efficiency, pattern and UI defects",
    promptGuidelines: ["Before finishing backend, API, auth, database, shell or UI work, run code_audit with changed:true and fix or justify every high and medium finding."],
    parameters: Type.Object({
      domains: Type.Optional(Type.Array(choices(DOMAINS), { maxItems: 5, description: "Default: all" })),
      paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 64, description: "Files or directories inside the workspace; default is the workspace root" })),
      changed: Type.Optional(Type.Boolean({ description: "Only files changed against base plus untracked files" })),
      base: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      minSeverity: Type.Optional(choices(["high", "medium", "low"])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
    }),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: any) {
      const deadline = AbortSignal.timeout(60_000), bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const report = await codeAudit(params, ctx?.cwd || process.cwd(), bounded);
      // Messages repeat per rule: state each once and keep findings to a location and an excerpt.
      const rules: Record<string, { message: string; fix: string }> = {};
      for (const f of report.findings) rules[f.rule] ??= { message: f.message, fix: f.fix };
      const compact = { ...report, rules, findings: report.findings.map(f => ({ at: f.line ? `${f.file}:${f.line}` : f.file, severity: f.severity, rule: f.rule, ...(f.excerpt ? { code: f.excerpt } : {}) })) };
      return reply(compact);
    },
  });
}
