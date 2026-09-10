// Keep repair in the already-loaded CLI frame: an update may replace this file.
// Raw npm/installer updates are covered separately by the systemd repair watch.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const marker = "PI_POST_UPDATE_REPAIR";
const original = "__piPackageCommandBeforeRepair";
const anchor = /async function handlePackageCommand\(/g;
const wrapper = `async function handlePackageCommand(...args) {/* ${marker} */
  try { return await ${original}(...args); }
  finally {
    const argv = args[0];
    if (argv?.[0] === "update" && !argv.includes("--help") && !argv.includes("-h")) {
      try {
        const { execFileSync } = await import("node:child_process");
        const { homedir } = await import("node:os");
        const { join } = await import("node:path");
        execFileSync("timeout", ["--kill-after=5s", "180s", "/bin/bash",
          join(homedir(), ".pi/agent/scripts/auto-update.sh"), "--repair-only"], { stdio: "inherit" });
      } catch (error) {
        console.error("Pi harness repair failed after update; see ~/.pi/agent/logs/auto-update.log and run verify-harness.mjs --fix.", error.message);
        process.exitCode = process.exitCode || 1;
      }
    }
  }
}
async function ${original}(`;

export function targets() {
  const core =
    process.env.PI_HARNESS_PATCH_TEST_CORE ??
    path.join(
      execFileSync("npm", ["root", "-g"], {
        encoding: "utf8",
        timeout: 5000,
      }).trim(),
      "@earendil-works/pi-coding-agent",
    );
  const dir = path.join(core, "dist/bundle/chunks");
  const bundles = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".js"))
    .map((n) => path.join(dir, n))
    .filter((file) =>
      /async function handlePackageCommand\(/.test(
        fs.readFileSync(file, "utf8"),
      ),
    );
  if (bundles.length !== 1)
    throw new Error(
      `Expected one CLI package-command owner, found ${bundles.length}`,
    );
  return [path.join(core, "dist/package-manager-cli.js"), ...bundles].map(
    (file) => ({
      file,
      name: `post-update repair: ${path.relative(core, file)}`,
      exists: () => fs.existsSync(file),
      isApplied: () =>
        fs.readFileSync(file, "utf8").split(wrapper).length === 2,
      apply() {
        const source = fs.readFileSync(file, "utf8");
        if (source.split(wrapper).length === 2) return;
        if (
          source.includes(marker) ||
          source.includes(original) ||
          [...source.matchAll(anchor)].length !== 1
        )
          throw new Error(
            "Post-update repair anchor/postcondition drift; inspect the package-command owner",
          );
        fs.writeFileSync(file, source.replace(anchor, wrapper));
      },
    }),
  );
}
