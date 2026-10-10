/** Shared parameter-schema helpers for tools. */
import { Type } from "typebox";
import { Value } from "typebox/value";

/** A string enum as `{type:"string",enum:[...]}`. The `Type.Union` of `Type.Literal`s it replaces
 * serialized every value as its own `anyOf` object on every model turn, roughly three times the tokens.
 * Depends on typebox only, so modules that are loaded in isolation (tests, sandboxes) can use it.
 * Numeric values get a numeric type: `{type:"string",enum:[2,4]}` accepts neither 4 nor "4". */
export const choices = (values: readonly (string | number)[], description?: string) =>
  Type.Unsafe<string>({
    type: values.every((value) => typeof value === "number") ? (values.every(Number.isInteger) ? "integer" : "number") : "string",
    enum: [...values], ...(description ? { description } : {}),
  });

/** Largest free-text rationale a tool accepts before the call is refused, as a multiple of what the owner keeps.
 * Over-long rationales used to fail schema validation outright: each refusal cost the agent a whole retry turn
 * (28 measured in quality_review and project_tests) to resend text the owner would have clipped anyway. */
export const RATIONALE_INTAKE = 4;

/** Keep the head and the tail of an over-long rationale, which state the verdict first and the evidence last,
 * and mark the omission so a reader of the clipped record knows text was removed. */
export function clipRationale(text: string, max: number): string {
  const flat = String(text ?? "").trim();
  if (flat.length <= max) return flat;
  const mark = " […] ", tail = Math.floor(max * 0.3);
  return `${flat.slice(0, max - tail - mark.length).trimEnd()}${mark}${flat.slice(-tail).trimStart()}`;
}

/** Several single-purpose registrations become one `action` tool. Each part keeps its own schema and executor;
 * the merged schema is `action` plus the union of the parts' fields (all optional), and the chosen part
 * validates the call against its own schema, so a merged tool refuses exactly what its parts refused.
 * Part names lose `prefix` to form the action ("agentmail_send" with prefix "agentmail_" is action "send"). */
export function actionTool(spec: { name: string; label: string; description: string; prefix?: string; promptSnippet?: string; promptGuidelines?: readonly string[] }, parts: readonly any[]) {
  const byAction = new Map<string, any>(parts.map((part) => [spec.prefix && part.name.startsWith(spec.prefix) ? part.name.slice(spec.prefix.length) : part.name, part]));
  const properties: Record<string, any> = { action: choices([...byAction.keys()], "Operation to perform; each action accepts only its own fields.") };
  for (const part of parts) for (const [key, schema] of Object.entries<any>(part.parameters?.properties ?? {})) properties[key] ??= Type.Optional(schema);
  return {
    name: spec.name, label: spec.label, description: spec.description, parameters: Type.Object(properties),
    ...(spec.promptSnippet ? { promptSnippet: spec.promptSnippet } : {}), ...(spec.promptGuidelines ? { promptGuidelines: spec.promptGuidelines } : {}),
    async execute(id: string, params: any, signal: AbortSignal | undefined, update: unknown, ctx: any) {
      const part = byAction.get(params?.action);
      if (!part) throw new Error(`Unknown action ${JSON.stringify(params?.action)}; use ${[...byAction.keys()].join(", ")}.`);
      const { action: _action, ...rest } = params;
      const first = part.parameters ? [...Value.Errors(part.parameters, rest)][0] : undefined;
      if (first) throw new Error(`${spec.name} ${params.action}: ${first.message}${first.instancePath ? ` at ${first.instancePath}` : ""}`);
      return part.execute(id, rest, signal, update, ctx);
    },
  };
}
