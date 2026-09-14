/** Lightweight on-demand research toolkit: web-research planning, lead /
 * company / contact capture, and provenance-aware source notes. Local-only,
 * composable, and lazy-loaded (not in CORE_TOOLS): no network, no writes, no
 * credentials. Compose with web_search/fetch_content/web_research for
 * retrieval, then verify primary sources before outreach. Full behavior is on
 * demand via tool_search; nothing here is permanently injected. */
import { createHash } from "node:crypto";
import { Type } from "typebox";

const MAX_STR = (maxLength: number) => Type.String({ maxLength });
const bounded = (value: unknown, limit: number): string =>
  typeof value === "string" ? value.trim().slice(0, limit) : "";
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);
const retrievedAt = (value: unknown): string => {
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value.trim());
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
};
const urlOk = (value: string): boolean => {
  if (!value || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

function planQueries(
  goal: string,
  context: string,
): { angles: string[]; template: string } {
  const terms = bounded(goal, 240)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 8);
  const base = terms.join(" ") || "target market";
  const angles = [
    `${base} official site`,
    `${base} pricing customers`,
    `${base} competitors alternatives`,
    `${base} contact leadership`,
  ];
  if (context.trim()) angles.push(`${base} ${bounded(context, 80)}`);
  return {
    angles: angles.slice(0, 5),
    template:
      "For each angle, record: query, sourceUrl, retrievedAt, quote, sha256(quote+url).",
  };
}

export default function registerResearchToolkit(pi: any) {
  pi.registerTool({
    name: "research_toolkit",
    label: "Research toolkit",
    description:
      "Plan research angles and capture lead/company/contact candidates plus provenance-aware source notes. Local-only: no retrieval, no writes, no credentials. Compose with web_search/fetch_content/web_research, then verify primary sources.",
    promptGuidelines: [
      "Use research_toolkit to plan angles or normalize one lead/company/source with provenance (sourceUrl, retrievedAt, hash). Retrieve with web tools, verify primary sources, never fabricate contacts.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("plan"),
        Type.Literal("lead"),
        Type.Literal("company"),
        Type.Literal("source"),
      ]),
      goal: Type.Optional(MAX_STR(500)),
      context: Type.Optional(MAX_STR(500)),
      name: Type.Optional(MAX_STR(200)),
      company: Type.Optional(MAX_STR(200)),
      role: Type.Optional(MAX_STR(200)),
      domain: Type.Optional(MAX_STR(253)),
      sourceUrl: Type.Optional(MAX_STR(2048)),
      evidence: Type.Optional(MAX_STR(2000)),
      quote: Type.Optional(MAX_STR(2000)),
      retrievedAt: Type.Optional(MAX_STR(64)),
    }),
    async execute(_id: string, input: any) {
      const answer = (details: any, isError = false) => ({
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
        ...(isError ? { isError: true } : {}),
      });
      const action = input?.action;
      if (action === "plan") {
        const goal = bounded(input.goal, 500);
        if (!goal) return answer({ error: "Supply a research goal." }, true);
        const result = {
          action,
          goal,
          ...planQueries(goal, bounded(input.context, 500)),
        };
        return answer(result);
      }
      if (action === "lead" || action === "company") {
        const label =
          action === "lead"
            ? bounded(input.name, 200)
            : bounded(input.company, 200);
        const sourceUrl = bounded(input.sourceUrl, 2048);
        if (!label)
          return answer(
            {
              error:
                action === "lead"
                  ? "Supply a lead name."
                  : "Supply a company name.",
            },
            true,
          );
        if (!urlOk(sourceUrl))
          return answer(
            { error: "Supply a valid http(s) sourceUrl as provenance." },
            true,
          );
        const at = retrievedAt(input.retrievedAt);
        const evidence = bounded(input.evidence ?? input.quote, 2000);
        const record: any = {
          action,
          ...(action === "lead" ? { name: label } : { company: label }),
          ...(bounded(input.role, 200)
            ? { role: bounded(input.role, 200) }
            : {}),
          ...(bounded(input.domain, 253)
            ? { domain: bounded(input.domain, 253) }
            : {}),
          sourceUrl,
          retrievedAt: at,
          ...(evidence ? { evidence } : {}),
          provenance: hash(`${label}|${sourceUrl}|${at}|${evidence}`),
          next: "Verify against the primary source before outreach; store verbatim evidence with evidence_cache when it must be reused.",
        };
        return answer(record);
      }
      if (action === "source") {
        const sourceUrl = bounded(input.sourceUrl, 2048);
        const quote = bounded(input.quote ?? input.evidence, 2000);
        if (!urlOk(sourceUrl))
          return answer({ error: "Supply a valid http(s) sourceUrl." }, true);
        if (!quote)
          return answer({ error: "Supply a verbatim quote to gather." }, true);
        const at = retrievedAt(input.retrievedAt);
        return answer({
          action,
          sourceUrl,
          retrievedAt: at,
          quote,
          sha256: hash(`${quote}|${sourceUrl}`),
          next: "Quote is evidence, not conclusion; verify the primary source and keep inference separate.",
        });
      }
      return answer(
        {
          error: "Unknown research action. Use plan, lead, company, or source.",
        },
        true,
      );
    },
  });
}
