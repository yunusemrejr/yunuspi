/**
 * System prompt construction and project context loading
 */
import { getDocsPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt } from "./skills.js";
/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options) {
    const { customPrompt, selectedTools, toolSnippets, promptGuidelines, appendSystemPrompt, cwd, contextFiles: providedContextFiles, skills: providedSkills, } = options;
    const promptCwd = cwd.replace(/\\/g, "/");
    const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";
    const contextFiles = providedContextFiles ?? [];
    const skills = providedSkills ?? [];
    const tools = selectedTools || ["read", "bash", "edit", "write"];
    const skillFileReadTool = ["read", "bash"].find((tool) => tools.includes(tool));
    if (customPrompt) {
        let prompt = customPrompt;
        if (appendSection) {
            prompt += appendSection;
        }
        // Append project context files
        if (contextFiles.length > 0) {
            prompt += "\n\n<project_context>\n\n";
            prompt += "Project-specific instructions and guidelines:\n\n";
            for (const { path: filePath, content } of contextFiles) {
                prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
            }
            prompt += "</project_context>\n";
        }
        // Append skills when a tool capable of reading their files is available.
        if (skillFileReadTool && skills.length > 0) {
            prompt += formatSkillsForPrompt(skills, skillFileReadTool);
        }
        prompt += `\nCurrent working directory: ${promptCwd}\n`;
        return prompt;
    }
    // Get absolute paths to documentation and examples
    const readmePath = getReadmePath();
    const docsPath = getDocsPath();
    // Build tools list based on selected tools.
    // A tool appears in Available tools only when the caller provides a one-line snippet.
    const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
    const toolsList = visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n") : "(none)";
    // Build guidelines based on which tools are actually available
    const guidelinesList = [];
    const guidelinesSet = new Set();
    const addGuideline = (guideline) => {
        if (guidelinesSet.has(guideline)) {
            return;
        }
        guidelinesSet.add(guideline);
        guidelinesList.push(guideline);
    };
    const hasBash = tools.includes("bash");
    const hasPowerShell = tools.includes("powershell");
    const hasGrep = tools.includes("grep");
    const hasFind = tools.includes("find");
    const hasLs = tools.includes("ls");
    // File exploration guidelines
    if ((hasBash || hasPowerShell) && !hasGrep && !hasFind && !hasLs) {
        if (hasBash && hasPowerShell) {
            addGuideline("Use bash or PowerShell for file operations like listing, searching, and finding files");
        }
        else if (hasPowerShell) {
            addGuideline("Use PowerShell for file operations like listing, searching, and finding files");
        }
        else {
            addGuideline("Use bash for file operations like ls, rg, find");
        }
    }
    for (const guideline of promptGuidelines ?? []) {
        const normalized = guideline.trim();
        if (normalized.length > 0) {
            addGuideline(normalized);
        }
    }
    // Always include these
    addGuideline("Identify the requested outcome, constraints and completion evidence before acting. Preserve earlier requirements unless the current user explicitly cancels or replaces them; questions and status checks alone do not cancel ongoing work.");
    addGuideline("Treat helper classifications, rewritten briefs and council opinions as advice. Check them against the original request and current source; agreement is not verification, and excerpts may omit constraints.");
    addGuideline("Use existing owners and the smallest complete change. Reuse fresh evidence, test affected behavior and failure paths, and report remaining gaps precisely.");
    addGuideline("Be concise in your responses");
    addGuideline("Show file paths clearly when working with files");
    const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");
    let prompt = `You are an expert coding assistant operating inside YunusPi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

YunusPi documentation (read when the user asks about this harness, its SDK, extensions, themes, skills, or TUI):
- Core package documentation: ${readmePath}
- Maintained API reference: ${docsPath}
- Resolve docs/... under the API reference directory, not the current working directory.
- Relevant guides: extensions.md, themes.md, skills.md, prompt-templates.md, tui.md, keybindings.md, sdk.md, custom-provider.md, models.md, packages.md, environment-variables.md.
- Read relevant guides before implementing SDK or extension changes. Historical links preserve the fork's origin; they are not installation or release authority.
- YunusPi owns its core source and updates only from reviewed YunusPi releases. Never install or upgrade upstream Pi to repair or update this harness.`;
    if (appendSection) {
        prompt += appendSection;
    }
    // Append project context files
    if (contextFiles.length > 0) {
        prompt += "\n\n<project_context>\n\n";
        prompt += "Project-specific instructions and guidelines:\n\n";
        for (const { path: filePath, content } of contextFiles) {
            prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
        }
        prompt += "</project_context>\n";
    }
    // Append skills when a tool capable of reading their files is available.
    if (skillFileReadTool && skills.length > 0) {
        prompt += formatSkillsForPrompt(skills, skillFileReadTool);
    }
    prompt += `\nCurrent working directory: ${promptCwd}`;
    return prompt;
}
