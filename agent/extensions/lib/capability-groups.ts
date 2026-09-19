/** Small, deterministic groups shared by optional tool and skill discovery.
 * Grouping uses only the catalog entry's name and description. It never reads
 * a skill body, calls a model, or treats catalog prose as instructions. */
import { oneEditAway } from './skill-relevance.ts';

export type CapabilityGroup = Readonly<{
  id: string;
  label: string;
  description: string;
}>;

export type CapabilityMetadata = Readonly<{
  name: string;
  description?: string;
}>;

/** Explicit discovery keeps short domain words (PHP/API/CSS) and ranks names
 * ahead of incidental prose. Substring scoring made API match "capital" and
 * board match "keyboard". Prefixes of longer words remain useful for queries
 * such as "diagnostic"; they never match inside an unrelated word. */
export function searchCapabilityMetadata<T extends CapabilityMetadata>(items: readonly T[], query: string): T[] {
  const tokens = (value: unknown, limit: number) => [...new Set(
    (String(value ?? '').slice(0, limit).toLowerCase().match(/[a-z0-9]+(?:\+\+|#)?/g) ?? [])
      .filter(term => term.length > 1),
  )];
  const terms = tokens(query, 256);
  const identity = (value: string) => value.toLowerCase().trim().replace(/[\s_:/.]+/g, '-').replace(/-+/g, '-');
  const exact = identity(query);
  const vocabulary = new Set(items.flatMap(item => tokens(`${item.name} ${item.description ?? ''}`, 4352)));
  return items.map(item => {
    const name = tokens(item.name, 256), description = tokens(item.description ?? '', 4096);
    const match = (words: string[], term: string) => words.includes(term) ? 2
      : term.length >= 4 && words.some(candidate => candidate.startsWith(term)) ? 1
      : term.length >= 6 && !vocabulary.has(term) && words.some(candidate => candidate.length >= 6 && oneEditAway(term, candidate)) ? 0.5 : 0;
    const score = !query.trim() ? 1 : identity(item.name) === exact ? 10000
      : terms.reduce((sum, term) => sum + 8 * match(name, term) + match(description, term), 0);
    return {item, score};
  }).filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
    .map(row => row.item);
}

/** Keep this list short: it is exposed in the discovery overview. The final
 * `other` bucket is intentional so every installed capability is reachable. */
export const CAPABILITY_GROUPS: readonly CapabilityGroup[] = Object.freeze([
  Object.freeze({
    id: "engineering",
    label: "Engineering",
    description: "Software, systems, APIs, testing and code quality.",
  }),
  Object.freeze({
    id: "web",
    label: "Web & UI",
    description: "Browser, web, frontend, accessibility and interface work.",
  }),
  Object.freeze({
    id: "data-ai",
    label: "Data & AI",
    description: "Data, analytics, machine learning and model workflows.",
  }),
  Object.freeze({
    id: "media",
    label: "Media & Creative",
    description: "Images, video, audio, animation and visual production.",
  }),
  Object.freeze({
    id: "documents",
    label: "Documents & Office",
    description: "Documents, spreadsheets, presentations and office files.",
  }),
  Object.freeze({
    id: "business",
    label: "Business & Finance",
    description: "Markets, finance, investment and business analysis.",
  }),
  Object.freeze({
    id: "operations",
    label: "Operations & Research",
    description: "Infrastructure, deployment, security, research and coordination.",
  }),
  Object.freeze({
    id: "other",
    label: "Other",
    description: "Installed capabilities outside the named groups.",
  }),
]);

const groupIds = new Set(CAPABILITY_GROUPS.map((group) => group.id));

// Match distinctive catalog vocabulary. Rules are ordered from the most
// user-facing/specialized family to the broad engineering and fallback
// families, so a capability receives exactly one stable group.
const RULES: readonly Readonly<{ id: string; pattern: RegExp }>[] = [
  {
    id: "media",
    pattern: /\b(?:media|image|photo|video|audio|sound|music|animation|animate|motion|visual|thumbnail|subtitle|narrator|faceless|ugc|higgsfield|photoshoot|youtube|blender|cad)\b/i,
  },
  {
    id: "documents",
    pattern: /\b(?:document|docs?|word|spreadsheet|excel|sheets?|presentation|slides?|powerpoint|pptx|pdf|office|libreoffice|letterhead|memo|report|template|google[- ](?:docs?|sheets?|slides?))\b/i,
  },
  {
    id: "business",
    pattern: /\b(?:business|finance|financial|investment|investor|market|markets|valuation|deal|merger|lbo|credit|underwriting|capital|covenant|forecast|banking|sales|strategy|company|private[- ]equity|three[- ]statement)\b/i,
  },
  {
    id: "data-ai",
    pattern: /\b(?:data|dataset|analytics?|machine[- ]learning|\bml\b|ai|llm|model|nlp|statistics?|inference|reinforcement|optimization|numerical|jupyter|notebook|experiment|kpi|metric|visuali[sz]e|classifier|fine[- ]tuning|rag)\b/i,
  },
  {
    id: "web",
    pattern: /\b(?:web|browser|frontend|front[- ]end|website|site|ui|ux|css|html|component|svg|accessib(?:ility|le)|seo|figma|three\.?js|wasm[- ]browser|webassembly)\b/i,
  },
  {
    id: "operations",
    pattern: /\b(?:cloud|deploy(?:ment)?|devops|infrastructure|linux|ubuntu|server|security|auth(?:entication|orization)?|github|git|ci(?:\/cd)?|docker|container|network|production|shell|terminal|research|search|coordination|project|todo|workflow)\b/i,
  },
  {
    id: "engineering",
    pattern: /\b(?:software|program(?:ming|mer)?|code|typescript|javascript|python|rust|golang|java|php|c\+\+|c#|compiler|algorithm|database|sql|api|testing|debug|concurren(?:cy|t)|memory|architecture|performance|systems?|contracts?|schema|runtime|wasm|type[- ]driven|property[- ]based|formal|simulation|physics|algorithm)\b/i,
  },
];

const normalize = (value: unknown) => (typeof value === "string" ? value : "")
  .toLowerCase().replace(/[\s_:/.+-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 4096);

// A few harness names are intentionally terse and need their own stable home;
// keeping these overrides name-only avoids common description words such as
// "session" or "process" pulling unrelated capabilities into operations.
const NAME_OVERRIDES: readonly Readonly<{ id: string; pattern: RegExp }>[] = [
  {id: "operations", pattern: /(?:^| )(?:subagent|swarm|fusion|council|bg|checkpoint|obs|session|process)(?: |$)/i},
  {id: "web", pattern: /(?:^| )(?:http|browser|web)(?: |$)/i},
  {id: "engineering", pattern: /(?:^| )(?:ast|lsp|symbol|syntax|diagnostic)(?: |$)/i},
];

/** Return one valid group id for a catalog entry. Names are authoritative
 * metadata for grouping; descriptions fill in generic names only. */
export function capabilityGroup(name: unknown, description: unknown = ""): string {
  const nameText = normalize(name);
  for (const rule of NAME_OVERRIDES) if (rule.pattern.test(nameText)) return rule.id;
  for (const rule of RULES) if (rule.pattern.test(nameText)) return rule.id;
  const descriptionText = normalize(description);
  for (const rule of RULES) if (rule.pattern.test(descriptionText)) return rule.id;
  return "other";
}

/** Return compact, deterministic counts per populated group. Counts use the
 * complete supplied catalog; the static descriptions carry no catalog text. */
export function groupOverview(items: readonly CapabilityMetadata[]): Array<{
  id: string;
  label: string;
  description: string;
  count: number;
}> {
  const counts = new Map<string, number>(CAPABILITY_GROUPS.map((group) => [group.id, 0]));
  for (const item of items ?? []) {
    const name = typeof item?.name === "string" ? item.name.trim().slice(0, 128) : "";
    if (!name) continue;
    const group = capabilityGroup(name, item.description);
    // The fallback also protects this helper if a future rule typo slips in.
    const id = groupIds.has(group) ? group : "other";
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const populated = CAPABILITY_GROUPS.filter((group) => (counts.get(group.id) ?? 0) > 0);
  const groups = populated.length ? populated : CAPABILITY_GROUPS;
  return groups.map((group) => ({
    id: group.id,
    label: group.label,
    description: group.description,
    count: counts.get(group.id) ?? 0,
  }));
}
