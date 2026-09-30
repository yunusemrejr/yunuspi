/** code_audit: static security, backend, efficiency, pattern and UI-source
 * audit over paths, the workspace or the current diff. Read-only,
 * local deterministic checks plus optional bounded semantic context. The same rules run automatically after
 * edits (see source-check.ts); this tool is the whole-tree form. SVG review
 * lives in svg_inspect (art-direction.ts). */
import { Type } from "typebox";
import { codeAudit, DOMAINS } from "./lib/code-audit.ts";
import { choices } from "./lib/tool-schema.ts";

const reply = (result: unknown, limit = 24_000) => {
  let emitted: any = result, text = JSON.stringify(emitted);
  while (Buffer.byteLength(text) > limit && emitted.findings?.length > 0) {
    const findings = emitted.findings.slice(0, Math.max(0, emitted.findings.length - 5));
    const rules = emitted.rules ? Object.fromEntries([...new Set(findings.map((f: any) => f.rule))].map(rule => [String(rule), emitted.rules[String(rule)]])) : undefined;
    emitted = { ...emitted, findings, ...(rules ? { rules } : {}), truncated: true,
      omitted: ((result as any).omitted ?? 0) + ((result as any).findings?.length ?? 0) - findings.length };
    text = JSON.stringify(emitted);
  }
  return { content: [{ type: "text", text }], details: result };
};

export default function codeAuditTool(pi: any) {
  pi.registerTool({
    name: "code_audit",
    label: "Code audit",
    description: "Read-only source audit: security, backend, efficiency, coding patterns and UI/accessibility/design cues across JS/TS, Python, Go, PHP, shell, CSS, HTML and configs. Use paths or changed:true. Compact locations share rule messages; view:detailed retains measurements. Ambiguous design cues may receive cached Jev/Kev context (<=8 excerpts, 4s); semantic:false keeps it local. Protected excerpts never go remote and deterministic findings remain. Supplied design direction wins over stock palette advice. No findings proves neither correctness nor safety. Local rules also run after edits.",
    promptSnippet: "Audit source for security, backend, efficiency, pattern and UI defects",
    promptGuidelines: ["Before finishing backend, API, auth, database, shell or UI work, run code_audit with changed:true and fix or justify every high and medium finding."],
    parameters: Type.Object({
      domains: Type.Optional(Type.Array(choices(DOMAINS), { maxItems: 5, description: "Default: all" })),
      paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 64, description: "Files or directories inside the workspace; default is the workspace root" })),
      changed: Type.Optional(Type.Boolean({ description: "Only files changed against base plus untracked files" })),
      base: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      minSeverity: Type.Optional(choices(["high", "medium", "low"])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
      view: Type.Optional(choices(["compact", "detailed"])),
      semantic: Type.Optional(Type.Boolean({ description: "Cached Jev/Kev context triage for ambiguous design cues; findings remain local evidence" })),
      direction: Type.Optional(Type.String({ maxLength: 1600, description: "Supplied design/user direction; explicit requested stock styles remain valid" })),
      protectedPaths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 64 })),
    }),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: any) {
      const deadline = AbortSignal.timeout(60_000), bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const report = await codeAudit(params, ctx?.cwd || process.cwd(), bounded, { pi });
      // Messages repeat per rule: state each once and keep findings to a location and an excerpt.
      const rules: Record<string, { message: string; fix: string }> = {};
      for (const f of report.findings) rules[f.rule] ??= { message: f.message, fix: f.fix };
      const compact = { ...report, rules, findings: report.findings.map(f => ({ at: f.line ? `${f.file}:${f.line}` : f.file, severity: f.severity, rule: f.rule, ...(f.excerpt ? { code: f.excerpt } : {}) })) };
      return reply(params.view === "detailed" ? report : compact);
    },
  });
}
