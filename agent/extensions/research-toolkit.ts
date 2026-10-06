/** Lightweight on-demand research toolkit: web-research planning (market or
 * prior-art), a read-only profile of the project at hand, lead / company /
 * contact capture, and provenance-aware source notes. Local-only, composable,
 * and lazy-loaded (not in CORE_TOOLS): no network, no writes, no credentials.
 * Compose with web_search/fetch_content/web_research/github_search for
 * retrieval, then verify primary sources before outreach or adoption. Full
 * behavior is on demand via tool_search; nothing here is permanently injected. */
import { createHash } from "node:crypto";
import { Type } from "typebox";

import { choices } from "./lib/tool-schema.ts";
import { profileProject } from "./lib/project-profile.ts";
import { researchDossier } from "./lib/research-evidence.ts";
import { readSourceFiles } from "./pi-lens/context-code.mjs";
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

const FILLER = new Set(["the", "and", "for", "with", "that", "this", "our", "your", "from", "into", "build", "builds", "building", "create", "make", "add", "implement", "improve", "better", "best", "new", "tool", "tools", "app", "apps", "feature", "features", "project", "please", "want", "need", "use", "using", "like", "should", "could", "would", "more", "some", "all", "any"]);

function planQueries(
  goal: string,
  context: string,
  mode: "leads" | "prior-art",
): { angles: string[]; template: string; githubQueries?: string[]; fallbackProviders?: string[]; sequence?: string[] } {
  const words = bounded(goal, 240)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (mode === "prior-art") {
    const keywords = words.filter((word) => word.length >= 3 && !FILLER.has(word)).slice(0, 5);
    const base = keywords.join(" ") || words.slice(0, 5).join(" ") || "software";
    // A second, broader angle: the two leading keywords usually name the subject.
    const subject = keywords.slice(0, 2).join(" ");
    const angles = [
      `${base} alternatives`,
      `${base} open source github`,
      `best ${base} comparison review`,
      `${base} limitations complaints`,
      `${base} architecture how it works`,
    ];
    if (context.trim()) angles.push(`${base} ${bounded(context, 80)}`);
    return {
      angles: angles.slice(0, 6),
      githubQueries: [...new Set([keywords.slice(0, 4).join(" ") || base, subject].filter(Boolean))],
      // Keyless reference indexes that keep working when general web search is cooling down.
      fallbackProviders: ["hackernews", "stackexchange", "npm"],
      sequence: [
        "profile the local project (research_toolkit profile) so the comparison has our side",
        "github_search repos with githubQueries (add one synonym angle), then repo for the 2-4 best candidates",
        "github_search issues sorted by reactions on the best candidates: what their users ask for or complain about",
        "web_research the angles (with fallbackProviders) for closed-source products and write-ups; read primary pages with fetch_content",
        "compare against the local profile and decide per candidate: adopt, adapt, reject or watch",
      ],
      template:
        "Per candidate: name, url, license, health, what it does that we do not, what we do better, evidence (quote + sourceUrl + retrievedAt), verdict (adopt|adapt|reject|watch) with one-line reason and effort. Prefer permissive licenses for anything adapted; record origin.",
    };
  }
  const base = words.slice(0, 8).join(" ") || "target market";
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
      "Plan research angles, profile the local project, capture source notes, or build a dossier from up to 32 source snapshots and claims. dossier checks exact quotes/hashes, groups duplicate sources, exposes missing citations and caller-labeled contradictions, and produces an attributable report. Pass a workspace JSON path for large collections or sources/claims inline; offset pages four rows. view report returns Markdown. No retrieval, writes, model call or factual-truth verdict. Compose with web_research/fetch_content and inspect context before concluding.",
    promptGuidelines: [
      "Use research_toolkit to plan angles, profile the local project, or normalize one lead/company/source with provenance (sourceUrl, retrievedAt, hash). Retrieve with web tools, verify primary sources, never fabricate contacts.",
    ],
    parameters: Type.Object({
      action: choices(["plan", "profile", "lead", "company", "source", "dossier"]),
      mode: Type.Optional(choices(["leads", "prior-art"])),
      path: Type.Optional(MAX_STR(1024)),
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
      sources: Type.Optional(Type.Array(Type.Object({
        id: MAX_STR(64), url: MAX_STR(2048), title: Type.Optional(MAX_STR(300)), text: MAX_STR(64000),
        kind: Type.Optional(choices(["primary", "secondary", "unknown"])),
        retrievedAt: Type.Optional(MAX_STR(64)), publishedAt: Type.Optional(MAX_STR(64)),
      }), { minItems: 1, maxItems: 32 })),
      claims: Type.Optional(Type.Array(Type.Object({
        id: MAX_STR(64), text: MAX_STR(1000), citations: Type.Array(Type.Object({
          sourceId: MAX_STR(64), quote: MAX_STR(1000), relation: choices(["supports", "contradicts", "context"]), sha256: Type.Optional(MAX_STR(64)),
        }), { maxItems: 6 }),
      }), { maxItems: 32 })),
      view: Type.Optional(choices(["compact", "report"])),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 31 })),
    }),
    async execute(_id: string, input: any, signal?: AbortSignal, _update?: any, ctx?: any) {
      const answer = (details: any, isError = false) => ({
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
        ...(isError ? { isError: true } : {}),
      });
      const action = input?.action;
      if (action === "dossier") {
        try {
          signal?.throwIfAborted();
          let data = input;
          if (input.path) {
            if (input.sources || input.claims) throw Error("Use a JSON path or inline sources/claims, not both");
            const snapshot = await readSourceFiles(ctx?.cwd ?? process.cwd(), [input.path], signal, (file: string) => /\.json$/i.test(file));
            if (snapshot.errors.length || !snapshot.files.length) throw Error("Dossier JSON is unavailable or outside the workspace; maximum file size is 256 KiB");
            data = { ...JSON.parse(snapshot.files[0].source), view: input.view };
          }
          const result = researchDossier(data, signal), offset = input.offset ?? 0;
          const page = { ...result, sources: result.sources.slice(offset, offset + 4), claims: result.claims.slice(offset, offset + 4),
            offset, nextOffset: offset + 4 < Math.max(result.sources.length, result.claims.length) ? offset + 4 : null };
          const output = input.view === 'report' ? result.report ?? '' : JSON.stringify(page);
          return { content: [{ type: 'text', text: output.length > 36000 ? output.slice(0, 35500) + '\n[Output truncated; use compact pages or fewer claims.]' : output }], details: result };
        } catch (error) { return answer({ error: signal?.aborted ? "Cancelled" : String(error instanceof Error ? error.message : error).slice(0, 300) }, true); }
      }
      if (action === "plan") {
        const goal = bounded(input.goal, 500);
        if (!goal) return answer({ error: "Supply a research goal." }, true);
        const result = {
          action,
          goal,
          ...planQueries(goal, bounded(input.context, 500), input.mode === "prior-art" ? "prior-art" : "leads"),
        };
        return answer(result);
      }
      if (action === "profile") {
        try {
          const profile = profileProject(bounded(input.path, 1024) || process.cwd());
          return answer({
            action,
            profile,
            next: "Compare with github_search action:repo facts (same keys: languages, license, signals) and with candidate READMEs; headings approximate claimed capabilities, not proof of them.",
          });
        } catch (error) {
          return answer({ error: `Cannot profile that path: ${error instanceof Error ? error.message.slice(0, 160) : "unreadable"}.` }, true);
        }
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
          error: "Unknown research action. Use plan, profile, lead, company, source, or dossier.",
        },
        true,
      );
    },
  });
}
