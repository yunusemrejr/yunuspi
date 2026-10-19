/**
 * skill_review — browse and search the installed skill catalogue.
 *
 * The prompt carries only a one-line catalogue summary when the library is
 * large, so this is how the agent finds a guide. Metadata only: it never reads
 * skill bodies, never ranks with a remote model, and creates no obligation.
 */
import { Type } from "typebox";
import { choices } from "./tool-schema.ts";
import { CAPABILITY_GROUPS, capabilityGroup, groupOverview, searchCapabilityMetadata } from "./capability-groups.ts";
import { buildSkillIndex, rankSkills } from "./skill-relevance.ts";

export type CatalogSkill = { name: string; description: string; file: string };

const decode = (value: string) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();

/** Installed skills from the prompt options, or from the catalogue block when only the text is available. */
export function catalogSkills(event: { systemPromptOptions?: { skills?: unknown }; systemPrompt?: unknown }): CatalogSkill[] {
	const configured = event?.systemPromptOptions?.skills;
	const listed = Array.isArray(configured)
		? configured.filter((skill: any) => !skill?.disableModelInvocation).map((skill: any) => ({ name: skill?.name, description: skill?.description ?? "", file: skill?.filePath }))
		: [...String(event?.systemPrompt ?? "").matchAll(/<skill>\s*<name>([^]*?)<\/name>\s*<description>([^]*?)<\/description>\s*<location>([^]*?)<\/location>\s*<\/skill>/g)]
			.map((match) => ({ name: decode(match[1]), description: decode(match[2]), file: decode(match[3]) }));
	const seen = new Set<string>();
	return listed.filter((skill): skill is CatalogSkill => {
		if (typeof skill.name !== "string" || !skill.name || typeof skill.description !== "string" || typeof skill.file !== "string" || !skill.file || seen.has(skill.file)) return false;
		seen.add(skill.file);
		return true;
	});
}

export function registerSkillReview(pi: any): void {
	let skills: CatalogSkill[] = [];
	let index: ReturnType<typeof buildSkillIndex> | undefined;
	pi.on?.("before_agent_start", (event: any) => {
		const next = catalogSkills(event);
		if (next.length && JSON.stringify(next) !== JSON.stringify(skills)) {
			skills = next;
			index = undefined;
		}
	});
	const search = (query: string, group: string, limit: number, offset: number) => {
		const candidates = skills.filter((skill) => !group || capabilityGroup(skill.name, skill.description) === group);
		let ordered = [...candidates].sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
		if (query) {
			index ??= buildSkillIndex(skills);
			const ranked = rankSkills(index, query, Math.min(256, Math.max(8, skills.length))).map((item: any) => item.skill as CatalogSkill)
				.filter((skill) => !group || capabilityGroup(skill.name, skill.description) === group);
			ordered = [...searchCapabilityMetadata(candidates, query), ...ranked];
		}
		const seen = new Set<string>();
		const unique = ordered.filter((skill) => !seen.has(skill.file) && Boolean(seen.add(skill.file)));
		const page = unique.slice(offset, offset + limit);
		return {
			results: page.map((skill) => ({ name: skill.name, path: skill.file, description: skill.description.slice(0, 240) })),
			offset, limit, remaining: Math.max(0, unique.length - offset - page.length),
		};
	};
	pi.registerTool?.({
		name: "skill_review", label: "Skill review",
		description: "Find installed skill guides: browse groups, or search names and descriptions. Read a chosen SKILL.md with read. Metadata only; skills never gate tool use.",
		parameters: Type.Object({
			action: choices(["browse", "search"]),
			group: Type.Optional(Type.String({ maxLength: 64, description: "Group id from browse; optional filter." })),
			query: Type.Optional(Type.String({ maxLength: 256, description: "Case-insensitive name or description query." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, default: 3, description: "Maximum results (default 3)." })),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Page offset." })),
		}),
		async execute(_id: string, input: any) {
			let group = typeof input.group === "string" ? input.group.trim().slice(0, 64) : "";
			let query = typeof input.query === "string" ? input.query.trim().slice(0, 256) : "";
			// A topic sent as a group ("motion", "3d") is a search term, not a failed call.
			const topic = group && !CAPABILITY_GROUPS.some((candidate) => candidate.id === group) ? group : "";
			if (topic) { group = ""; query = `${query} ${topic}`.trim(); }
			if (input.action === "browse" && !group && !query) {
				const result = { groups: groupOverview(skills), note: "Supply group or query for a short page of skills." };
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
			}
			const limit = Number.isInteger(input.limit) ? Math.min(8, Math.max(1, input.limit)) : 3;
			const offset = Number.isSafeInteger(input.offset) ? Math.max(0, input.offset) : 0;
			const page = search(query, group, limit, offset);
			const result = {
				query, ...(group ? { group } : {}), ...(topic ? { unknownGroup: topic, groups: CAPABILITY_GROUPS.map((candidate) => candidate.id) } : {}),
				...page, nextOffset: page.remaining ? offset + page.results.length : null,
				next: "Read a chosen result.path with the read tool when useful.",
			};
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
}
