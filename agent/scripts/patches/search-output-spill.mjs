// Preserve full grep/find/ls output when it is byte-truncated.
//
// bash already keeps the complete stream through OutputAccumulator, but the
// search tools returned only the truncated head: bytes past the 50KB limit
// were unrecoverable except by a narrower re-run (measured in the
// 2026-09-14 audit). This patch gives them the same escape hatch bash has:
// when truncation fires, the raw output is written to a temp file and the
// truncation notice names it.
//
// Boundary: only the `dist/core/tools/*.js` files are patched — the path the
// installed CLI loads through `dist/core/tools/index.js`. The separate
// `dist/bundle/` copy (a different distribution entry, whitespace-minified)
// is not transformed; if a future core release routes the CLI through the
// bundle, the file targets would still apply but take effect only for the
// file path, so the transform would need a bundle variant.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MARKER = "PI_SEARCH_OUTPUT_SPILL";
export const HELPER = `function __piSpillOutput(prefix, text) { /* ${MARKER} */
  const { randomBytes } = process.getBuiltinModule("node:crypto");
  const { writeFileSync } = process.getBuiltinModule("node:fs");
  const { tmpdir } = process.getBuiltinModule("node:os");
  const { join } = process.getBuiltinModule("node:path");
  const file = join(tmpdir(), \`\${prefix}-\${randomBytes(8).toString("hex")}.log\`);
  writeFileSync(file, text);
  return file;
}`;

// The truncation block is identical for find.js's two code paths; grep.js and
// ls.js each have a single copy at their own indentation depth.
const TOOLS = {
  "grep.js": {
    name: "grep",
    prefix: "pi-grep",
    indent: "                            ",
    occurrences: 1,
  },
  "find.js": {
    name: "find",
    prefix: "pi-find",
    indent: "                            ",
    occurrences: 2,
  },
  "ls.js": {
    name: "ls",
    prefix: "pi-ls",
    indent: "                        ",
    occurrences: 1,
  },
  // read.js truncates through truncateHead with its own continuation-notice
  // branch, so it carries a custom anchor. The spill keeps the full selected
  // slice (offset..EOF or the user limit) retrievable.
  "read.js": {
    name: "read",
    prefix: "pi-read",
    indent: "                                ",
    occurrences: 1,
    anchor: {
      original: () => [
        "                                else {",
        "                                    outputText += `\\n\\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;",
        "                                }",
        "                                details = { truncation };",
        "                            }",
      ].join("\n"),
      patched: () => [
        "                                else {",
        "                                    outputText += `\\n\\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;",
        "                                }",
        "                                // Full raw output stays retrievable instead of vanishing at the byte cap.",
        "                                const fullOutputPath = __piSpillOutput(\"pi-read\", selectedContent);",
        "                                details = { truncation, fullOutputPath };",
        "                                outputText += `\\n\\n[Full untruncated output: ${fullOutputPath}]`;",
        "                            }",
      ].join("\n"),
    },
  },
};

const originalBlock = (indent) =>
  `${indent}if (truncation.truncated) {\n` +
  `${indent}    notices.push(\`\${formatSize(DEFAULT_MAX_BYTES)} limit reached\`);\n` +
  `${indent}    details.truncation = truncation;\n` +
  `${indent}}\n`;

const patchedBlock = (indent, prefix) =>
  `${indent}if (truncation.truncated) {\n` +
  `${indent}    // Full raw output stays retrievable instead of vanishing at the byte cap.\n` +
  `${indent}    const fullOutputPath = __piSpillOutput("${prefix}", rawOutput);\n` +
  `${indent}    details.truncation = truncation;\n` +
  `${indent}    details.fullOutputPath = fullOutputPath;\n` +
  `${indent}    notices.push(\`\${formatSize(DEFAULT_MAX_BYTES)} limit reached. Full output: \${fullOutputPath}\`);\n` +
  `${indent}}\n`;

// Tools either reuse the shared truncation block or carry a custom anchor.
const blocksFor = (spec) =>
  spec.anchor
    ? {
        original: spec.anchor.original(spec.indent),
        patched: spec.anchor.patched(spec.indent, spec.prefix),
      }
    : {
        original: originalBlock(spec.indent),
        patched: patchedBlock(spec.indent, spec.prefix),
      };

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const occurrencesOf = (source, needle) => source.split(needle).length - 1;

export function isAppliedSource(source, tool) {
  const spec = TOOLS[`${tool}.js`];
  if (!spec) throw new Error(`Unknown spill tool: ${tool}`);
  const blocks = blocksFor(spec);
  return (
    source.split(MARKER).length === 2 &&
    source.split(HELPER).length === 2 &&
    occurrencesOf(source, blocks.patched) === spec.occurrences &&
    occurrencesOf(source, blocks.original) === 0
  );
}

export function patchSource(source, tool) {
  const spec = TOOLS[`${tool}.js`];
  if (!spec) throw new Error(`Unknown spill tool: ${tool}`);
  if (isAppliedSource(source, tool)) return source;
  if (source.includes(MARKER) || source.includes("__piSpillOutput"))
    throw new Error(`Search spill patch is partial/drifted for ${tool}`);
  const blocks = blocksFor(spec);
  const count = occurrencesOf(source, blocks.original);
  if (count !== spec.occurrences)
    throw new Error(
      `Search spill anchor drift for ${tool}: expected ${spec.occurrences} truncation block(s), found ${count}`,
    );
  let next = source.replaceAll(blocks.original, blocks.patched);
  next = `${next}\n${HELPER}\n`;
  if (!isAppliedSource(next, tool))
    throw new Error(`Search spill postcondition failed for ${tool}`);
  return next;
}

/** Reverse the transform for fixtures/tests (never used against live files). */
export function stripSource(source, tool) {
  const spec = TOOLS[`${tool}.js`];
  if (!spec) throw new Error(`Unknown spill tool: ${tool}`);
  let next = source.split(`\n${HELPER}\n`).join("");
  next = next.split(HELPER).join("");
  const blocks = blocksFor(spec);
  next = next.replaceAll(
    new RegExp(escapeRegExp(blocks.patched), "g"),
    blocks.original,
  );
  return next;
}

function coreRoot() {
  return (
    process.env.PI_HARNESS_PATCH_TEST_CORE ??
    path.join(
      execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
      "@earendil-works/pi-coding-agent",
    )
  );
}

export function targets() {
  const core = coreRoot();
  return Object.entries(TOOLS).map(([file, spec]) => {
    const target = path.join(core, "dist/core/tools", file);
    return {
      name: `search output spill: ${path.relative(core, target)}`,
      exists: () => fs.existsSync(target),
      isApplied: () =>
        isAppliedSource(fs.readFileSync(target, "utf8"), spec.name),
      apply() {
        const source = fs.readFileSync(target, "utf8"),
          next = patchSource(source, spec.name);
        if (next === source) return;
        execFileSync(process.execPath, ["--input-type=module", "--check"], {
          input: next,
          stdio: ["pipe", "pipe", "pipe"],
        });
        fs.writeFileSync(target, next);
      },
    };
  });
}
