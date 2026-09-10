import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export const changes = [
  [
    "function searchWordIndex(index, query, options = {}) {",
    "// PI_LENS_FUZZY_IDENTIFIERS_V1\nfunction searchWordIndex(index, query, options = {}) {"
  ],
  [
    "  for (const token of queryTokens) {\n    const posting = index.postings.get(token);",
    "  for (const {token, weight, original} of (options.expandTerms ?? (tokens => tokens.map(token => ({token,weight:1}))))(queryTokens, index.postings)) {\n    const posting = index.postings.get(token);"
  ],
  [
    "      entry.score += termScore;",
    "      entry.score += termScore * weight;\n      if (original) (entry.approximate ??= new Set()).add(`${original} \u2192 ${token}`);"
  ],
  [
    "      lines: [...entry.lines].sort((a, b) => a - b)",
    "      approximate: [...(entry.approximate ?? [])],\n      lines: [...entry.lines].sort((a, b) => a - b)"
  ],
  [
    "    startLine: line,\n    endLine: line\n  };\n}\nasync function symbolSearch",
    "    startLine: line,\n    endLine: line,\n    approximate: result.approximate\n  };\n}\nasync function symbolSearch"
  ],
  [
    "            endLine: hit.endLine,\n            ...hit.annotations",
    "            endLine: hit.endLine,\n            ...(hit.approximate?.length ? {approximate:hit.approximate, matchNotice:\"Approximate identifier match; inspect before acting.\"} : {}),\n            ...hit.annotations"
  ],
  [
    "    results = searchWordIndex(index, query, { limit, centrality, fileFilter });",
    "    const { identifierTerms } = await import(\"../semantic-radar/fuzzy-identifiers.mjs\");\n    results = searchWordIndex(index, query, { limit, centrality, fileFilter, expandTerms: identifierTerms });"
  ]
];
const header = '';
export function applySource(source) {
 if(source.includes('// PI_LENS_FUZZY_IDENTIFIERS_V1')) {
   if(!source.startsWith(header) || !changes.every(([,after])=>source.includes(after))) throw new Error('Partial fuzzy patch');
   return source;
 }
 let next=source;
 for(const [before,after] of changes) {
   if(next.split(before).length!==2) throw new Error('Fuzzy patch anchor drift: '+before.slice(0,80));
   next=next.replace(before,after);
 }
 return header+next;
}
export function targets() {
 const file=fileURLToPath(new URL('../../extensions/pi-lens/dist/index.js',import.meta.url));
 return [{name:'pi-lens bounded fuzzy identifiers',exists:()=>fs.existsSync(file),
   isApplied:()=>{const source=fs.readFileSync(file,'utf8');return changes.every(([,after])=>source.includes(after));},
   apply(){const source=fs.readFileSync(file,'utf8'),next=applySource(source);if(next===source)return;
     execFileSync(process.execPath,['--input-type=module','--check'],{input:next});fs.writeFileSync(file,next);}
 }];
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
 const target=fileURLToPath(new URL('../../extensions/pi-lens/dist/index.js',import.meta.url));
 const source=fs.readFileSync(target,'utf8'),next=applySource(source);
 if(next!==source)fs.writeFileSync(target,next);
 console.log('pi-lens fuzzy identifiers: applied/verified');
}
