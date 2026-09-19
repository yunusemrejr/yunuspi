// Thin read-only telemetry seam: expose actual runtime settings with SDK usage.
// No budgeting or compaction policy here; compaction-early remains its owner.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const marker = "PI_CONTEXT_SETTINGS";
const replacement = `getContextUsage(){/* ${marker} */const usage=this._getContextUsageBeforeTelemetry();return usage?{...usage,compactionSettings:this.settingsManager.getCompactionSettings()}:usage;} _getContextUsageBeforeTelemetry(){`;
const applied = (source) =>
  source.includes(replacement) && source.split(replacement).length === 2;
export function targets() {
  if (!process.env.PI_HARNESS_PATCH_TEST_CORE) throw Error("Legacy transform targets are test-only; set an isolated fixture core explicitly");
  const core =
    process.env.PI_HARNESS_PATCH_TEST_CORE ??
    path.join(
      execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
      "@yunuspi/coding-agent",
    );
  const version = JSON.parse(
    fs.readFileSync(path.join(core, "package.json"), "utf8"),
  ).version;
  if (version !== "0.85.1")
    throw Error(
      `context-settings supports Pi 0.85.1, found ${version}; validate method contract before updating version guard`,
    );
  const dir = path.join(core, "dist/bundle/chunks");
  const bundles = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".js"))
    .map((n) => path.join(dir, n))
    .filter((f) => /getContextUsage\(\)\s*\{/.test(fs.readFileSync(f, "utf8")));
  if (bundles.length !== 1)
    throw Error(
      `Expected one runtime context-usage owner, found ${bundles.length}`,
    );
  return [path.join(core, "dist/core/agent-session.js"), ...bundles].map(
    (file) => ({
      name: `runtime compaction settings: ${path.relative(core, file)}`,
      exists: () => fs.existsSync(file),
      isApplied: () => applied(fs.readFileSync(file, "utf8")),
      remove() {
        const s = fs.readFileSync(file, "utf8");
        if (!applied(s)) throw Error("Cannot remove drifted telemetry patch");
        fs.writeFileSync(file, s.replace(replacement, "getContextUsage(){"));
      },
      apply() {
        let s = fs.readFileSync(file, "utf8");
        if (applied(s)) return;
        if (s.includes(marker) || s.includes("_getContextUsageBeforeTelemetry"))
          throw Error(
            "Context settings postcondition drift: marker is not proof of a complete patch",
          );
        const re = /getContextUsage\(\)\s*\{/g;
        if ([...s.matchAll(re)].length !== 1)
          throw Error("Context usage anchor drift");
        s = s.replace(re, replacement);
        fs.writeFileSync(file, s);
      },
    }),
  );
}
