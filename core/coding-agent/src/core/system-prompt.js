/**
 * System prompt construction and project context loading
 */
import { getAgentDir, getDocsPath, getReadmePath } from "../config.js";
import { formatSkillsForPrompt } from "./skills.js";
import { loadWorkingNotes } from "./working-notes.js";
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
    // Tool habits that hold for every session. Judgment (reading the request,
    // craft, verification, reporting) lives in the working notes below.
    addGuideline("Before choosing an approach, weigh the tools, languages, engines and providers that fit the task on this machine and its real targets (servers, repositories, deploy paths); what the user named explicitly is decided, not an option.");
    addGuideline("Send every independent read, search or check you already know you need in one assistant turn, and chain dependent inspection steps into one shell command; each extra turn re-reads the whole conversation.");
    addGuideline("Do not repeat a file read or command whose result is already in context unless the file changed or a different range is needed.");
    addGuideline("Keep reasoning on routine tool continuations brief; reserve deep reasoning for design, diagnosis and failures.");
    addGuideline("Change files with edit or write. Do not use bash heredocs, python -c, perl -pi or sed -i to author or rewrite file content; use one edit call with multiple edits[] for separate locations in the same file.");
    addGuideline("Be concise, and show file paths clearly when working with files.");
    const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");
    const workingNotes = loadWorkingNotes(getAgentDir());
    let prompt = `You are YunusPi, an expert agent working on the user's own machine through the tools below. The work may be software, research, operating a browser, documents and data, design and media, or a task that mixes them; bring a senior practitioner's judgment to whichever it is.

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
    if (workingNotes) {
        prompt += `\n\n${workingNotes}`;
    }
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
