import chalk from "chalk";
export function createProjectTrustContext(options) {
    return {
        cwd: options.cwd,
        mode: options.mode === "interactive" ? "tui" : options.mode,
        hasUI: options.hasUI,
        ui: {
            select: async (title, selectOptions) => {
                if (!options.hasUI) {
                    return undefined;
                }
                if (options.mode !== "interactive") {
                    return undefined;
                }
                const { showStartupSelector } = await import('./startup-ui.js');
                return showStartupSelector(options.settingsManager, title, selectOptions.map((option) => ({ label: option, value: option })));
            },
            confirm: async (title, message) => {
                if (!options.hasUI) {
                    return false;
                }
                if (options.mode !== "interactive") {
                    return false;
                }
                const { showStartupSelector } = await import('./startup-ui.js');
                return ((await showStartupSelector(options.settingsManager, `${title}\n${message}`, [
                    { label: "Yes", value: true },
                    { label: "No", value: false },
                ])) ?? false);
            },
            input: async (title, placeholder) => {
                if (!options.hasUI) {
                    return undefined;
                }
                if (options.mode !== "interactive") {
                    return undefined;
                }
                const { showStartupInput } = await import('./startup-ui.js');
                return showStartupInput(options.settingsManager, title, placeholder);
            },
            notify: (message, type = "info") => {
                if (options.mode !== "interactive") {
                    const color = type === "error" ? chalk.red : type === "warning" ? chalk.yellow : chalk.cyan;
                    console.error(color(message));
                }
            },
        },
    };
}
