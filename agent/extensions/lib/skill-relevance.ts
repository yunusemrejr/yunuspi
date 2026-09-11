/** Catalog-wide advisory skill relevance. Pure and deterministic: no I/O,
 * inference, timers or scanning of tool-output prose. It scores the loaded
 * available-skills catalogue's own name/description tokens against bounded
 * session context terms; skill bodies are never read or injected. The reminder
 * owner still applies catalogue availability, delivery and lifecycle limits. */
export type SkillInfo = { name: string; file: string; description: string };
export type SkillIndex = {
  docs: { skill: SkillInfo; tokens: Set<string>; name: Set<string> }[];
  weight: Map<string, number>;
  strong: Set<string>;
};
export type Ranked = { skill: SkillInfo; score: number; matched: string[] };

const MIN_TERM = 4, MAX_TERM = 31, MAX_TERMS = 400;
// Common prose that would otherwise let a generic description match any task.
const STOP = new Set(("with this that from work task tasks when into your using used user users code files file skill skills workflow checks check verify ensure keep kept only before after other more most less than then them they must does each example examples actual current project projects relevant preserve existing avoid without within between during possible apply applies report reports about which where while there their these those have has been being will would should could would state states visible local needed needs need make makes made take takes gives given each other same different only also just like such very well over under more most much many some any all not use used uses using do don't doesn't did doing done also into onto off out up down here when whenever whether either neither because since until unless though although even still yet already always never often sometimes usually rarely truly simply really quite rather about above below across along among around behind beyond despite except inside outside through toward towards upon versus via per plus minus okay fine good better best great hard easy simple simply own hands hand thing things part parts area areas case cases time times day days week weeks month months year years first second third last next new old start starts started begin begins began end ends ended stop stops stopped run runs ran running step steps phase phases stage stages level levels type types kind kinds form forms mode modes way ways point points item items unit units value values number numbers set sets list lists page pages line lines word words text texts name names path paths file files data info information note notes result results output outputs input inputs cause causes effect effects issue issues problem problems error errors change changes changed update updates updated add adds added remove removes removed fix fixes fixed build builds built make makes create creates created write writes wrote read reads review review inspected inspect look looks look at see sees seen show shows shown tell tells told ask asks asked need needs needed want wants wanted give gives given get gets got take takes took put puts plus also item number part thing side top bottom front back left right open closes close closed full empty high low long short big small fast slow early late hard soft sure certain likely probably maybe perhaps almost nearly roughly approx also etc eg ie vs ok").split(/\s+/).filter(Boolean));
/** Lowercased discriminating terms from text. Bounded, deduplicated, no stemming. */
export function skillTerms(text: string, limit = MAX_TERMS): string[] {
  const out = new Set<string>();
  for (const match of String(text ?? "").toLowerCase().matchAll(/[a-z][a-z0-9+#._-]{3,50}/g)) {
    const term = match[0].replace(/[._]+$/, "");
    if (term.length < MIN_TERM || term.length > MAX_TERM || STOP.has(term)) continue;
    out.add(term);
    if (out.size >= limit) break;
  }
  return [...out];
}
export function buildSkillIndex(skills: readonly SkillInfo[]): SkillIndex {
  const docs = skills.slice(0, 256).map(skill => {
    const name = new Set(skillTerms(skill.name, 16));
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
/** Rank catalogue skills against bounded context. Requires at least two
 * matched discriminating terms and one strongly rare term; weak or generic
 * overlap yields nothing rather than a speculative recommendation. */
export function rankSkills(index: SkillIndex, context: string, limit = 4): Ranked[] {
  const terms = skillTerms(context, 64);
  if (!terms.length) return [];
  const out: Ranked[] = [];
  for (const doc of index.docs) {
    let score = 0, rare = 0;
    const matched: string[] = [];
    for (const term of terms) {
      const w = index.weight.get(term);
      if (!w || !doc.tokens.has(term)) continue;
      score += w * (doc.name.has(term) ? 2 : 1);
      if (index.strong.has(term)) rare++;
      if (matched.length < 6) matched.push(term);
    }
    if (matched.length >= 2 && rare >= 1 && score >= 6) out.push({ skill: doc.skill, score: Math.round(score * 100) / 100, matched });
  }
  out.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  return out.slice(0, Math.max(1, limit));
}
