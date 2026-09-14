/**
 * Child-only provider for the local-intelligence context tools.
 *
 * The parent session gets `context_score`, `handoff_capsule` and
 * `evidence_cache` from `pi-memory/index.ts`. Subagent children launch with
 * ambient extension discovery disabled, so a builtin agent that lists those
 * tool names in its strict `tools` allowlist must also load a provider path
 * through `subagentOnlyExtensions`. This module registers only those tools.
 *
 * The guard keeps an ambient parent load from double-registering the tools;
 * the parent keeps the full pi-memory owner.
 */
import os from "node:os";
import path from "node:path";
import { registerContextTools } from "./pi-memory/context-tools.ts";

export default function registerAgentContextTools(pi: any) {
 if (process.env.PI_SUBAGENT_CHILD !== "1") return;
 const directory =
  process.env.PI_MEMORY_DIR ??
  path.join(os.homedir(), ".pi", "agent", "memory");
 registerContextTools(pi, () => directory);
}
