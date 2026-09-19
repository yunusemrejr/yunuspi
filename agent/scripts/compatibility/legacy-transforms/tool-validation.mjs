// Bound schema-failure echoes in both the SDK and executable CLI bundle.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MARKER = "PI_BOUNDED_ARGUMENT_ECHO";
const DETAIL_MARKER = "PI_VALIDATION_REPAIR_DETAILS_V1";
const HELPER = `function __piArgumentEcho(value) { /* ${MARKER} */
  let text;
  try { text = JSON.stringify(value, null, 2) ?? String(value); }
  catch { return "[arguments could not be serialized]"; }
  const suffix = "… [argument echo truncated]";
  return text.length <= 400 ? text : text.slice(0, 400 - suffix.length) + suffix;
}
`;
// Keep native validation/coercion semantics. Only its error presentation changes.
const DETAIL_HELPER = `function __piValidationDetails(errors, schema) { /* ${DETAIL_MARKER} */
  const lines = [], seen = new Set();
  let inspected = 0, omitted = false;
  const short = (value, max = 160) => String(value ?? "").replace(/[\\u0000-\\u001f\\u007f-\\u009f]/g, " ").slice(0, max);
  for (const error of errors) {
    if (++inspected > 32 || lines.length >= 6) { omitted = true; break; }
    const line = "  - " + short(formatValidationPath(error), 100) + ": " + short(error.message);
    if (!seen.has(line)) { seen.add(line); lines.push(line); }
  }
  if (!lines.length) lines.push("Unknown validation error");
  if (omitted) lines.push("  - Additional validation errors omitted; correct the shown fields first.");
  const fields = Object.keys(schema?.properties ?? {});
  if (fields.length) lines.push("Top-level fields: " + fields.slice(0, 16).map(key => JSON.stringify(short(key, 40))).join(", ") + (fields.length > 16 ? ", … (see tool schema)" : ""));
  lines.push("Use the declared tool schema to correct the arguments before retrying. No tool execution occurred.");
  return lines.join("\\n");
}
`;
const DETAIL_EXPRESSION = "__piValidationDetails(validator.Errors(args),tool.parameters)";
const DETAIL_ORIGINAL = [
  'validator\n        .Errors(args)\n        .map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)\n        .join("\\n") || "Unknown validation error"',
  'validator.Errors(args).map(error=>`  - ${formatValidationPath(error)}: ${error.message}`).join(`\n`)||"Unknown validation error"',
];
function patchDetails(source) {
  if (source.includes(DETAIL_MARKER)) {
    if (!source.includes(DETAIL_HELPER) || source.split(DETAIL_MARKER).length !== 2 || source.split(DETAIL_EXPRESSION).length !== 2 || DETAIL_ORIGINAL.some(x => source.includes(x)))
      throw Error("Validation details patch is partial/drifted");
    return source;
  }
  if (source.includes("__piValidationDetails")) throw Error("Validation details patch is partial/drifted");
  const matches = DETAIL_ORIGINAL.filter(x => source.includes(x));
  if (matches.length !== 1 || source.split(matches[0]).length !== 2) throw Error("Validation details anchor drift");
  return source.replace(matches[0], () => DETAIL_EXPRESSION) + "\n" + DETAIL_HELPER;
}
const ORIGINAL =
  /(Received arguments:(?:\\n|\n))\$\{JSON\.stringify\(([A-Za-z_$][\w$]*)\.arguments,\s*null,\s*2\)\}/g;
const PATCHED =
  /Received arguments:(?:\\n|\n)\$\{__piArgumentEcho\([A-Za-z_$][\w$]*\.arguments\)\}/g;
function echoApplied(source) {
  return (
    source.includes(HELPER) &&
    source.split(MARKER).length === 2 &&
    [...source.matchAll(PATCHED)].length === 1 &&
    [...source.matchAll(ORIGINAL)].length === 0
  );
}
export function isAppliedSource(source) {
  try { return echoApplied(source) && source.includes(DETAIL_MARKER) && patchDetails(source) === source; }
  catch { return false; }
}
export function patchSource(source) {
  if (echoApplied(source)) return patchDetails(source);
  if (source.includes(MARKER) || source.includes("__piArgumentEcho"))
    throw new Error("Argument echo patch is partial/drifted");
  if (
    !source.includes("Validation failed for tool") ||
    [...source.matchAll(ORIGINAL)].length !== 1
  )
    throw new Error(
      "Validation echo anchor drift: expected exactly one failure interpolation",
    );
  const next =
    source.replace(
      ORIGINAL,
      (_match, prefix, id) => `${prefix}\${__piArgumentEcho(${id}.arguments)}`,
    ) +
    "\n" +
    HELPER;
  if (!echoApplied(next))
    throw new Error("Argument echo postcondition failed");
  return patchDetails(next);
}
export function targets() {
  if (!process.env.PI_HARNESS_PATCH_TEST_CORE) throw Error("Legacy transform targets are test-only; set an isolated fixture core explicitly");
  const core =
    process.env.PI_HARNESS_PATCH_TEST_CORE ??
    path.join(
      execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
      "@yunuspi/coding-agent",
    );
  const bundle = path.join(core, "dist/bundle");
  const owners = fs
    .readdirSync(bundle, { recursive: true })
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join(bundle, f))
    .filter((f) => fs.readFileSync(f, "utf8").includes("Received arguments:"));
  if (owners.length !== 1)
    throw new Error(
      `Expected one bundled validation owner, found ${owners.length}`,
    );
  const native = path.join(
    core,
    "node_modules/@yunuspi/ai/dist/utils/validation.js",
  );
  const files = [native, ...owners];
  return files.map((file) => ({
    name: `bounded validation echo: ${path.relative(core, file)}`,
    exists: () => fs.existsSync(file),
    isApplied: () => isAppliedSource(fs.readFileSync(file, "utf8")),
    apply() {
      // Preflight both runtimes before touching either one after a core update.
      for (const target of files) patchSource(fs.readFileSync(target, "utf8"));
      const source = fs.readFileSync(file, "utf8"),
        next = patchSource(source);
      if (next === source) return;
      execFileSync(process.execPath, ["--input-type=module", "--check"], {
        input: next,
        stdio: ["pipe", "pipe", "pipe"],
      });
      fs.writeFileSync(file, next);
    },
  }));
}
