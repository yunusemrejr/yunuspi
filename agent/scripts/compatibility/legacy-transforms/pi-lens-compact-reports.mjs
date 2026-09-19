// Presentation-only patch to the maintained Lens fork. No new index, scan,
// prompt hook or cache. Explicit view:default retains the original JSON API.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const targetPath = fileURLToPath(
  new URL("../../../extensions/pi-lens/dist/index.js", import.meta.url),
);
export const marker = "PI_LENS_COMPACT_REPORTS";
const moduleDescription =
  "Outline a source file before reading bodies. Compact text by default (16k characters); view:default returns full JSON, summary returns light JSON. Includes symbol ranges, callbacks, imports and cached-reference provenance. Use read_symbol/read_enclosing for actual code: outlines do not satisfy read-before-edit. blastRadius and callGraph opt into cached graph evidence; unavailable/stale data is identified. focus only ranks recommended reads.";
const projectDescription =
  "Orient in a project using the cached import graph: freshness/coverage, hubs, entry points, directory dependencies, risks and low-confidence unused files. Compact text by default (16k characters); view:default returns full JSON. Cold cache returns unavailable and starts one background build; no inferred intent. focus only re-ranks. Drill into named files with module_report.";
const helper = `// ${marker}
function piBoundCompactReport(text) {
  if (text.length <= 16000) return text;
  const end = text.lastIndexOf("\\n", 15700);
  return text.slice(0, end > 0 ? end : 15700) + '\\n[Truncated at 16k characters. Use view:"default" for full JSON or read_symbol for one body.]';
}
`;
// Pairs deliberately require exact occurrence counts, including after apply.
export const edits = [
  [
    "function createModuleReportTool(getProjectRoot) {",
    helper + "function createModuleReportTool(getProjectRoot) {",
  ],
  [
    "view: params.view,\n          blastRadius:",
    'view: params.view ?? "compact",\n          blastRadius:',
  ],
  [
    'const text = params.view === "compact" ? renderCompactModuleReport(report) : JSON.stringify(report);',
    'const text = (params.view ?? "compact") === "compact" ? piBoundCompactReport(renderCompactModuleReport(report)) : JSON.stringify(report);',
  ],
  [
    'view: params.view === "compact" ? "compact" : void 0',
    'view: (params.view ?? "compact") === "compact" ? "compact" : void 0',
  ],
  [
    'const text = params.view === "compact" ? renderCompactProjectReport(report) : JSON.stringify(report);',
    'const text = (params.view ?? "compact") === "compact" ? piBoundCompactReport(renderCompactProjectReport(report)) : JSON.stringify(report);',
  ],
  [
    "  for (const warning of report.warnings ?? []) {",
    '  lines.push(`PROVENANCE: ${JSON.stringify(report.provenance)}; graph built: ${report.graphBuiltAt ?? "unavailable"}`);\n  lines.push(`IMPORTS: ${JSON.stringify(report.imports)}`);\n  if (report.blastRadius) lines.push(`BLAST RADIUS: ${JSON.stringify(report.blastRadius)}`);\n  if (report.callGraph) lines.push(`CALL GRAPH EVIDENCE: ${JSON.stringify(report.callGraph)}`);\n  lines.push(\'Outline only. used-by lists files, not exact locations; view:"default" expands details.\');\n  for (const warning of report.warnings ?? []) {',
  ],
  [
    "    if (s.cycles.length > 0) {",
    '    lines.push(`  directories: ${s.directories.join(", ")}`);\n    for (const edge of s.edges) lines.push(`  ${edge.from} -> ${edge.to}: ${edge.count}`);\n    if (s.cycles.length > 0) {',
  ],
];
function one(source, old, replacement) {
  if (source.split(old).length !== 2)
    throw new Error("Compact report patch anchor drift: " + old.slice(0, 90));
  return source.replace(old, replacement);
}
function description(source, name, text) {
  const re = new RegExp(
    '(name: "' + name + '",\\n    label: [^\\n]+\\n    description: )[^\\n]+',
  );
  if ((source.match(new RegExp(re.source, "g")) ?? []).length !== 1)
    throw new Error("Description anchor drift: " + name);
  return source.replace(re, (_, prefix) => prefix + JSON.stringify(text) + ",");
}
export function applySource(source) {
  if (source.includes(marker)) {
    if (!edits.every(([, replacement]) => source.includes(replacement)))
      throw new Error("Partial compact report patch");
    return source;
  }
  for (const [old, replacement] of edits)
    source = one(source, old, replacement);
  source = description(source, "module_report", moduleDescription);
  source = description(source, "project_report", projectDescription);
  source = one(
    source,
    "Payload tier. summary returns top-level entries/recommendedReads and section provenance with heavy callback/usedBy/blast-radius payloads omitted. compact (cheapest) returns a line-oriented TEXT rendering of the full report instead of JSON.",
    "Omit for compact text (16k characters). default: full JSON; summary: light JSON; compact: text with provenance and graph evidence.",
  );
  source = one(
    source,
    "Payload tier. compact (cheapest) returns a line-oriented TEXT rendering instead of JSON. Default returns JSON.",
    "Omit for compact text (16k characters). default: full JSON; compact: text.",
  );
  return source;
}
export function targets() {
  return [
    {
      name: "Lens compact reports and evidence",
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
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--fix")) targets()[0].apply();
  console.log(targets()[0].isApplied() ? "applied" : "not applied");
}
