import { sessionObservability } from './session-observability.ts';
/** Catalog-wide advisory skill relevance. Pure and deterministic: no I/O,
 * inference, timers or scanning of tool-output prose. It scores the loaded
 * available-skills catalogue's own name/description tokens against bounded
 * session context terms; skill bodies are never read or injected. The reminder
 * owner still applies catalogue availability, delivery and lifecycle limits. */
import {candidateRelevance} from './local-intelligence.mjs';
export type SkillInfo = { name: string; file: string; description: string };
export type SkillIndex = {
  docs: { skill: SkillInfo; tokens: Set<string>; name: Set<string> }[];
  weight: Map<string, number>;
  strong: Set<string>;
};
export type Ranked = { skill: SkillInfo; score: number; matched: string[] };

const MIN_TERM = 4, MAX_TERM = 31, MAX_TERMS = 400, MAX_CONTEXT_CHARS = 65536;
const FUZZY_MIN_TERM = 6;
const SHORT_DOMAINS = new Set('ai ml ui ux api css sql php pdf csv cad llm rag wasm c++ c# js ts'.split(' '));
const usefulTerm = (term: string) => term.length >= MIN_TERM || SHORT_DOMAINS.has(term);
// Common prose that would otherwise let a generic description match any task.
// The trailing methodology words are mindset boilerplate, not domain signal: a
// website palette session matched "evaluation workflows focused" strongly enough
// to recommend a small-model skill ten times while the palette terms lost.
const STOP = new Set(("with this that from work task tasks when into your using used user users code files file skill skills workflow checks check verify ensure keep kept only before after other more most less than then them they must does each example examples actual current project projects relevant preserve existing avoid without within between during possible apply applies report reports about which where while there their these those have has been being will would should could would state states visible local needed needs need make makes made take takes gives given each other same different only also just like such very well over under more most much many some any all not use used uses using do don't doesn't did doing done also into onto off out up down here when whenever whether either neither because since until unless though although even still yet already always never often sometimes usually rarely truly simply really quite rather about above below across along among around behind beyond despite except inside outside through toward towards upon versus via per plus minus okay fine good better best great hard easy simple simply own hands hand thing things part parts area areas case cases time times day days week weeks month months year years first second third last next new old start starts started begin begins began end ends ended stop stops stopped run runs ran running step steps phase phases stage stages level levels type types kind kinds form forms mode modes way ways point points item items unit units value values number numbers set sets list lists page pages line lines word words text texts name names path paths file files data info information note notes result results output outputs input inputs cause causes effect effects issue issues problem problems error errors change changes changed update updates updated add adds added remove removes removed fix fixes fixed build builds built make makes create creates created write writes wrote read reads review review inspected inspect look looks look at see sees seen show shows shown tell tells told ask asks asked need needs needed want wants wanted give gives given get gets got take takes took put puts plus also item number part thing side top bottom front back left right open closes close closed full empty high low long short big small fast slow early late hard soft sure certain likely probably maybe perhaps almost nearly roughly approx also etc eg ie vs ok focused workflows evaluation evaluate adapt quality platform systems making title").split(/\s+/).filter(Boolean));
/** Lowercased discriminating terms from text. Bounded, deduplicated, no stemming.
 * Hyphen/underscore compounds also contribute their parts, so "design-token"
 * matches token vocabularies and "colour-only" can meet "color" through the
 * bounded fuzzy match. Dots stay whole: "node.js" must not become "node". */
export function skillTerms(text: string, limit = MAX_TERMS): string[] {
  const out = new Set<string>();
  if (!Number.isFinite(limit) || limit <= 0) return [];
  limit = Math.min(MAX_TERMS, Math.floor(limit));
  const add = (term: string) => {
    if (!usefulTerm(term) || term.length > MAX_TERM || STOP.has(term)) return;
    out.add(term);
  };
  const wholes: string[] = [];
  for (const match of String(text ?? "").slice(0, MAX_CONTEXT_CHARS).toLowerCase().matchAll(/[a-z][a-z0-9+#._-]{0,50}/g)) {
    const term = match[0].replace(/[._]+$/, "");
    if (!usefulTerm(term) || term.length > MAX_TERM || STOP.has(term)) continue;
    out.add(term);
    wholes.push(term);
    if (out.size >= limit) break;
  }
  for (const whole of wholes) {
    if (!/[-_]/.test(whole)) continue;
    for (const part of whole.split(/[-_]+/)) {
      add(part);
      if (out.size >= limit) break;
    }
    if (out.size >= limit) break;
  }
  return [...out];
}
/** Translate successful native operation metadata into a small domain signal.
 * Callers retain lifecycle/opt-out ownership. Never accepts tool-output prose,
 * absolute directory names or inferred file contents as routing instructions. */
export function skillEvidenceContext(evidence: { files?: readonly string[]; tools?: readonly string[] }): string {
  const terms = new Set<string>();
  const extensions: Record<string,string> = {
    ts:'typescript', tsx:'typescript browser interface', js:'javascript', jsx:'javascript browser interface',
    css:'stylesheet responsive browser interface', html:'markup browser interface', vue:'browser interface', svelte:'browser interface',
    py:'python', php:'php application', rs:'rust', go:'golang', java:'java', cs:'dotnet',
    c:'c-systems native memory', cpp:'c++ native memory', cc:'c++ native memory', hpp:'c++ native memory', sql:'database transactions queries',
    csv:'tabular dataset', parquet:'tabular dataset', xlsx:'spreadsheet workbook', ipynb:'python notebook',
    docx:'document authoring', pptx:'presentation slides', pdf:'document pdf', wasm:'webassembly',
    json:'configuration schema', jsonl:'configuration schema', yaml:'configuration schema', yml:'configuration schema', toml:'configuration schema',
    md:'documentation', markdown:'documentation',
    sh:'shell scripting', bash:'shell scripting',
  };
  for (const file of (evidence.files ?? []).slice(-32)) {
    if (typeof file !== 'string' || file.length > 4096) continue;
    const basename = file.split(/[\\/]/).at(-1)!.toLowerCase();
    if (basename === 'skill.md') continue; // reading guidance is not task-domain evidence
    const extension = basename.split('.').at(-1)!;
    const signal = Object.hasOwn(extensions, extension) ? extensions[extension] : undefined;
    if (signal) terms.add(signal);
    if (/^(?:openapi|swagger)\.(?:json|ya?ml)$/.test(basename)) terms.add('api contracts schema');
    if (/^(?:dockerfile|compose\.ya?ml|docker-compose\.ya?ml)$/.test(basename)) terms.add('containers deployment');
  }
  const operations: Record<string,string> = {
    sqlite_probe:'database queries', sql_query:'database queries', coverage_probe:'testing coverage',
    openapi_probe:'api contracts schema', contract_diff:'api contract compatibility',
    lsp_diagnostics:'compiler diagnostics', render_see:'visual browser verification',
    browser:'browser interaction', dependency_plan:'dependency architecture',
    agentmail_status:'email inbox', agentmail_messages:'email inbox', agentmail_search:'email inbox',
    agentmail_message:'email inbox', agentmail_send:'email outreach',
  };
  for (const name of (evidence.tools ?? []).slice(-32)) if (typeof name === 'string' && Object.hasOwn(operations, name)) terms.add(operations[name]);
  return [...terms].join(' ').slice(0,1600);
}
export function buildSkillIndex(skills: readonly SkillInfo[]): SkillIndex {
  // The model-backed discovery packet has its own 256-entry budget, but this
  // index is local metadata only. Truncating here made skills after the first
  // 256 invisible to deterministic routing even though skill_review could
  // browse and search the complete catalogue. Keep every supplied entry; the
  // token and context bounds below still cap per-request work.
  const docs = skills.map(skill => {
    // Hyphenated catalogue names should match ordinary task prose too.
    const name = new Set(skillTerms(`${skill.name} ${skill.name.replace(/[-_:/.]+/g, ' ')}`, 24));
    return { skill, name, tokens: new Set([...name, ...skillTerms(skill.description)]) };
  });
  const df = new Map<string, number>();
  for (const doc of docs) for (const term of doc.tokens) df.set(term, (df.get(term) ?? 0) + 1);
  const total = Math.max(1, docs.length);
  // Rarity points are normalized so a catalogue-unique term scores 10.
  const scale = 10 / (1 + Math.log(total));
  const weight = new Map<string, number>();
  const strong = new Set<string>();
  // Terms shared by more than 30% of skills carry no routing signal.
  for (const [term, count] of df) {
    if (count / total > 0.3) continue;
    weight.set(term, scale * (1 + Math.log(total / count)));
    if (count <= Math.max(1, Math.round(total * 0.15))) strong.add(term);
  }
  return { docs, weight, strong };
}

/**
 * Return whether two bounded tokens differ by one insertion, deletion,
 * substitution or adjacent transposition. This is deliberately a single
 * edit: skill routing should recover common typos without turning a weak
 * lexical overlap into a recommendation.
 */
export function oneEditAway(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return a === b;
  if (a.length === b.length) {
    const different: number[] = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) different.push(i);
    if (different.length === 1) return true;
    return different.length === 2 && different[1] === different[0] + 1
      && a[different[0]] === b[different[1]]
      && a[different[1]] === b[different[0]];
  }
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  let i = 0, j = 0, skipped = false;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) { i++; j++; continue; }
    if (skipped) return false;
    skipped = true; j++;
  }
  return true;
}

/** Select one deterministic close token from a document, if any. */
function fuzzyToken(index: SkillIndex, doc: SkillIndex["docs"][number], term: string): string | undefined {
  if (term.length < FUZZY_MIN_TERM) return undefined;
  let best: string | undefined;
  let bestScore = -1;
  for (const token of doc.tokens) {
    if (token.length < FUZZY_MIN_TERM || Math.abs(token.length - term.length) > 1 || !oneEditAway(term, token)) continue;
    const score = (index.strong.has(token) ? 2 : 1) * (index.weight.get(token) ?? 0);
    if (score > bestScore || score === bestScore && token < (best ?? "\uffff")) {
      best = token; bestScore = score;
    }
  }
  return best;
}
/** Bounded heading outline of a skill body: H2/H3 headings with 1-based lines.
 * Pure, so section targeting is testable without touching the filesystem. */
export function headingOutline(markdown: string, limit = 200): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  const lines = String(markdown ?? "").split("\n");
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const match = /^#{2,3}\s+(.+?)\s*$/.exec(lines[i]);
    if (match) out.push({ text: match[1].slice(0, 120), line: i + 1 });
  }
  return out;
}
/** Follow-on `references/` paths linked from a skill body, deduplicated and
 * bounded. Pure. */
export function skillReferenceLinks(markdown: string, limit = 6): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of String(markdown ?? "").matchAll(/\]\((references\/[^)#\s]+)(?:#[^)]*)?\)/g)) {
    const link = match[1].slice(0, 120);
    if (!seen.has(link)) { seen.add(link); out.push(link); }
    if (out.length >= limit) break;
  }
  return out;
}
/** Best heading for a bounded term list; needs at least one discriminating
 * match, so a generic "Overview" heading is never chosen for its own sake. */
export function bestSkillSection(headings: readonly { text: string; line: number }[], terms: readonly string[]): { text: string; line: number } | undefined {
  let best: { text: string; line: number } | undefined, bestScore = 0;
  for (const heading of headings) {
    const tokens = new Set(skillTerms(heading.text, 24));
    let score = 0;
    for (const term of terms) if (tokens.has(term)) score++;
    if (score > bestScore) { best = heading; bestScore = score; }
  }
  return best;
}
/** Rank catalogue skills against bounded context. Requires at least two
 * matched discriminating terms and one strongly rare term; weak or generic
 * overlap yields nothing rather than a speculative recommendation. A single
 * edit fuzzy match is allowed only for sufficiently long tokens and receives
 * a discount, so a typo can recover a skill without broadening ordinary
 * generic matches. */
export function rankSkills(index: SkillIndex, context: string, limit = 4): Ranked[] {
  const terms = skillTerms(context, 64);
  if (!terms.length) return [];
  // A catalogue term is naming when at least half of the documents that carry
  // it also carry it in their skill name. Counted per queried term only, so the
  // cost stays bounded by the context rather than the whole catalogue. This is
  // what keeps a single-term match honest: "spreadsheet" names the spreadsheet
  // skill, while "settings" is one description word among many.
  const naming = new Map<string, boolean>();
  for (const term of terms) {
    if (!index.weight.has(term) || naming.has(term)) continue;
    let carried = 0, inName = 0;
    for (const doc of index.docs) {
      if (!doc.tokens.has(term)) continue;
      carried++;
      if (doc.name.has(term)) inName++;
      // Later description-only mentions can invalidate the majority.
      // Do not stop at an early prefix of the catalogue.
    }
    naming.set(term, inName > 0 && inName * 2 >= carried);
  }
  const out: Ranked[] = [];
  for (const doc of index.docs) {
    let score = 0, rare = 0, nameMatches = 0, namingMatches = 0;
    const matched: string[] = [];
    const matchedCanonical = new Set<string>();
    for (const term of terms) {
      const w = index.weight.get(term);
      if (w && doc.tokens.has(term)) {
        if (matchedCanonical.has(term)) continue;
        matchedCanonical.add(term);
        const inName = doc.name.has(term);
        score += w * (inName ? 2 : 1);
        if (inName) nameMatches++;
        if (inName && naming.get(term)) namingMatches++;
        if (index.strong.has(term)) rare++;
        if (matched.length < 6) matched.push(term);
        continue;
      }
      const close = fuzzyToken(index, doc, term);
      const closeWeight = close ? index.weight.get(close) : undefined;
      if (!close || !closeWeight || matchedCanonical.has(close)) continue;
      matchedCanonical.add(close);
      score += closeWeight * 0.55 * (doc.name.has(close) ? 2 : 1);
      if (index.strong.has(close)) rare++;
      if (matched.length < 6) matched.push(`${term}~${close}`);
    }
    // Two matched terms remain the ordinary signal. A single term that an
    // naming token of that skill is also decisive, because the skill name is
    // the most recent explicit statement of intent: "fix the crash when I
    // upload a large spreadsheet" scored 20 on the name-level term alone and
    // the two-term rule still discarded it. A fuzzy match never counts here,
    // and a description-level or shared term keeps the two-term requirement.
    const singleNameMatch = matched.length === 1 && rare >= 1 && nameMatches === 1 && namingMatches === 1;
    if ((matched.length >= 2 || singleNameMatch) && rare >= 1 && score >= 6) {
      out.push({ skill: doc.skill, score: Math.round(score * 100) / 100, matched });
    }
  }
  const relevance=process.env.PI_LOCAL_INTELLIGENCE==='off'?[]:candidateRelevance(out.map(item=>`${item.skill.name} ${item.skill.description}`),context);
  const ranked=new Map(out.map((item,i)=>[item.skill.name,relevance[i]??0]));
  // Statistical tie-break only after all rarity, fuzzy-match and availability gates.
  out.sort((a, b) => b.score - a.score || ranked.get(b.skill.name)!-ranked.get(a.skill.name)! || a.skill.name.localeCompare(b.skill.name));
  const selected = out.slice(0, Math.max(1, limit));
  if(selected.some(item=>item.matched.some(term=>term.includes("~"))))try{sessionObservability()[Symbol.for("yunus-pi.health.v1")]?.("ml.fuzzy.used",{count:selected.length});}catch{/* optional visibility */}
  return selected;
}
