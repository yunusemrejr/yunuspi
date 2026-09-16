/** Extractive intent support for existing automatic briefs. No I/O, inference,
 * authority decisions, new context messages or persistent conversation cache. */
import { safeText } from './project-intelligence/privacy.mjs';

const WINDOW = 256;
const MAX_SCAN_CHARS = 32768;
const pivot = /\b(?:new (?:task|topic|request)|unrelated (?:task|topic|question|request)|start over|switch to|forget (?:that|this|the previous))\b/i;
const refusal = /\b(?:do not|don't|never|stop)\s+(?:continue|resume|do|handle|apply|implement|finish|start|work on|carry out|execute)\b/i;
/** A compound instruction can name its subject only by reference ("do this and
 * that", "handle the rest"). The demonstrative must stand alone: "this SQL
 * query" modifies a noun and is not by itself evidence of an earlier subject,
 * so an immediately following content noun keeps this cue off. */
const demonstrative = /\b(?:do|handle|apply|implement|finish|carry out|execute|take care of|work on|go ahead with|start on)\s+(?:all of\s+)?(?:this|that|these|those|both|it|them|the rest|the others|the remaining (?:ones|items|tasks|pieces))(?=\s*(?:$|[,.!?;:]|\b(?:and|then|too|also|as well|first|next|instead|please|now|for me|in|on|to|with|using|via|without|but|while|when|where|before|after|if|unless)\b))/i;
const pluralDemonstrative = /\b(?:both|either|all)\s+of\s+(?:these|those|them)\b/i;
const sameAsBefore = /\b(?:do|apply|repeat|use)\s+the\s+same(?:\s+(?:for|with|to|as)\b|\s*[.!?]|$)|\bsame\s+(?:for|with)\s+(?:the\s+)?(?:other(?:s)?|rest|them|these|those)\b/i;
const terms = (text: string) => [...new Set((text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu) ?? [])
  .filter(t => !/^(the|and|for|this|that|with|please|make|more|less|improve|keep|from|have|want|need)$/.test(t)))].slice(0,48);
const intentText = (text: string) => text.replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/^\s*>.*$/gm, ' ');

/** Explicit course-change / stop cues. Exported for the interpretation layer;
 * still evidence only — the main agent owns the decision. */
export function isPromptPivot(prompt: string): boolean {
  return pivot.test(intentText(prompt.slice(0, 1024)));
}

export function isPromptRefusal(prompt: string): boolean {
  return refusal.test(intentText(prompt.slice(0, 1024)));
}

/** Only a retrieval cue, never a claim that a task or authorization continues. */
export function isReferentialFollowup(prompt: string): boolean {
  const text = intentText(prompt.slice(0,1024)).trim();
  if (text.length > 240 || pivot.test(text) || refusal.test(text)) return false;
  if (/\b(?:continue|resume|same task|keep going|next step)\b|\bmake\s+(?:it|this|that|them)\b|\b(?:improve|refine|polish|fix|animate|rework)\s+(?:it|this|that|them)(?:\s+(?:more|less|too|again)\b|[.!?]|$)/i.test(text)) return true;
  // Compound instructions inherit their subject the same way a bare "make it
  // better" does; the caller still treats the inherited text as evidence only.
  return demonstrative.test(text) || pluralDemonstrative.test(text) || sameAsBefore.test(text);
}

type UserEvidence = { source: string; text: string };
/** Read the active branch only. Missing/oversized evidence remains unknown;
 * never clip a historical constraint into a different instruction. */
export function priorUserEvidence(prompt: string, entries: unknown) {
  const evidence: UserEvidence[] = [];
  if (!Array.isArray(entries)) return { evidence, incomplete: true };
  let scanned = 0, incomplete = entries.length > WINDOW;
  const seen = new Set([prompt.trim()]);
  const start = Math.max(0,entries.length-WINDOW);
  for (let i=entries.length-1; i>=start; i--) {
    const entry = entries[i], message = entry?.type === 'message' ? entry.message : undefined;
    if (message?.role !== 'user') continue;
    const content = message.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content) && content.length <= 32) {
      const blocks = content.filter(b => b?.type === 'text' && typeof b.text === 'string');
      if (blocks.some(b => b.text.length > 4096)) { incomplete=true; break; }
      text = blocks.map(b => b.text).join('\n');
    } else { incomplete=true; break; }
    scanned += text.length;
    if (scanned > MAX_SCAN_CHARS) { incomplete=true; break; }
    if (text.length > 4096) { incomplete=true; break; }
    text = text.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const clean = safeText(text,4097);
    if (clean.includes('[redacted]')) { incomplete=true; break; }
    const id = typeof entry.id === 'string' && /^[\w-]{1,64}$/.test(entry.id) ? entry.id : String(i);
    evidence.push({source:`branch-entry:${id}`,text:clean});
    if (pivot.test(intentText(text))) break;
    if (evidence.length === 8) { incomplete ||= i>start; break; }
  }
  return { evidence:evidence.reverse(), incomplete };
}

/** Current wording stays first. Inheritance is search vocabulary only, within
 * the existing query allowance; never add instructions to the user's prompt. */
export function intentRetrievalQuery(prompt: string, entries: unknown, maxChars=900): string {
  const current = safeText(prompt, maxChars);
  if (!isReferentialFollowup(prompt) || current.length >= maxChars) return current;
  const { evidence } = priorUserEvidence(prompt, entries);
  const inherited = evidence.slice(-2).flatMap(e => terms(intentText(e.text)));
  return `${current} ${[...new Set(inherited)].join(' ')}`.trim().slice(0,maxChars);
}

/** Space reclaimed from the old helper boilerplate, not a larger envelope.
 * Current request is supplied separately and is never displaced by history. */
export function helperIntentEvidence(prompt: string, entries: unknown, maxBytes=280): string {
  if (pivot.test(intentText(prompt))) return '';
  const { evidence, incomplete } = priorUserEvidence(prompt, entries);
  const query = new Set(terms(intentText(prompt)));
  const first = evidence.findIndex(e => isReferentialFollowup(prompt) || terms(intentText(e.text)).some(t=>query.has(t)));
  // Keep subsequent corrections even when they introduce different vocabulary.
  const relevant = first < 0 ? [] : evidence.slice(first);
  if (!relevant.length) return incomplete ? '\nPrior user evidence incomplete; parent retains full context.' : '';
  const header = '\nHistorical user evidence (oldest first):\n';
  const footer = '\n[Other history omitted; unknown.]';
  const selected: string[] = [];
  // Newest applicable corrections get space first. Preserve whole excerpts.
  for (const item of relevant.slice().reverse()) {
    const line = `[${item.source}] ${item.text}`;
    // Backfilling an older preference across an omitted newer correction can
    // reverse intent. Only a contiguous newest suffix is safe to present.
    if (Buffer.byteLength(JSON.stringify(header+[line,...selected].join('\n')+footer))-2 > maxBytes) break;
    selected.unshift(line);
    if (selected.length === 3) break;
  }
  return selected.length ? header+selected.join('\n')+footer : '\nPrior user evidence exceeds brief space; parent retains full context.';
}
