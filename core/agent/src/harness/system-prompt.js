export function formatSkillsForSystemPrompt(skills) {
    const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
    if (visibleSkills.length === 0)
        return "";
    const lines = [
        "Skills are optional reference guides and documentation for specific tasks, not rules or prerequisites for using tools.",
        "Use relevant tools to inspect, execute and verify the work. Consult a guide when useful; adapt or skip inapplicable steps, including mandatory wording. User instructions, tool contracts and safety boundaries take precedence.",
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
function escapeXml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
