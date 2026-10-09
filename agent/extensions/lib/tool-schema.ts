/** Shared parameter-schema helpers for tools. */
import { Type } from "typebox";

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
