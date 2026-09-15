/** Offline capability audits: ranking calibration, discovery coverage, grant fit.
 * Pure and deterministic: callers supply health-log-shaped events, the skill
 * catalogue, or a launch grant; nothing reads the filesystem or the network.
 * Skill health events carry path hashes, so callers resolve hashes to names
 * through the catalogue before asking about calibration. */
import {buildSkillIndex, skillTerms, type SkillInfo} from './skill-relevance.ts';
import {skillRoutes} from './skill-routing.ts';

export interface RankCalibrationEvent {
  /** route: explicit regex/file route; rank: statistical catalogue rank; read: receipt. */
  kind: 'route' | 'rank' | 'read';
  skill: string;
  /** Rank score (context ranks only). */
  score?: number;
  /** Read receipts: full body (false/omitted counts partial). */
  full?: boolean;
}
export interface RankCalibrationReport {
  skills: Record<string, { offered: number; readFull: number; readPartial: number; unread: number; meanScore: number | undefined }>;
  sources: { route: { offered: number; read: number }; rank: { offered: number; read: number } };
  readThroughRate: number | undefined;
}
const MAX_EVENTS = 4096;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
/** Join recommendations to read receipts. Reads join the earliest unmatched
 * offer of the same skill; offers without reads stay unread, never invented. */
export function auditRankingCalibration(events: readonly RankCalibrationEvent[]): RankCalibrationReport {
  const per = new Map<string, { offered: number; readFull: number; readPartial: number; scores: number[] }>();
  const sources = {route: {offered: 0, read: 0}, rank: {offered: 0, read: 0}};
  const pending = new Map<string, Array<'route' | 'rank'>>();
  const cell = (skill: string) => {
    let c = per.get(skill);
    if (!c) { c = {offered: 0, readFull: 0, readPartial: 0, scores: []}; per.set(skill, c); }
    return c;
  };
  for (const e of (Array.isArray(events) ? events : []).slice(0, MAX_EVENTS)) {
    if (!e || typeof e !== 'object' || (e.kind !== 'route' && e.kind !== 'rank' && e.kind !== 'read')
      || typeof e.skill !== 'string' || !e.skill || e.skill.length > 200) continue;
    if (e.kind === 'read') {
      const queue = pending.get(e.skill);
      const source = queue?.shift();
      if (!source) continue;
      const c = cell(e.skill);
      if (e.full === true) c.readFull++; else c.readPartial++;
      sources[source].read++;
      continue;
    }
    const c = cell(e.skill);
    c.offered++;
    sources[e.kind].offered++;
    if (e.kind === 'rank' && typeof e.score === 'number' && Number.isFinite(e.score)) c.scores.push(e.score);
    const queue = pending.get(e.skill) ?? [];
    queue.push(e.kind);
    pending.set(e.skill, queue.slice(-64));
  }
  const skills: RankCalibrationReport['skills'] = {};
  let offers = 0, reads = 0;
  for (const [skill, c] of per) {
    offers += c.offered;
    reads += c.readFull + c.readPartial;
    skills[skill] = {offered: c.offered, readFull: c.readFull, readPartial: c.readPartial,
      unread: Math.max(0, c.offered - c.readFull - c.readPartial),
      meanScore: c.scores.length ? round3(c.scores.reduce((a, b) => a + b, 0) / c.scores.length) : undefined};
  }
  return {skills, sources, readThroughRate: offers ? round3(reads / offers) : undefined};
}

export interface DiscoveryCoverageReport {
  total: number; evaluated: number; routed: number; rankable: number;
  /** Rankable only when the context already names the skill: enrich these descriptions. */
  nameOnly: string[];
  /** Unreachable by route and by ranking alike: must be zero. */
  orphans: string[];
}
/** Maximum-achievable match per skill under rankSkills' exact gate: every
 * description term present (discovery vocabulary), then every doc term present
 * (the context already names the skill). Names alone almost always rank, so
 * orphans indicate a broken name or an empty description. */
export function auditDiscoveryCoverage(skills: readonly SkillInfo[]): DiscoveryCoverageReport {
  const list = (Array.isArray(skills) ? skills : []).filter(s => s && typeof s === 'object'
    && typeof s.name === 'string' && s.name && typeof s.description === 'string' && typeof s.file === 'string');
  const index = buildSkillIndex(list);
  const routed = new Set(skillRoutes.map(r => r.name));
  const namingCache = new Map<string, boolean>();
  const isNaming = (term: string): boolean => {
    const hit = namingCache.get(term);
    if (hit !== undefined) return hit;
    let carried = 0, inName = 0;
    for (const doc of index.docs) {
      if (!doc.tokens.has(term)) continue;
      carried++;
      if (doc.name.has(term)) inName++;
    }
    const v = inName > 0 && inName * 2 >= carried;
    namingCache.set(term, v);
    return v;
  };
  const gates = (doc: (typeof index.docs)[number], terms: Set<string>): boolean => {
    let score = 0, rare = 0, matched = 0, nameMatches = 0, namingMatches = 0;
    for (const term of terms) {
      const w = index.weight.get(term);
      if (!w || !doc.tokens.has(term)) continue;
      matched++;
      const inName = doc.name.has(term);
      score += w * (inName ? 2 : 1);
      if (inName) nameMatches++;
      if (inName && isNaming(term)) namingMatches++;
      if (index.strong.has(term)) rare++;
    }
    const singleName = matched === 1 && rare >= 1 && nameMatches === 1 && namingMatches === 1;
    return (matched >= 2 || singleName) && rare >= 1 && score >= 6;
  };
  const nameOnly: string[] = [], orphans: string[] = [];
  let rankable = 0;
  for (const doc of index.docs) {
    if (gates(doc, new Set(skillTerms(doc.skill.description)))) { rankable++; continue; }
    if (gates(doc, doc.tokens)) nameOnly.push(doc.skill.name);
    else orphans.push(doc.skill.name);
  }
  return {total: list.length, evaluated: index.docs.length, routed: index.docs.filter(d => routed.has(d.skill.name)).length,
    rankable, nameOnly: nameOnly.sort(), orphans: orphans.sort()};
}

export interface EffectiveGrantInput {
  task?: string;
  requestedTools?: readonly string[];
  effectiveTools: readonly string[];
  removedTools?: readonly string[];
}
export interface EffectiveGrantFlag { code: 'media-blind' | 'requested-removed' | 'empty-grant'; detail: string }
const IMAGE_TASK = /\b(images?|pixels?|screenshots?|mockups?|wireframes?|rendered output|visually)\b/i;
const INSPECT_VERB = /\b(inspect|verify|check|review|compare|audit|validate|confirm|look|see|examine)\b/i;
const NO_TOOLS = /\b(no tools|without tools)\b/i;
const IMAGE_INSPECTION_TOOLS = new Set(['render_see', 'browser_session']);
const cleanTools = (tools: readonly unknown): string[] => (Array.isArray(tools) ? tools : [])
  .filter((t): t is string => typeof t === 'string' && !!t && t.length <= 128).slice(0, 128);
/** Flag launch grants that cannot serve the task. Fail-open: malformed input
 * yields no flags. The media-blind rule caught retrospectively: a 260k-token
 * vision run stalled with zero pixels inspected because the effective grant
 * held no image-capable tool. */
export function auditEffectiveGrant(input: EffectiveGrantInput): EffectiveGrantFlag[] {
  if (!input || typeof input !== 'object') return [];
  const flags: EffectiveGrantFlag[] = [];
  const task = typeof input.task === 'string' ? input.task.slice(0, 8192) : '';
  const effective = cleanTools(input.effectiveTools);
  const removed = new Set(cleanTools(input.removedTools ?? []));
  if (task && !effective.length && !NO_TOOLS.test(task))
    flags.push({code: 'empty-grant', detail: 'substantive task with an empty effective tool grant'});
  if (task && IMAGE_TASK.test(task) && INSPECT_VERB.test(task)
    && !effective.some(t => IMAGE_INSPECTION_TOOLS.has(t)))
    flags.push({code: 'media-blind', detail: 'image-inspection task with no image-capable tool in the effective grant'});
  const denied = cleanTools(input.requestedTools ?? []).filter(t => removed.has(t)).slice(0, 8);
  if (denied.length) flags.push({code: 'requested-removed', detail: `explicitly requested but removed: ${denied.join(', ')}`});
  return flags.slice(0, 8);
}
