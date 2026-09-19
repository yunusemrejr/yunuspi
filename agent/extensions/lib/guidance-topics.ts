/** Local advisory catalogue. Matching never executes code or reads file contents. */
import { systemsTopics } from './guidance-topics-systems.ts';
import { domainTopics } from './guidance-topics-domains.ts';
import { codeLexicalMask } from './code-lexical-mask.ts';

export type GuidanceTopic = {
  id: string; domain: string; terms: RegExp; file?: RegExp; context?: RegExp;
  check: string; examples: string[]; negative?: string[]; family?: string;
};
const sharedFamilies: Record<string, string> = {
  'systems-concurrency-abort': 'request-cancellation', 'browser-abort-fetch': 'request-cancellation',
  'systems-runtime-listener-cleanup': 'listener-lifetime', 'browser-event-listener': 'listener-lifetime',
};
export const guidanceTopics: readonly GuidanceTopic[] = [...systemsTopics, ...domainTopics]
  .map(topic => ({...topic, family: sharedFamilies[topic.id]}));
const action = /\b(?:build|make|design|create|implement|fix|change|edit|refactor|debug|investigate|deploy|migrate|update|repair|refine|polish|optimize|review|write|analy[sz]e|train|evaluate|calculate|audit|compare|test|verify|add|remove|improve|configure)\b/i;
const negated = /\b(?:do not|don't|never|no need to)\b|^\s*(?:without|avoid|skip|stop)\b/i;
const excluded = /(?:^|\/)(?:node_modules|vendor|dist|build|coverage|fixtures?|generated|backups|\.git)(?:\/|$)|(?:\.min\.[^/]+|\.map|\.lock)$/i;
const sourceFile = /\.(?:[cm]?[jt]sx?|css|scss|sass|less|vue|svelte|html?|svg|ino|ini|py|rs|go|java|kt|rb|php|c|cc|cpp|h|hpp|cs|sql|ya?ml|toml|tf|sh|bash|md|mdx|r|jl|json)$/i;

function maskDataCode(source: string, python: boolean): string {
  let result = '';
  for (let i=0; i<source.length;) {
    const start=i, c=source[i];
    if (python && c==='#' || !python && source.startsWith('--',i)) {
      while (i<source.length && source[i]!=='\n') i++;
    } else if (!python && source.startsWith('/*',i)) {
      const end=source.indexOf('*/',i+2); i=end<0 ? source.length : end+2;
    } else if (c==='"' || c==="'") {
      const quote=python && source.startsWith(c.repeat(3),i) ? c.repeat(3) : c;
      i+=quote.length;
      while(i<source.length) {
        if (python && source[i]==='\\') { i=Math.min(source.length,i+2); continue; }
        if (source.startsWith(quote,i)) { i+=quote.length; break; }
        i++;
      }
    } else { result+=c; i++; continue; }
    result+=source.slice(start,i).replace(/[^\n]/g,' ');
  }
  return result;
}

/** Keep comments/prose examples from being treated as authored implementation.
 * This is a conservative lexical filter, not a parser or defect detector. */
function editEvidence(text: string, file: string): string {
  if (/\.[cm]?[jt]sx?$/i.test(file)) return codeLexicalMask(text).code;
  if (/\.(?:py|sql)$/i.test(file)) return maskDataCode(text,/\.py$/i.test(file));
  if (/\.(?:md|mdx)$/i.test(file)) return text.replace(/```[^]*?(?:```|$)/g, ' ').replace(/^\s*>.*$/gm, ' ');
  const uncommented = text.replace(/\/\*[^]*?(?:\*\/|$)/g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1 ')
    .replace(/<!--[^]*?(?:-->|$)/g, ' ');
  return /\.(?:py|r|sh|bash|ya?ml|toml)$/i.test(file)
    ? uncommented.replace(/^\s*#.*$/gm, ' ') : uncommented;
}

export function matchGuidanceTopics(input: { prompt?: string; file?: string; text?: string }): GuidanceTopic[] {
  const editing = input.text !== undefined;
  const file = (input.file ?? '').replaceAll('\\', '/');
  if (editing && (!sourceFile.test(file) || excluded.test(file) || /(?:^|\/)SKILL\.md$/i.test(file) || file.length > 1024)) return [];
  const raw = editing ? input.text! : input.prompt ?? '';
  if (typeof raw !== 'string' || raw.length > 24000) return [];
  // Actions and topic terms must occur in the same request segment. Quoted
  // examples and explicitly excluded tasks are not new work instructions.
  const evidence = editing ? [editEvidence(raw, file)] : raw
    .replace(/```[^]*?(?:```|$)/g, ' ').replace(/^\s*>.*$/gm, ' ')
    .split(/\n|[.!?](?:\s|$)|;|\bbut\b/i)
    .filter(part => action.test(part) && !negated.test(part));
  return guidanceTopics.filter(topic => (!editing || !topic.file || topic.file.test(file)) &&
    evidence.some(text => topic.terms.test(text) && (!topic.context || topic.context.test(text) || editing && topic.context.test(file))))
    // Narrow contextual rules win over a bare keyword; catalogue order breaks ties.
    .sort((a,b) => Number(!!b.context) - Number(!!a.context));
}
