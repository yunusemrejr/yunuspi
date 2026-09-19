// Extend the existing project orientation tool; no new tool or index.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const targetPath = fileURLToPath(
 new URL("../../../extensions/pi-lens/dist/index.js", import.meta.url),
);
export const marker = "PI_LENS_WORKSPACE_FACTS";
const helper = `// ${marker}
async function piWorkspaceFacts(cwd, signal) {
  const { workspaceFacts } = await import(new URL("../../../scripts/workspace-facts.mjs", import.meta.url).href);
  const report = await workspaceFacts(cwd, signal);
  return { content: [{ type: "text", text: JSON.stringify(report) }], details: { available: true, view: "workspace", truncated: report.truncated } };
}
`;
const oldDescription =
 "Orient in a project using the cached import graph: freshness/coverage, hubs, entry points, directory dependencies, risks and low-confidence unused files. Compact text by default (16k characters); view:default returns full JSON. Cold cache returns unavailable and starts one background build; no inferred intent. focus only re-ranks. Drill into named files with module_report.";
const newDescription =
 "Orient in a project. view:workspace works without an index: fresh local/Git state, remote host names, hooks path, manifest/script names and protected-data hints (12k characters); no remote access or mutation, authority remains unresolved. Otherwise use the cached import graph: compact text by default (16k), view:default for JSON; cold cache starts one background build. Reports facts, not intent. Drill into files with module_report.";
const edits = [
 [
  "function createProjectReportTool(getProjectRoot) {",
  helper + "function createProjectReportTool(getProjectRoot) {",
 ],
 [
  "description: " + JSON.stringify(oldDescription),
  "description: " + JSON.stringify(newDescription),
 ],
 [
  'enum: ["default", "compact"],\n        description: "Omit for compact text (16k characters). default: full JSON; compact: text."',
  'enum: ["default", "compact", "workspace"],\n        description: "workspace: fresh bounded local/Git facts, no graph required. Omit for compact graph text; default: full graph JSON."',
 ],
 [
  'const cwd = getProjectRoot() || ctx.cwd || ".";\n      let report;\n      try {\n        report = await projectReport(cwd, {',
  'const cwd = getProjectRoot() || ctx.cwd || ".";\n      if (params.view === "workspace") return piWorkspaceFacts(cwd, _signal);\n      let report;\n      try {\n        report = await projectReport(cwd, {',
 ],
];
export function applySource(source) {
 if (source.includes(marker)) {
  if (!edits.every(([, text]) => source.includes(text)))
   throw new Error("Partial workspace-facts patch");
  return source;
 }
 for (const [old, text] of edits) {
  if (source.split(old).length !== 2)
   throw new Error("Workspace-facts anchor drift: " + old.slice(0, 80));
  source = source.replace(old, text);
 }
 return source;
}
export function targets() {
 return [
  {
   name: "Lens cold-safe workspace facts",
   exists: () => fs.existsSync(targetPath),
   isApplied: () => {
    try {
     const s = fs.readFileSync(targetPath, "utf8");
     return s.includes(marker) && applySource(s) === s;
    } catch {
     return false;
    }
   },
   apply: () =>
    fs.writeFileSync(
     targetPath,
     applySource(fs.readFileSync(targetPath, "utf8")),
    ),
  },
 ];
}
if (
 process.argv[1] === fileURLToPath(import.meta.url) &&
 process.argv.includes("--fix")
)
 targets()[0].apply();
