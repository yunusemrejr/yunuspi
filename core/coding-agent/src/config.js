import { accessSync, constants, existsSync, readFileSync, realpathSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve, sep, win32 } from "path";
import { fileURLToPath } from "url";
import { spawnProcessSync } from "./utils/child-process.js";
import { normalizePath } from "./utils/paths.js";
import { stripBom } from "./utils/text.js";
// =============================================================================
// Package Detection
// =============================================================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export const isBunBinary = import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");
/** Detect if Bun is the runtime (compiled binary or bun run) */
export const isBunRuntime = !!process.versions.bun;
export const isBundledNode = typeof PI_BUNDLED_NODE !== "undefined" && PI_BUNDLED_NODE;
export function detectInstallMethod() { return "yunuspi-source"; }
export function getSelfUpdateCommand() { return undefined; }
export function getSelfUpdateUnavailableInstruction() { return "Update from a reviewed YunusPi checkout; see docs/CORE-UPDATES.md."; }
export function getUpdateInstruction() { return getSelfUpdateUnavailableInstruction(); }
// =============================================================================
// Package Asset Paths (shipped with executable)
// =============================================================================
/**
 * Get the base directory for resolving package assets (themes, package.json, README.md, CHANGELOG.md).
 * - For Bun binary: returns the directory containing the executable
 * - For Node.js and tsx: returns the package root containing package.json
 * - Ignores Bun binary metadata copied into dist/ when the package root is available
 */
export function findNodePackageDir(startDir) {
    let dir = startDir;
    while (dir !== dirname(dir)) {
        if (existsSync(join(dir, "package.json"))) {
            const parent = dirname(dir);
            // build:binary places Bun's metadata inside dist/. Node still needs the
            // package root so its dist-relative asset paths do not become dist/dist/.
            if (basename(dir) === "dist" && existsSync(join(parent, "package.json"))) {
                return parent;
            }
            return dir;
        }
        dir = dirname(dir);
    }
    return startDir;
}
export function getPackageDir() {
    // Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
    const envDir = process.env.PI_PACKAGE_DIR;
    if (envDir) {
        return normalizePath(envDir);
    }
    if (isBunBinary) {
        // Bun binary: process.execPath points to the compiled executable
        return dirname(process.execPath);
    }
    return findNodePackageDir(__dirname);
}
/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/theme/
 * - For tsx (src/): src/modes/interactive/theme/
 */
export function getThemesDir() {
    if (isBunBinary) {
        return join(getPackageDir(), "theme");
    }
    // Theme is in modes/interactive/theme/ relative to src/ or dist/
    const packageDir = getPackageDir();
    const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
    return join(packageDir, srcOrDist, "modes", "interactive", "theme");
}
/**
 * Get path to HTML export template directory (shipped with package)
 * - For Bun binary: export-html/ next to executable
 * - For Node.js (dist/): dist/core/export-html/
 * - For tsx (src/): src/core/export-html/
 */
export function getExportTemplateDir() {
    if (isBunBinary) {
        return join(getPackageDir(), "export-html");
    }
    const packageDir = getPackageDir();
    const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
    return join(packageDir, srcOrDist, "core", "export-html");
}
/** Get path to package.json */
export function getPackageJsonPath() {
    return join(getPackageDir(), "package.json");
}
/** Get path to README.md */
export function getReadmePath() {
    return resolve(join(getPackageDir(), "README.md"));
}
/** Get path to docs directory */
export function getDocsPath() {
    return resolve(join(getPackageDir(), "docs"));
}
/** Get path to examples directory */
export function getExamplesPath() {
    return resolve(join(getPackageDir(), "examples"));
}
/** Get path to CHANGELOG.md */
export function getChangelogPath() {
    return resolve(join(getPackageDir(), "CHANGELOG.md"));
}
/**
 * Get path to built-in interactive assets directory.
 * - For Bun binary: assets/ next to executable
 * - For Node.js (dist/): dist/modes/interactive/assets/
 * - For tsx (src/): src/modes/interactive/assets/
 */
export function getInteractiveAssetsDir() {
    if (isBunBinary) {
        return join(getPackageDir(), "assets");
    }
    const packageDir = getPackageDir();
    const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
    return join(packageDir, srcOrDist, "modes", "interactive", "assets");
}
/** Get path to a bundled interactive asset */
export function getBundledInteractiveAssetPath(name) {
    return join(getInteractiveAssetsDir(), name);
}
let pkg = {};
try {
    pkg = JSON.parse(stripBom(readFileSync(getPackageJsonPath(), "utf-8")));
}
catch (e) {
    const err = e;
    if (err.code !== "ENOENT")
        throw e;
}
const piConfigName = pkg.piConfig?.name;
export const PACKAGE_NAME = pkg.name || "@yunuspi/coding-agent";
export const APP_NAME = "yunuspi";
export const APP_TITLE = "YunusPi";
export const CONFIG_DIR_NAME = pkg.piConfig?.configDir || ".pi";
export const VERSION = pkg.version || "0.0.0";
// e.g., PI_CODING_AGENT_DIR or TAU_CODING_AGENT_DIR
export const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
export const ENV_SESSION_DIR = "PI_CODING_AGENT_SESSION_DIR";
export function expandTildePath(path) {
    return normalizePath(path);
}
const DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/";
/** Get the share viewer URL for a gist ID. */
export function getShareViewerUrl(gistId) {
    const baseUrl = process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
    return `${baseUrl}#${gistId}`;
}
// =============================================================================
// User Config Paths (~/.pi/agent/*)
// =============================================================================
/** Get the agent config directory (e.g., ~/.pi/agent/) */
export function getAgentDir() {
    const envDir = process.env[ENV_AGENT_DIR];
    if (envDir) {
        return expandTildePath(envDir);
    }
    return join(homedir(), CONFIG_DIR_NAME, "agent");
}
/** Get path to user's custom themes directory */
export function getCustomThemesDir() {
    return join(getAgentDir(), "themes");
}
/** Get path to models.json */
export function getModelsPath() {
    return join(getAgentDir(), "models.json");
}
/** Get path to auth.json */
export function getAuthPath() {
    return join(getAgentDir(), "auth.json");
}
/** Get path to settings.json */
export function getSettingsPath() {
    return join(getAgentDir(), "settings.json");
}
/** Get path to tools directory */
export function getToolsDir() {
    return join(getAgentDir(), "tools");
}
/** Get path to managed binaries directory (fd, rg) */
export function getBinDir() {
    return join(getAgentDir(), "bin");
}
/** Get path to prompt templates directory */
export function getPromptsDir() {
    return join(getAgentDir(), "prompts");
}
/** Get path to sessions directory */
export function getSessionsDir() {
    return join(getAgentDir(), "sessions");
}
/** Get path to debug log file */
export function getDebugLogPath() {
    return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
