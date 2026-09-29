/** Shared parameter-schema helpers for tools. */
import { Type } from "typebox";

/** A string enum as `{type:"string",enum:[...]}`. The `Type.Union` of `Type.Literal`s it replaces
 * serialized every value as its own `anyOf` object on every model turn, roughly three times the tokens.
 * Depends on typebox only, so modules that are loaded in isolation (tests, sandboxes) can use it. */
export const choices = (values: readonly string[], description?: string) =>
  Type.Unsafe<string>({ type: "string", enum: [...values], ...(description ? { description } : {}) });
