// Render request-associated diagnostics persisted by session-signals.ts.
// Old sessions name the original model but must not invent a historical cap.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const ORIGINAL = '"Response was truncated before completion."';
const REPLACEMENT =
  '(/* PI_TRUNCATION_CONTEXT */ message.errorMessage || "Response was truncated before completion — " + message.provider + "/" + message.model + "; observed request maxTokens unavailable.")';
export function isAppliedSource(source) {
  return source.split(REPLACEMENT).length === 2 && !source.includes(ORIGINAL);
}
export function patchSource(source) {
  if (isAppliedSource(source)) return source;
  if (
    source.includes("PI_TRUNCATION_CONTEXT") ||
    source.split(ORIGINAL).length !== 2 ||
    !/message\.stopReason\s*===\s*"length"/.test(source)
  )
    throw new Error("Truncation renderer anchor drift");
  return source.replace(ORIGINAL, REPLACEMENT);
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
    .filter((f) => {
      const source = fs.readFileSync(f, "utf8");
      return source.includes(ORIGINAL) || source.includes(REPLACEMENT);
    });
  if (owners.length !== 1)
    throw new Error(
      `Expected one bundled truncation renderer, found ${owners.length}`,
    );
  return [
    path.join(core, "dist/modes/interactive/components/assistant-message.js"),
    ...owners,
  ].map((file) => ({
    name: `truncation request context: ${path.relative(core, file)}`,
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
