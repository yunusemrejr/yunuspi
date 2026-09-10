// PI_LENS_SEMANTIC_DRY — wires the semantic-radar (extensions/pi-lens/
// semantic-radar/) into pi-lens turn_end as a diff-scoped duplicate-
// functionality advisory. All policy lives in runtime.mjs; this patch is two
// tiny anchors: (1) a self-contained async helper after the bundle header,
// (2) the turn-end block right after the dead-code logLatency close.
// Degrades to no-op if the radar dir is absent or the check throws.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const targetPath = fileURLToPath(
  new URL("../../extensions/pi-lens/dist/index.js", import.meta.url),
);
export const marker = "PI_LENS_SEMANTIC_DRY";
const HEADER =
  'import { createRequire as __pilensCreateRequire } from "node:module"; const require = __pilensCreateRequire(import.meta.url);';
const helper = `
// ${marker} — thin loader; policy in ../semantic-radar/runtime.mjs
async function __piSemanticDryTurnEnd(cwd, dataDir, modifiedAbsPaths, dbg) {
  try {
    const m = await import("../semantic-radar/runtime.mjs");
    return await m.turnEndCheck({ cwd, dataDir, modifiedAbsPaths, dbg });
  } catch (err) {
    if (!/Cannot find module|ERR_MODULE_NOT_FOUND/.test(String(err)))
      dbg?.(\`semantic-dry: \${err}\`);
    return null;
  }
}
`;
const DEADCODE_CLOSE = `    phase: "dead-code",
    durationMs: Date.now() - tDeadCode,
    metadata: deadCodeMeta
  });`;
const LENS_MAP_ANCHOR = 'pi.registerCommand("lens-map", {';
const driftCommand = `pi.registerCommand("lens-drift", {
    description: "Semantic DRY: entropy trend + ranked consolidation candidates. Usage: /lens-drift",
    handler: async (_args, ctx) => {
      try {
        const cwd = ctx.cwd ?? process.cwd();
        const m = await import("../semantic-radar/drift.mjs");
        notifyUi(ctx, await m.driftReport(cwd), "info");
      } catch (err) {
        notifyUi(ctx, \`lens-drift failed: \${err instanceof Error ? err.message : String(err)}\`, "error");
      }
    }
  });
  `;
const turnEndBlock = `
  // ${marker}: diff-scoped semantic divergence advisory
  try {
    if (process.env.PI_LENS_SEMANTIC_DRY !== "0") {
      const sdFiles = files2.map((f) => resolveRunnerPath(cwd, f));
      if (sdFiles.length > 0) {
        const sdT = Date.now();
        const sd = await __piSemanticDryTurnEnd(cwd, getProjectDataDir(cwd) + "/semantic-radar", sdFiles, dbg2);
        if (sd?.advisory) advisoryParts.push(sd.advisory);
        if (sd?.diagnostics?.length) {
          projectDiagnosticsDelta.push(...sd.diagnostics);
          projectDiagnosticsSources.add("semantic-dry");
        }
        logLatency({ type: "phase", toolName: "turn_end", filePath: cwd, phase: "semantic_dry", durationMs: Date.now() - sdT, metadata: { modified: sdFiles.length, divs: sd?.divergences?.length ?? 0 } });
      }
    }
  } catch (err) { dbg2(\`turn_end: semantic-dry failed: \${err}\`); }`;
function one(source, old, replacement) {
  if (source.split(old).length !== 2)
    throw new Error("Semantic DRY patch anchor drift: " + old.slice(0, 80));
  return source.replace(old, replacement);
}
export function applySource(source) {
  if (source.includes(marker)) {
    if (
      !source.includes("__piSemanticDryTurnEnd") ||
      !source.includes('phase: "semantic_dry"') ||
      !source.includes("lens-drift")
    )
      throw new Error("Partial semantic DRY patch");
    return source;
  }
  source = one(source, HEADER, HEADER + helper);
  source = one(source, DEADCODE_CLOSE, DEADCODE_CLOSE + turnEndBlock);
  source = one(source, LENS_MAP_ANCHOR, driftCommand + LENS_MAP_ANCHOR);
  return source;
}
export function targets() {
  return [
    {
      name: "pi-lens semantic DRY turn-end integration",
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
