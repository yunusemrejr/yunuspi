import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const expected = [
  "bash-routes", "bg", "bg-clear", "bg-tasks", "bg-update", "catalog-status", "claude-cache", "commands", "cost", "curator",
  "effort", "errors", "export-json", "google-account", "graph", "harness-backup", "hook-audit", "jobs", "kill",
  "lens-allow-edit", "lens-context-toggle", "lens-drift", "lens-health", "lens-map", "lens-perf", "lens-tdi", "lens-toggle", "lens-tools", "lens-widget-toggle",
  "logs", "memory-prime", "metrics", "obs", "or-provider", "prompt-workflow", "provider", "provider-health", "reminder", "run", "search", "self",
  "models", "subagent-cost", "subagents", "subagents-check-profile", "subagents-detach", "subagents-doctor", "subagents-fleet", "subagents-generate-profiles", "subagents-inspect-rpc",
  "subagents-load-profile", "subagents-models", "subagents-profiles", "subagents-refine", "subagents-refresh-provider-models", "subagents-steer", "subagents-stop", "subagents-watchdog",
  "sys-prompt", "tasks", "todos", "used", "websearch",
].sort();

test("the installed extension graph registers every shipped command without load errors", { timeout: 90000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yunuspi-command-graph-"));
  const agentDir = path.join(dir, "agent");
  fs.mkdirSync(agentDir);
  try {
    for (const name of ["extensions", "scripts"]) fs.symlinkSync(path.join(root, "agent", name), path.join(agentDir, name), "dir");
    fs.symlinkSync(path.join(root, "node_modules"), path.join(agentDir, "node_modules"), "dir");
    const resourceLoader = pathToFileURL(path.join(root, "core/coding-agent/src/core/resource-loader.js")).href;
    const settingsManager = pathToFileURL(path.join(root, "core/coding-agent/src/core/settings-manager.js")).href;
    // A subprocess isolates provider factories and module globals. Runtime files,
    // settings and provider state stay in the temporary installation.
    const script = `
      import {DefaultResourceLoader} from ${JSON.stringify(resourceLoader)};
      import {SettingsManager} from ${JSON.stringify(settingsManager)};
      const loader = new DefaultResourceLoader({cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR,
        settingsManager: SettingsManager.inMemory({packages: []}), noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true});
      await loader.reload();
      const result = loader.getExtensions();
      const commands = result.extensions.flatMap(extension => [...extension.commands.values()]);
      console.log(JSON.stringify({extensions: result.extensions.length, errors: result.errors,
        commands: commands.map(command => command.name).sort(), invalid: commands.filter(command => typeof command.handler !== 'function').map(command => command.name)}));
      process.exit(0);
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SUBAGENT_CHILD: "0" },
      encoding: "utf8", timeout: 80000, maxBuffer: 1024 * 1024,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim().split("\n").at(-1));
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.invalid, []);
    assert.equal(result.extensions, 47);
    assert.deepEqual(result.commands, expected);
    assert.equal(new Set(result.commands).size, expected.length, "no duplicate command registrations hide a plain command name");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
