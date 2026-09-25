import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import ignore from "ignore";
import { basename, dirname, join, relative, resolve, sep } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { canonicalizePath, resolvePath } from "../utils/paths.js";
import { createSyntheticSourceInfo } from "./source-info.js";
/** Max name length per spec */
const MAX_NAME_LENGTH = 64;
/** Max description length per spec */
const MAX_DESCRIPTION_LENGTH = 1024;
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];
function toPosixPath(p) {
    return p.split(sep).join("/");
}
function prefixIgnorePattern(line, prefix) {
    const trimmed = line.trim();
    if (!trimmed)
        return null;
    if (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))
        return null;
    let pattern = line;
    let negated = false;
    if (pattern.startsWith("!")) {
        negated = true;
        pattern = pattern.slice(1);
    }
    else if (pattern.startsWith("\\!")) {
        pattern = pattern.slice(1);
    }
    if (pattern.startsWith("/")) {
        pattern = pattern.slice(1);
    }
    const prefixed = prefix ? `${prefix}${pattern}` : pattern;
    return negated ? `!${prefixed}` : prefixed;
}
function addIgnoreRules(ig, dir, rootDir) {
    const relativeDir = relative(rootDir, dir);
    const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";
    for (const filename of IGNORE_FILE_NAMES) {
        const ignorePath = join(dir, filename);
        if (!existsSync(ignorePath))
            continue;
        try {
            const content = readFileSync(ignorePath, "utf-8");
            const patterns = content
                .split(/\r?\n/)
                .map((line) => prefixIgnorePattern(line, prefix))
                .filter((line) => Boolean(line));
            if (patterns.length > 0) {
                ig.add(patterns);
            }
        }
        catch { }
    }
}
/**
 * Validate skill name per Agent Skills spec.
 * Returns array of validation error messages (empty if valid).
 */
function validateName(name) {
    const errors = [];
    if (name.length > MAX_NAME_LENGTH) {
        errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
    }
    if (!/^[a-z0-9-]+$/.test(name)) {
        errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
    }
    if (name.startsWith("-") || name.endsWith("-")) {
        errors.push(`name must not start or end with a hyphen`);
    }
    if (name.includes("--")) {
        errors.push(`name must not contain consecutive hyphens`);
    }
    return errors;
}
/**
 * Validate description per Agent Skills spec.
 */
function validateDescription(description) {
    const errors = [];
    if (typeof description !== "string" || description.trim() === "") {
        errors.push("description is required");
    }
    else if (description.length > MAX_DESCRIPTION_LENGTH) {
        errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
    }
    return errors;
}
function createSkillSourceInfo(filePath, baseDir, source) {
    switch (source) {
        case "user":
            return createSyntheticSourceInfo(filePath, {
                source: "local",
                scope: "user",
                baseDir,
            });
        case "project":
            return createSyntheticSourceInfo(filePath, {
                source: "local",
                scope: "project",
                baseDir,
            });
        case "path":
            return createSyntheticSourceInfo(filePath, {
                source: "local",
                baseDir,
            });
        default:
            return createSyntheticSourceInfo(filePath, { source, baseDir });
    }
}
/**
 * Load skills from a directory.
 *
 * Discovery rules:
 * - if a directory contains SKILL.md, treat it as a skill root and do not recurse further
 * - otherwise, load direct .md children in the root
 * - recurse into subdirectories to find SKILL.md
 */
export function loadSkillsFromDir(options) {
    const { dir, source } = options;
    return loadSkillsFromDirInternal(dir, source, true);
}
function loadSkillsFromDirInternal(dir, source, includeRootFiles, ignoreMatcher, rootDir, visited = new Set()) {
    const skills = [];
    const diagnostics = [];
    if (!existsSync(dir)) {
        return { skills, diagnostics };
    }
    const realDir = canonicalizePath(dir);
    if (visited.has(realDir))
        return { skills, diagnostics };
    visited.add(realDir);
    const root = rootDir ?? dir;
    const ig = ignoreMatcher ?? ignore();
    addIgnoreRules(ig, dir, root);
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "failed to read skills directory";
        diagnostics.push({ type: "warning", message, path: dir });
        return { skills, diagnostics };
    }
    try {
        for (const entry of entries) {
            if (entry.name !== "SKILL.md") {
                continue;
            }
            const fullPath = join(dir, entry.name);
            let isFile = entry.isFile();
            if (entry.isSymbolicLink()) {
                try {
                    isFile = statSync(fullPath).isFile();
                }
                catch {
                    continue;
                }
            }
            const relPath = toPosixPath(relative(root, fullPath));
            if (!isFile || ig.ignores(relPath)) {
                continue;
            }
            const result = loadSkillFromFile(fullPath, source);
            if (result.skill) {
                skills.push(result.skill);
            }
            diagnostics.push(...result.diagnostics);
            return { skills, diagnostics };
        }
        for (const entry of entries) {
            if (entry.name.startsWith(".")) {
                continue;
            }
            // Skip node_modules to avoid scanning dependencies
            if (entry.name === "node_modules") {
                continue;
            }
            const fullPath = join(dir, entry.name);
            // For symlinks, check if they point to a directory and follow them
            let isDirectory = entry.isDirectory();
            let isFile = entry.isFile();
            if (entry.isSymbolicLink()) {
                try {
                    const stats = statSync(fullPath);
                    isDirectory = stats.isDirectory();
                    isFile = stats.isFile();
                }
                catch {
                    // Broken symlink, skip it
                    continue;
                }
            }
            const relPath = toPosixPath(relative(root, fullPath));
            const ignorePath = isDirectory ? `${relPath}/` : relPath;
            if (ig.ignores(ignorePath)) {
                continue;
            }
            if (isDirectory) {
                const subResult = loadSkillsFromDirInternal(fullPath, source, false, ig, root, visited);
                skills.push(...subResult.skills);
                diagnostics.push(...subResult.diagnostics);
                continue;
            }
            if (!isFile || !includeRootFiles || !entry.name.endsWith(".md")) {
                continue;
            }
            const result = loadSkillFromFile(fullPath, source);
            if (result.skill) {
                skills.push(result.skill);
            }
            diagnostics.push(...result.diagnostics);
        }
    }
    catch (error) {
        // Never break startup, but never silently discard either: keep the
        // skills collected so far and record why this subtree stopped.
        const message = error instanceof Error ? error.message : "failed to scan skills directory";
        diagnostics.push({ type: "warning", message, path: dir });
    }
    return { skills, diagnostics };
}
function loadSkillFromFile(filePath, source) {
    const diagnostics = [];
    const isDeclaredSkill = basename(filePath) === "SKILL.md";
    let rawContent;
    try {
        rawContent = readFileSync(filePath, "utf-8");
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "failed to read skill file";
        diagnostics.push({ type: "warning", message, path: filePath });
        return { skill: null, diagnostics };
    }
    let frontmatter;
    try {
        ({ frontmatter } = parseFrontmatter(rawContent));
    }
    catch (error) {
        if (isDeclaredSkill) {
            const message = error instanceof Error ? error.message : "failed to parse skill file";
            diagnostics.push({ type: "warning", message, path: filePath });
        }
        return { skill: null, diagnostics };
    }
    const description = frontmatter.description;
    const hasDescription = typeof description === "string" && description.trim() !== "";
    if (!isDeclaredSkill && !hasDescription) {
        return { skill: null, diagnostics };
    }
    const skillDir = dirname(filePath);
    const parentDirName = basename(skillDir);
    // Validate description
    const descErrors = validateDescription(description);
    for (const error of descErrors) {
        diagnostics.push({ type: "warning", message: error, path: filePath });
    }
    // Use name from frontmatter, or fall back to parent directory name
    const frontmatterName = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
    const name = frontmatterName || parentDirName;
    // Validate name
    const nameErrors = validateName(name);
    for (const error of nameErrors) {
        diagnostics.push({ type: "warning", message: error, path: filePath });
    }
    // Still load the skill even with warnings, unless description is missing or empty.
    if (!hasDescription) {
        return { skill: null, diagnostics };
    }
    return {
        skill: {
            name,
            description,
            filePath,
            baseDir: skillDir,
            sourceInfo: createSkillSourceInfo(filePath, skillDir, source),
            disableModelInvocation: frontmatter["disable-model-invocation"] === true,
        },
        diagnostics,
    };
}
/**
 * Format skills for inclusion in a system prompt.
 * Uses XML format per Agent Skills standard.
 * See: https://agentskills.io/integrate-skills
 *
 * Skills with disableModelInvocation=true are excluded from the prompt
 * (they can only be invoked explicitly via /skill:name commands).
 */
export function formatSkillsForPrompt(skills, fileReadTool = "read") {
    const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
    if (visibleSkills.length === 0) {
        return "";
    }
    const lines = [
        "\n\nThe following skills provide specialized instructions for specific tasks.",
        fileReadTool === "read"
            ? "Use the read tool to load a skill's file when the task matches its description."
            : "Use bash to load a skill's file when the task matches its description.",
        "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
        "",
        "<available_skills>",
    ];
    for (const skill of visibleSkills) {
        lines.push("  <skill>");
        lines.push(`    <name>${escapeXml(skill.name)}</name>`);
        lines.push(`    <description>${escapeXml(skill.description)}</description>`);
        lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
        lines.push("  </skill>");
    }
    lines.push("</available_skills>");
    return lines.join("\n");
}
function escapeXml(str) {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
/**
 * Byte-compare two skill directories (SKILL.md parent dirs). True only when
 * both trees hold the same relative file set with identical bytes. Any
 * unreadable or non-regular path returns false so genuine conflicts keep
 * surfacing instead of being silenced.
 */
function sameSkillContent(fileA, fileB) {
    try {
        const snapshot = (file) => {
            const root = dirname(file);
            const entries = [];
            const visit = (dir) => {
                for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
                    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))
                        return null;
                    const full = join(dir, entry.name);
                    if (entry.isDirectory()) {
                        if (!visit(full))
                            return null;
                    }
                    else {
                        entries.push([relative(root, full), readFileSync(full)]);
                    }
                }
                return entries;
            };
            return visit(root);
        };
        const a = snapshot(fileA);
        const b = snapshot(fileB);
        if (!a || !b || a.length !== b.length)
            return false;
        return a.every(([rel, bytes], index) => b[index][0] === rel && bytes.equals(b[index][1]));
    }
    catch {
        return false;
    }
}
/**
 * Load skills from all configured locations.
 * Returns skills and any validation diagnostics.
 */
export function loadSkills(options) {
    const { agentDir, skillPaths, includeDefaults } = options;
    // Resolve agentDir - if not provided, use default from config
    const resolvedCwd = resolvePath(options.cwd);
    const resolvedAgentDir = resolvePath(agentDir ?? getAgentDir());
    const userSkillsDir = join(resolvedAgentDir, "skills");
    const projectSkillsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "skills");
    const isUnderPath = (target, root) => target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
    const skillMap = new Map();
    const realPathSet = new Set();
    const allDiagnostics = [];
    const collisionDiagnostics = [];
    function addSkills(result) {
        allDiagnostics.push(...result.diagnostics);
        for (const skill of result.skills) {
            // Resolve symlinks to detect duplicate files
            const realPath = canonicalizePath(skill.filePath);
            // Skip silently if we've already loaded this exact file (via symlink)
            if (realPathSet.has(realPath)) {
                continue;
            }
            const existing = skillMap.get(skill.name);
            if (existing) {
                // Ordered external paths may override the deployed catalogue.
                // Only silence that already-resolved direction; first path still wins.
                const resolvedMirror = isUnderPath(skill.filePath, userSkillsDir)
                    && !isUnderPath(existing.filePath, resolvedAgentDir)
                    && !isUnderPath(existing.filePath, projectSkillsDir);
                // Same name + byte-identical skill directories is a redundant
                // load path (e.g. a mirrored skills dir), not a conflict.
                if (!resolvedMirror && !sameSkillContent(existing.filePath, skill.filePath)) {
                    collisionDiagnostics.push({
                        type: "collision",
                        message: `name "${skill.name}" collision`,
                        path: skill.filePath,
                        collision: {
                            resourceType: "skill",
                            name: skill.name,
                            winnerPath: existing.filePath,
                            loserPath: skill.filePath,
                        },
                    });
                }
            }
            else {
                skillMap.set(skill.name, skill);
                realPathSet.add(realPath);
            }
        }
    }
    if (includeDefaults) {
        addSkills(loadSkillsFromDirInternal(join(resolvedAgentDir, "skills"), "user", true));
        addSkills(loadSkillsFromDirInternal(resolve(resolvedCwd, CONFIG_DIR_NAME, "skills"), "project", true));
    }
    const getSource = (resolvedPath) => {
        if (!includeDefaults) {
            if (isUnderPath(resolvedPath, userSkillsDir))
                return "user";
            if (isUnderPath(resolvedPath, projectSkillsDir))
                return "project";
        }
        return "path";
    };
    for (const rawPath of skillPaths) {
        const resolvedPath = resolvePath(rawPath, resolvedCwd, { trim: true });
        if (!existsSync(resolvedPath)) {
            allDiagnostics.push({ type: "warning", message: "skill path does not exist", path: resolvedPath });
            continue;
        }
        try {
            const stats = statSync(resolvedPath);
            const source = getSource(resolvedPath);
            if (stats.isDirectory()) {
                addSkills(loadSkillsFromDirInternal(resolvedPath, source, true));
            }
            else if (stats.isFile() && resolvedPath.endsWith(".md")) {
                const result = loadSkillFromFile(resolvedPath, source);
                if (result.skill) {
                    addSkills({ skills: [result.skill], diagnostics: result.diagnostics });
                }
                else {
                    allDiagnostics.push(...result.diagnostics);
                }
            }
            else {
                allDiagnostics.push({ type: "warning", message: "skill path is not a markdown file", path: resolvedPath });
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "failed to read skill path";
            allDiagnostics.push({ type: "warning", message, path: resolvedPath });
        }
    }
    return {
        skills: Array.from(skillMap.values()),
        diagnostics: [...allDiagnostics, ...collisionDiagnostics],
    };
}
