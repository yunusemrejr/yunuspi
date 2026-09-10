// Carry pre-write absence by call ID; a post-write stat cannot identify creation.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
const MARKER = "PI_LENS_PREWRITE_ABSENCE";
const changes = [
  [
    "  const targetMissing = !nodeFs12.existsSync(filePath);",
    `  const targetMissing = !nodeFs12.existsSync(filePath);
  // ${MARKER}: permission errors and dangling symlinks are not absence.
  let pathAbsent = false;
  try { nodeFs12.lstatSync(filePath); } catch (error) { pathAbsent = error?.code === "ENOENT"; }`,
  ],
  [
    "      resolvedPath: filePath,\n      skipped: targetIgnored,",
    "      resolvedPath: filePath,\n      pathAbsent,\n      skipped: targetIgnored,",
  ],
  [
    "  const behaviorWarnings = agentBehaviorRecord(event.toolName, filePath);",
    `  const newFileReceipt = event.toolName === "write" && event.isError !== true && event.details?.isError !== true && !!filePath &&
    (deps._piNewFileReceipt === filePath || (attribution?.pathAbsent === true && pathsEqual(filePath, attribution.resolvedPath)));
  const behaviorWarnings = agentBehaviorRecord(event.toolName, filePath).filter(warning => !newFileReceipt || warning.type !== "blind-write");`,
  ],
  [
    "        _autofixMode: autofixMode,\n        _telemetryParticipantIds: [readGuardCorrelationId],",
    "        _autofixMode: autofixMode,\n        _piNewFileReceipt: newFileReceipt ? filePath : undefined,\n        _telemetryParticipantIds: [readGuardCorrelationId],",
  ],
  [
    "  deps.readGuard?.recordWritten(filePath);",
    `  if (newFileReceipt && !getFlag("no-read-guard"))
    deps.readGuard?.noteCreatedFile(filePath, runtime2.turnIndex, runtime2.peekWriteIndex());
  deps.readGuard?.recordWritten(filePath);`,
  ],
  [
    `  const isWriteOrEdit = isToolCallEventType("write", event) || isEditOnly;
  if (!isEditOnly && isWriteOrEdit && filePath && !getFlag("no-read-guard")) {
    runtime2.readGuard.noteCreatedFile(filePath, runtime2.turnIndex, runtime2.peekWriteIndex());
  }`,
    "  // Creation reads are stamped only from a successful, same-target result receipt.",
  ],
];
export function isAppliedSource(source) {
  return (
    source.split(MARKER).length === 2 &&
    changes.every(([, next]) => source.split(next).length === 2)
  );
}
export function patchSource(source) {
  if (isAppliedSource(source)) return source;
  if (source.includes(MARKER) || source.includes("_piNewFileReceipt"))
    throw new Error("Lens creation patch is partial/drifted");
  for (const [before] of changes)
    if (source.split(before).length !== 2)
      throw new Error(`Lens creation anchor drift: ${before.slice(0, 100)}`);
  if (!source.includes('import * as nodeFs12 from "node:fs";'))
    throw new Error("Lens fs import changed");
  let next = source;
  for (const [before, after] of changes) next = next.replace(before, after);
  if (!isAppliedSource(next))
    throw new Error("Lens creation postcondition failed");
  return next;
}
export function targets() {
  const file =
    process.env.PI_HARNESS_PATCH_TEST_LENS ??
    path.join(os.homedir(), ".pi/agent/extensions/pi-lens/dist/index.js");
  return [
    {
      name: "pi-lens new-file read guard and blind-write advisory",
      exists: () => fs.existsSync(file),
      isApplied: () => isAppliedSource(fs.readFileSync(file, "utf8")),
      apply() {
        const source = fs.readFileSync(file, "utf8"),
          next = patchSource(source);
        if (next === source) return;
        execFileSync(process.execPath, ["--input-type=module", "--check"], {
          input: next,
          stdio: ["pipe", "pipe", "pipe"],
        });
        fs.writeFileSync(file, next);
      },
    },
  ];
}
