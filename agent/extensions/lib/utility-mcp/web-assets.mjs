import path from 'node:path';
import { Parser } from 'htmlparser2';
import { paginate, within } from './files.mjs';
import { referenceEvidence } from './local-reference.mjs';

const MAX_REFS = 2000, MAX_CHARS = 1024 * 1024;
const expression = value => /\$\{|\{\{|<%|\$\(/.test(value);
const lineAt = (text,index) => text.slice(0,index).split('\n').length;

/** Lexical URL/@import extraction, never a CSS evaluator or a style validator. */
export function cssReferences(text) {
  const refs=[];
  let i=0;
  const quoted = () => {
    const start=++i, quote=text[i-1];
    while(i<text.length && text[i]!==quote) { if(text[i]==='\\')i++;i++; }
    if(i>=text.length)throw Error('Unterminated CSS string');
    const value=text.slice(start,i);i++;return value;
  };
  while(i<text.length) {
    if(text.startsWith('/*',i)){const end=text.indexOf('*/',i+2);if(end<0)throw Error('Unterminated CSS comment');i=end+2;continue;}
    if(text[i]==='"'||text[i]==="'"){quoted();continue;}
    const start=i, match=/^(?:url\s*\(|@import\s+)/i.exec(text.slice(i,i+32));
    if(!match || i>0 && /[\w-]/.test(text[i-1])){i++;continue;}
    i+=match[0].length;
    while(/\s/.test(text[i]??'') && i<text.length)i++;
    if(match[0].startsWith('@')) {
      if(text[i]==='"'||text[i]==="'")refs.push({value:quoted(),offset:start,kind:'css-import'});
      // @import url(...) is processed by the next iteration.
      continue;
    }
    let value;
    if(text[i]==='"'||text[i]==="'")value=quoted();
    else {const from=i;while(i<text.length&&text[i]!==')'){if(text[i]==='\\')i++;i++;}value=text.slice(from,i).trim();}
    while(/\s/.test(text[i]??'')&&i<text.length)i++;
    if(text[i]!==')')throw Error('Unterminated or malformed CSS url');
    i++;
    refs.push({value,offset:start,kind:'css-url'});
    if(refs.length>MAX_REFS)throw Error('Asset reference limit exceeded');
  }
  return refs;
}

export function webAssetCheck(files,args) {
  const root=files.resolve(args.asset_root??'.',true), publicPath=args.public_path??'/';
  if(!/^\/(?:[^?#\\\x00-\x20]*\/)?$/.test(publicPath)||publicPath.startsWith('//')||publicPath.split('/').some(part=>part==='.'||part==='..')||publicPath.includes('%'))throw Error('public_path must be a literal URL path beginning and ending with /');
  if(args.files.length>30)throw Error('At most 30 explicit web source files');
  const rows=[],sources=[],findings=[];
  const collect=(file,text,refs,base)=>{
    for(const ref of refs){
      if(rows.length>=MAX_REFS)throw Error('Asset reference limit exceeded');
      const row={source:file,line:lineAt(text,ref.offset??0),kind:ref.kind};
      const value=ref.value?.trim();
      if(!value){rows.push({...row,status:'empty'});continue;}
      if(expression(value)||value.includes('\\')){rows.push({...row,status:'unresolved',reason:'Template or CSS-escaped reference'});continue;}
      if(value.startsWith('#')){rows.push({...row,status:'fragment'});continue;}
      if(/^(?:data|blob):/i.test(value)){rows.push({...row,status:'embedded-or-runtime'});continue;}
      if(/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)){rows.push({...row,status:'external',reason:'Not fetched'});continue;}
      let url;
      try{url=new URL(value,base);}catch{rows.push({...row,status:'invalid-url'});continue;}
      if(url.origin!=='https://assets.invalid'||!['https:','http:'].includes(url.protocol)){rows.push({...row,status:'external',reason:'Not fetched'});continue;}
      let pathname;
      try{pathname=decodeURIComponent(url.pathname);}catch{rows.push({...row,status:'invalid-url'});continue;}
      if(/[\x00-\x1f\x7f\\]/.test(pathname)){rows.push({...row,status:'invalid-path'});continue;}
      if(!pathname.startsWith(publicPath)){rows.push({...row,status:'outside-public-path'});continue;}
      const relative=pathname.slice(publicPath.length);
      const target=path.resolve(root,relative);
      if(!within(root,target)){rows.push({...row,status:'outside-root'});continue;}
      const result=referenceEvidence(files,root,relative);
      rows.push({...row,reference:pathname,...result});
    }
  };
  for(const file of args.files){
    const absolute=files.resolve(file);
    if(!within(root,absolute))throw Error('Web source is outside asset_root');
    const text=files.read(file);
    if(Buffer.byteLength(text)>MAX_CHARS)throw Error('Web source exceeds 1 MiB text limit');
    const lexical=path.resolve(files.root,file);
    if(!within(root,lexical))throw Error('Web source path is outside asset_root');
    const sourceUrl=new URL(publicPath+path.relative(root,lexical).split(path.sep).map(encodeURIComponent).join('/'),'https://assets.invalid');
    const extension=path.extname(file).toLowerCase();
    const refs=[];let base=sourceUrl;
    if(extension==='.html'||extension==='.htm'){
      let style=false,styleStart=0,styleText='',baseSeen=false;
      const parser=new Parser({
        onopentag(name,attributes){
          const offset=parser.startIndex;
          if(name==='base'&&Object.hasOwn(attributes,'href')&&!baseSeen){
            baseSeen=true;
            if(expression(attributes.href)||attributes.href.includes('\\')){base=null;findings.push({source:file,line:lineAt(text,offset),code:'unresolved-base'});}
            else try{base=/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(attributes.href.trim())?new URL('https://external.invalid/'):new URL(attributes.href,sourceUrl);}catch{base=null;findings.push({source:file,line:lineAt(text,offset),code:'invalid-base'});}
          }
          const attrs={script:['src'],img:['src'],source:['src'],video:['src','poster'],audio:['src'],track:['src'],iframe:['src'],embed:['src'],object:['data'],input:['src'],image:['href','xlink:href']};
          const selected=attrs[name]??[];
          if(name==='link'&&/\b(?:stylesheet|icon|manifest|preload|modulepreload|apple-touch-icon)\b/i.test(attributes.rel??''))selected.push('href');
          for(const attr of selected)if(Object.hasOwn(attributes,attr))refs.push({value:attributes[attr],offset,kind:`html-${name}-${attr}`});
          if(['img','source'].includes(name)&&attributes.srcset){
            // Data URLs contain commas and arbitrary templates need runtime parsing.
            // Refuse the complete srcset rather than inventing partial candidates.
            if(/data:|["']/.test(attributes.srcset)||expression(attributes.srcset))refs.push({value:'${unresolved-srcset}',offset,kind:'html-srcset'});
            else for(const entry of attributes.srcset.split(','))refs.push({value:entry.trim().split(/\s+/)[0],offset,kind:'html-srcset'});
          }
          if(attributes.style)for(const ref of cssReferences(attributes.style))refs.push({...ref,offset,kind:'inline-'+ref.kind});
          if(name==='style'){style=true;styleStart=parser.endIndex+1;styleText='';}
          if(refs.length>MAX_REFS)throw Error('Asset reference limit exceeded');
        },
        ontext(value){if(style)styleText+=value;},
        onclosetag(name){if(name==='style'&&style){for(const ref of cssReferences(styleText))refs.push({...ref,offset:styleStart+ref.offset});style=false;}},
      },{decodeEntities:true});
      parser.write(text);parser.end();
    }else if(extension==='.css')refs.push(...cssReferences(text));
    else if(extension==='.json'||extension==='.webmanifest'){
      let manifest;
      try{manifest=JSON.parse(text);}catch{throw Error('Invalid web manifest JSON (source values omitted)');}
      if(!manifest||typeof manifest!=='object'||Array.isArray(manifest))throw Error('Web manifest must be an object');
      for(const key of ['icons','screenshots']){
        if(manifest[key]!==undefined&&!Array.isArray(manifest[key]))findings.push({source:file,line:1,code:`invalid-${key}`});
        for(const item of Array.isArray(manifest[key])?manifest[key]:[])if(typeof item?.src==='string')refs.push({value:item.src,offset:0,kind:`manifest-${key}`});
      }
      if(Array.isArray(manifest.shortcuts))for(const shortcut of manifest.shortcuts)for(const icon of Array.isArray(shortcut?.icons)?shortcut.icons:[])if(typeof icon?.src==='string')refs.push({value:icon.src,offset:0,kind:'manifest-shortcut-icon'});
    }else throw Error('Supported explicit sources: HTML, CSS and web manifest JSON');
    if(rows.length+refs.length>MAX_REFS)throw Error('Asset reference limit exceeded');
    if(base===null){for(const ref of refs)rows.push({source:file,line:lineAt(text,ref.offset??0),kind:ref.kind,status:'unresolved',reason:'Document base is unresolved'});}
    else collect(file,text,refs,base);
    sources.push({path:file,references:refs.length});
  }
  return {sources,asset_root:args.asset_root??'.',public_path:publicPath,...paginate(rows,args),counts:Object.fromEntries([...new Set(rows.map(row=>row.status))].sort().map(status=>[status,rows.filter(row=>row.status===status).length])),findings,scope:'Static references in explicit HTML/CSS/web manifests only; referenced files are checked, never parsed recursively. No network, scripts, build aliases, routes, CSS cascade or browser rendering. External, embedded and dynamic URLs are not validated. Manifest positions identify the document; HTML positions identify the containing tag. Query/fragment values are omitted.'};
}
