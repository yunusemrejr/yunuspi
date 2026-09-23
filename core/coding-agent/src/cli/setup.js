import { APP_NAME } from "../config.js";
import { configureHttpDispatcher } from "../core/http-dispatcher.js";
export function setupCli() {
    // On Linux this overwrites /proc/<pid>/cmdline. Preserve the entrypoint
    // arguments so installation updates can identify this active core owner.
    if (process.platform !== "linux") process.title = APP_NAME;
    process.env.PI_CODING_AGENT = "true";
    process.env.AI_AGENT = "yunuspi";
    process.emitWarning = (() => { });
    // Configure undici before provider SDKs issue requests. Settings are applied
    // once SettingsManager has loaded global/project configuration.
    configureHttpDispatcher();
}
