/** Typo candidates from the EXISTING vocabulary; no scan, cache, model or I/O.
 * One insertion/deletion/substitution/transposition, bounded by token length.
 * Ambiguous neighborhoods abstain. Suggestions never authorize source edits. */
export function identifierTerms(tokens, postings) {
  const out = new Map();
  for (const token of tokens.slice(0, 32)) {
    if (postings.has(token)) out.set(token, {token, weight:1});
  }
  if (process.env.PI_LENS_FUZZY === 'off') return [...out.values()];
  for (const original of tokens.slice(0, 6)) {
    if (postings.has(original) || !/^[a-z][a-z0-9_]{4,31}$/.test(original)) continue;
    const found = new Set();
    const offer = value => { if (postings.has(value)) found.add(value); };
    for (let i=0;i<original.length;i++) {
      offer(original.slice(0,i)+original.slice(i+1));
      if(i+1<original.length) offer(original.slice(0,i)+original[i+1]+original[i]+original.slice(i+2));
      for(const c of 'abcdefghijklmnopqrstuvwxyz0123456789_') {
        offer(original.slice(0,i)+c+original.slice(i+1));
      }
    }
    for(let i=0;i<=original.length;i++) for(const c of 'abcdefghijklmnopqrstuvwxyz0123456789_') offer(original.slice(0,i)+c+original.slice(i));
    if(found.size>2) continue;
    for(const token of [...found].sort()) if(!out.has(token)) out.set(token,{token,weight:0.45,original});
  }
  return [...out.values()];
}
