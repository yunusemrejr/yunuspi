// Bound terminal EventBus publication retries for pi-background-tasks.
//
// A terminal task is already durable in its output/metadata files. EventBus
// publication is a delivery convenience, so a permanently broken/closed bus
// must not keep scheduling a retry every 100ms for the rest of the session.
// The retry budget is deliberately short and exponential; after it is spent,
// the durable task remains inspectable through status/logs and the failure is
// visible in the harness log.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MARKER = "PI_BG_TERMINAL_PUBLISH_BOUND";
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 100;
const MAX_DELAY_MS = 2_000;

const replacement = `const TERMINAL_PUBLISH_MAX_ATTEMPTS = ${MAX_ATTEMPTS};
const TERMINAL_PUBLISH_BASE_DELAY_MS = ${BASE_DELAY_MS};
const TERMINAL_PUBLISH_MAX_DELAY_MS = ${MAX_DELAY_MS};`;

const fieldReplacement = `  private readonly terminalPublishAttempts = new WeakMap<BgTask, number>();
  private readonly terminalPublishAbandoned = new WeakSet<BgTask>();`;

const guardReplacement = `    if (
      task.terminalPublished ||
      task.terminalPublishInFlight ||
      this.terminalPublishAbandoned.has(task)
    )
      return;`;

const successReplacement = `      task.terminalPublished = true;
      this.terminalPublishAttempts.delete(task);
      this.terminalPublishAbandoned.delete(task);`;

const failureReplacement = `    const attempt = (this.terminalPublishAttempts.get(task) ?? 0) + 1;
    this.terminalPublishAttempts.set(task, attempt);
    if (attempt >= TERMINAL_PUBLISH_MAX_ATTEMPTS) {
      this.terminalPublishAbandoned.add(task);
      this.logger.error(
        \`[background-tasks] giving up terminal publication for \${task.id} after \${String(attempt)} attempts; durable task metadata remains authoritative\`,
      );
      return;
    }
    const delayMs = Math.min(
      TERMINAL_PUBLISH_MAX_DELAY_MS,
      TERMINAL_PUBLISH_BASE_DELAY_MS * 2 ** (attempt - 1),
    );`;

const delayReplacement = `      }, delayMs);
      task.terminalPublishRetryHandle.unref();`;

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
  return (
    source.includes(MARKER) &&
    source.includes("this.terminalPublishAbandoned.has(task)") &&
    source.includes("giving up terminal publication") &&
    source.includes("task.terminalPublished = true;") &&
    !source.includes("this.terminalPublished = true;")
  );
}

export function targets() {
  const file = targetPath();
  return [
    {
      name: "pi-background-tasks: bounded terminal EventBus publication",
      file,
      exists: () => fs.existsSync(file),
      isApplied: () => applied(fs.readFileSync(file, "utf8")),
      apply() {
        let source = fs.readFileSync(file, "utf8");
        if (applied(source)) return;
        if (source.includes(MARKER) && source.includes("this.terminalPublished = true;")) {
          source = source.replace("      this.terminalPublished = true;", "      task.terminalPublished = true;");
          fs.writeFileSync(file, source);
          return;
        }
        if (source.includes(MARKER))
          throw new Error("terminal publication marker is present but patch is incomplete");

        const constantsAnchor = "export const WIN32_CMD_PI_TELEMETRY_UNAVAILABLE_REASON =";
        if (!source.includes(constantsAnchor))
          throw new Error("terminal publication constants anchor drift");
        source = source.replace(
          constantsAnchor,
          `${replacement}\n${constantsAnchor}`,
        );

        const fieldsAnchor = "  private readonly windowsKillStates = new WeakMap<BgTask, WindowsKillState>();";
        if (!source.includes(fieldsAnchor))
          throw new Error("terminal publication state anchor drift");
        source = source.replace(fieldsAnchor, `${fieldsAnchor}\n${fieldReplacement}`);

        const guardAnchor = "    if (task.terminalPublished || task.terminalPublishInFlight) return;";
        if (!source.includes(guardAnchor))
          throw new Error("terminal publication guard anchor drift");
        source = source.replace(guardAnchor, guardReplacement);

        const successAnchor = "      task.terminalPublished = true;";
        if (!source.includes(successAnchor))
          throw new Error("terminal publication success anchor drift");
        source = source.replace(successAnchor, `${successReplacement}`);

        const failureAnchor = `    if (\n      !task.terminalPublished &&\n      task.terminalPublishRetryHandle === undefined\n    ) {`;
        if (!source.includes(failureAnchor))
          throw new Error("terminal publication failure anchor drift");
        source = source.replace(
          failureAnchor,
          `    if (\n      !task.terminalPublished &&\n      task.terminalPublishRetryHandle === undefined\n    ) {\n${failureReplacement}`,
        );

        const delayAnchor =
          "      }, 100);\n      task.terminalPublishRetryHandle.unref();";
        if (!source.includes(delayAnchor))
          throw new Error("terminal publication delay anchor drift");
        source = source.replace(delayAnchor, delayReplacement);
        source = source.replace(
          `private readonly terminalPublishAttempts = new WeakMap<BgTask, number>();`,
          `private readonly terminalPublishAttempts = new WeakMap<BgTask, number>(); /* ${MARKER} */`,
        );
        fs.writeFileSync(file, source);
      },
    },
  ];
}
