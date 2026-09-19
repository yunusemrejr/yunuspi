// Preserve signal termination as failure in pi-background-tasks.
//
// Node reports a signal termination as (code=null, signal=<signal>). Treating
// `code ?? 0` as success turns a killed process into a completed task and can
// trigger completion wakes or downstream work on an incomplete result.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MARKER = "PI_BG_SIGNAL_STATUS_BOUND";
const replacement = "} else if (code === 0 && signalName === null) {";

function targetPath() {
  return process.env.PI_HARNESS_PATCH_TEST_BACKGROUND_TASKS ??
    path.join(
      os.homedir(),
      ".pi",
      "agent",
      "extensions",
      "pi-background-tasks",
      "src",
      "core",
      "registry.ts",
    );
}

function applied(source) {
  return source.includes(MARKER) &&
    source.includes("code === 0 && signalName === null");
}

export function targets() {
  const file = targetPath();
  return [
    {
      name: "pi-background-tasks: preserve signal termination status",
      file,
      exists: () => fs.existsSync(file),
      isApplied: () => applied(fs.readFileSync(file, "utf8")),
      apply() {
        let source = fs.readFileSync(file, "utf8");
        if (applied(source)) return;
        if (source.includes(MARKER))
          throw new Error("signal status marker is present but patch is incomplete");
        const anchor = "} else if ((code ?? 0) === 0) {";
        if (!source.includes(anchor))
          throw new Error("signal status anchor drift");
        source = source.replace(anchor, `${replacement} /* ${MARKER} */`);
        fs.writeFileSync(file, source);
      },
    },
  ];
}
