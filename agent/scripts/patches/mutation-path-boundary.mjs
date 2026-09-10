// Validate the final native write/edit argument after all extension hooks.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const MARKER = "PI_MUTATION_PATH_BOUNDARY";
const HELPER = `function __piMutationPath(raw) { /* ${MARKER} */
  if (typeof raw !== "string" || !raw.trim() || /[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]/u.test(raw))
    throw new Error("Blocked: invalid filesystem path. Pass a nonempty single-line path without control characters. No file was changed.");
  return raw;
}
`;
const BEFORE =
  /(function create(?:Write|Edit)ToolDefinition\([\s\S]{0,3000}?resolveToCwd)\(([\w$]+),/g;
const AFTER =
  /(function create(?:Write|Edit)ToolDefinition\([\s\S]{0,3000}?resolveToCwd)\(__piMutationPath\(([\w$]+)\),/g;
const definitions = (source) =>
  [...source.matchAll(/function create(?:Write|Edit)ToolDefinition\(/g)].length;
export function isAppliedSource(source) {
  const count = definitions(source);
  return (
    count > 0 &&
    source.split(HELPER).length === 2 &&
    source.split(MARKER).length === 2 &&
    [...source.matchAll(AFTER)].length === count &&
    [...source.matchAll(BEFORE)].length === 0
  );
}
export function patchSource(source) {
  if (isAppliedSource(source)) return source;
  if (source.includes(MARKER) || source.includes("__piMutationPath"))
    throw new Error("Mutation path patch is partial/drifted");
  const count = definitions(source);
  if (!count || [...source.matchAll(BEFORE)].length !== count)
    throw new Error("Native write/edit execution anchor drift");
  const next =
    source.replace(
      BEFORE,
      (_match, prefix, argument) => `${prefix}(__piMutationPath(${argument}),`,
    ) +
    "\n" +
    HELPER;
  if (!isAppliedSource(next))
    throw new Error("Mutation path postcondition failed");
  return next;
}
export function targets() {
  const core =
    process.env.PI_HARNESS_PATCH_TEST_CORE ??
    path.join(
      execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
      "@earendil-works/pi-coding-agent",
    );
  const bundle = path.join(core, "dist/bundle");
  const owners = fs
    .readdirSync(bundle, { recursive: true })
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join(bundle, f))
    .filter((f) => definitions(fs.readFileSync(f, "utf8")) > 0);
  const combined = owners.map((f) => fs.readFileSync(f, "utf8")).join("\n");
  for (const tool of ["Write", "Edit"]) {
    if (
      [
        ...combined.matchAll(
          new RegExp(`function create${tool}ToolDefinition\\(`, "g"),
        ),
      ].length !== 1
    )
      throw new Error(`Expected one bundled ${tool} execution owner`);
  }
  return [
    path.join(core, "dist/core/tools/write.js"),
    path.join(core, "dist/core/tools/edit.js"),
    ...owners,
  ].map((file) => ({
    name: `final mutation path validation: ${path.relative(core, file)}`,
    exists: () => fs.existsSync(file),
    isApplied: () => isAppliedSource(fs.readFileSync(file, "utf8")),
    apply() {
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
