// Single owner for resolving YunusPi-owned runtime packages in tests and tools.
// Historical `@earendil-works/*` npm names are gone: the owned core lives under
// `runtime/core/*` as `@yunuspi/*`. Never resolve packages through global npm.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOwnedCore } from "./owned-core.mjs";

export { resolveOwnedCore };

export const AGENT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const CORE_ROOT = path.join(AGENT_ROOT, "runtime", "core");

/** Historical short package name -> owned core directory under runtime/core. */
const OWNED_DIRS = {
  "pi-coding-agent": "coding-agent",
  "pi-ai": "ai",
  "pi-agent-core": "agent",
  "pi-tui": "tui",
  "pi-chord": "chord",
  "coding-agent": "coding-agent",
  ai: "ai",
  agent: "agent",
  "agent-core": "agent",
  tui: "tui",
  chord: "chord",
};

export function ownedPackageDir(shortName) {
  const dir = OWNED_DIRS[shortName];
  if (!dir) throw Error(`Unknown core package name: ${shortName}`);
  const full = path.join(CORE_ROOT, dir);
  if (!fs.existsSync(path.join(full, "package.json"))) {
    throw Error(`Owned core package missing at ${full} (build with npm run build:core)`);
  }
  return full;
}

export function ownedAiDir() {
  return ownedPackageDir("pi-ai");
}

export function ownedAgentCoreDir() {
  return ownedPackageDir("pi-agent-core");
}

export function ownedCodingAgentDir() {
  return ownedPackageDir("pi-coding-agent");
}

/** Path to a file inside an owned core package (dist or src). */
export function ownedFile(shortName, ...segments) {
  return path.join(ownedPackageDir(shortName), ...segments);
}

/** Historical join(npmRoot(), '@earendil-works', 'pi-coding-agent') shape. */
export function historicalCodingAgentRoot() {
  return ownedCodingAgentDir();
}
