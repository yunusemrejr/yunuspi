/** Conservative JS/TS cue preprocessing, not a parser. Template bodies are
 * withheld (including interpolations) rather than guessing their syntax. */
export function codeLexicalMask(source: string) {
  let code = '', directives = false;
  for (let i=0;i<source.length;) {
    const c=source[i], next=source[i+1];
    if(c==='/' && (next==='/' || next==='*')) {
      const start=i, line=next==='/'; i+=2;
      while(i<source.length && (line ? source[i]!=='\n' : !(source[i]==='*' && source[i+1]==='/'))) i++;
      if(!line && i<source.length)i+=2;
      const comment=source.slice(start,i);
      if(/@ts-(?:ignore|nocheck)\b/.test(comment))directives=true;
      code+=comment.replace(/[^\n]/g,' ');continue;
    }
    if(c==='"' || c==="'" || c==='`') {
      const quote=c,start=i++;
      while(i<source.length) {if(source[i]==='\\'){i=Math.min(source.length,i+2);continue;}if(source[i++]===quote)break;}
      code+=source.slice(start,i).replace(/[^\n]/g,' ');continue;
    }
    code+=c;i++;
  }
  return {code,directives};
}
