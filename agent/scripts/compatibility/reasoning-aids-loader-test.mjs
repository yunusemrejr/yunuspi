// Reproduce ambient + explicit child extension loading without inference.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const core =
 execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim() +
 "/@earendil-works/pi-coding-agent";
const sdk = await import(core + "/dist/index.js");
const agentRoot = fileURLToPath(new URL("../../", import.meta.url));
const canonical = path.join(agentRoot, "extensions/reasoning-aids.ts");
const observations = path.join(agentRoot, "extensions/pi-observations.ts");
process.env.PI_SMOL_PREPROCESSOR = "off";
const builtinDir = path.join(agentRoot, "extensions/pi-subagents/agents");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-helper-loader-"));
const expectedExtensions = {
 "automatic-free-assistant.md": [canonical, observations],
 "delegate.md": [
  canonical,
  observations,
  path.join(agentRoot, "extensions/git-tools.ts"),
  path.join(agentRoot, "extensions/http-tools.ts"),
  path.join(agentRoot, "extensions/bulk-edit.ts"),
  path.join(agentRoot, "extensions/sys-probe.ts"),
 ],
 "oracle.md": [
  canonical,
  observations,
  path.join(agentRoot, "extensions/git-tools.ts"),
  path.join(agentRoot, "extensions/http-tools.ts"),
  path.join(agentRoot, "extensions/sys-probe.ts"),
 ],
 "researcher.md": [
  canonical,
  observations,
  path.join(agentRoot, "extensions/http-tools.ts"),
 ],
 "reviewer.md": [
  canonical,
  observations,
  path.join(agentRoot, "extensions/git-tools.ts"),
 ],
 "scout.md": [
  canonical,
  observations,
  path.join(agentRoot, "extensions/git-tools.ts"),
  path.join(agentRoot, "extensions/http-tools.ts"),
  path.join(agentRoot, "extensions/sys-probe.ts"),
 ],
 "worker.md": [
  canonical,
  observations,
  path.join(agentRoot, "extensions/git-tools.ts"),
  path.join(agentRoot, "extensions/http-tools.ts"),
  path.join(agentRoot, "extensions/bulk-edit.ts"),
  path.join(agentRoot, "extensions/sys-probe.ts"),
 ],
};
for (const paths of Object.values(expectedExtensions))
 paths.unshift(path.join(agentRoot, "extensions/reminders.ts"));
for (const name of ["delegate.md", "worker.md"])
 expectedExtensions[name].splice(
  1,
  0,
  path.join(agentRoot, "extensions/media-tools.ts"),
 );
for (const paths of Object.values(expectedExtensions))
 paths.push(
  path.join(agentRoot, "extensions/project-intelligence.ts"),
  path.join(agentRoot, "extensions/sandbox.ts"),
 );
expectedExtensions["automatic-free-assistant.md"].push(
 path.join(agentRoot, "extensions/git-tools.ts"),
);
for (const [name, paths] of Object.entries(expectedExtensions))
 if (name !== "automatic-free-assistant.md")
  paths.push(path.join(agentRoot, "extensions/render-and-wait.ts"));
for (const paths of Object.values(expectedExtensions))
 paths.unshift(
  path.join(agentRoot, "extensions/utility-tools.ts"),
  path.join(agentRoot, "extensions/bash-router.ts"),
 );
// The local-intelligence context tools are declared as a child-only provider
// immediately after reasoning-aids in every interactive profile.
const agentContextTools = path.join(
 agentRoot,
 "extensions/agent-context-tools.ts",
);
for (const [name, paths] of Object.entries(expectedExtensions))
 if (name !== "automatic-free-assistant.md")
  paths.splice(paths.indexOf(canonical) + 1, 0, agentContextTools);
try {
 const paths = [];
 for (const name of fs.readdirSync(builtinDir)) {
  if (!name.endsWith(".md")) continue;
  const source = fs.readFileSync(path.join(builtinDir, name), "utf8");
  if (name === "automatic-skill-discovery.md") {
   assert.match(
    source,
    /^tools:[ \t]*$/m,
    "the packet-only selector must not receive tools",
   );
   assert.doesNotMatch(source, /^subagentOnlyExtensions:/m);
   for (const field of [
    "inheritProjectContext",
    "inheritGlobalContext",
    "inheritSkills",
   ])
    assert.ok(source.includes(`${field}: false`), `${name}: ${field}`);
   continue;
  }
  const match = source.match(/^subagentOnlyExtensions: (.+)$/m);
  assert.ok(match, name);
  const resolved = match[1]
   .split(",")
   .map((entry) => path.resolve(builtinDir, entry.trim()));
  assert.deepEqual(resolved, expectedExtensions[name], name);
  assert.ok(
   source
    .match(/^tools: (.+)$/m)[1]
    .split(",")
    .map((tool) => tool.trim())
    .includes("obs_read"),
   name,
  );
  paths.push(...resolved);
 }
 assert.equal(
  paths.length,
  Object.values(expectedExtensions).reduce(
   (count, paths) => count + paths.length,
   0,
  ),
 );
 for (const ambient of [false, true]) {
  const loader = new sdk.DefaultResourceLoader({
   cwd: home,
   agentDir: home,
   settingsManager: sdk.SettingsManager.inMemory({
    extensions: ambient ? [canonical, observations] : [],
   }),
   additionalExtensionPaths: paths,
   noSkills: true,
   noPromptTemplates: true,
   noThemes: true,
   noContextFiles: true,
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  for (const tool of [
   "sqlite_probe",
   "package_probe",
   "openapi_probe",
   "coverage_probe",
   "contract_diff",
   "env_audit",
   "net_probe",
   "archive_probe",
   "skill_review",
   "dependency_plan",
   "decision_frontier",
   "coverage_select",
   "math_check",
   "artifact_check",
   "value_convert",
   "data_query",
   "context_slice",
   "symbol_expand",
   "ast_diff",
   "obs_read",
   "git_info",
   "http_request",
   "bulk_edit",
   "sys_probe",
   "project_intel",
   "sandbox_run",
   "render_see",
   "wait_for",
   "browser_session",
  ])
   assert.equal(
    result.extensions.filter((e) => e.tools.has(tool)).length,
    1,
    `${tool}, ambient=${ambient}`,
   );
 }
 // The child-only provider is registration-gated on PI_SUBAGENT_CHILD, so a
 // parent load must stay a no-op while an explicit child load exposes the
 // local-intelligence tools exactly once.
 const priorChild = process.env.PI_SUBAGENT_CHILD;
 process.env.PI_SUBAGENT_CHILD = "1";
 try {
  const childLoader = new sdk.DefaultResourceLoader({
   cwd: home,
   agentDir: home,
   settingsManager: sdk.SettingsManager.inMemory({ extensions: [] }),
   additionalExtensionPaths: [agentContextTools],
   noSkills: true,
   noPromptTemplates: true,
   noThemes: true,
   noContextFiles: true,
  });
  await childLoader.reload();
  const childResult = childLoader.getExtensions();
  assert.deepEqual(childResult.errors, []);
  for (const tool of ["context_score", "handoff_capsule", "evidence_cache"])
   assert.equal(
    childResult.extensions.filter((e) => e.tools.has(tool)).length,
    1,
    `${tool} child provider`,
   );
 } finally {
  if (priorChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = priorChild;
 }
 console.log(
  "PASS all built-in helper paths: isolated and ambient child startup register each tool exactly once",
 );
} finally {
 fs.rmSync(home, { recursive: true, force: true });
}
