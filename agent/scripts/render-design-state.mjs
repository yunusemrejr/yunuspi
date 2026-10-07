/** Runs inside the existing isolated renderer. Numeric evidence, never a style score.
 * Contrast formula/thresholds: WCAG 2.2 SC 1.4.3 (solid opaque sRGB only).
 * https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html */
export function inspectDesignState(root) {
  const started=performance.now(),limit=600,timeLimit=120;
  const result={version:2,visited:0,visible:0,truncated:false,viewport:{width:innerWidth,height:innerHeight},
    horizontalOverflowPx:Math.max(0,document.documentElement.scrollWidth-document.documentElement.clientWidth),
    typography:[],textElements:0,spacing:[],surfacePatterns:{gradients:0,shadows:0,rounded:0},
    slopSignals:{pills:0,glowShadows:0,gradientText:0,glass:0,textGlow:0,oversizedType:0,heavyRadius:0},
    contrast:{checked:0,belowThreshold:0,indeterminate:0},findings:[],
    svg:{sampled:0,missingViewBox:0,unresolvedRefs:0,duplicateIds:0,clippingCandidates:0,findings:[],limitations:'Inline main-document SVG sample. Fill bounds exclude stroke/filter paint; clipping candidates need pixel judgment. Hidden defs may legitimately have no viewBox. Not an optical-quality verdict.'},
    motion:{reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,running:0,infinite:0,sampled:0,truncated:false},
    limitations:'Bounded main-document computed-style sample, not an aesthetic score or accessibility certification. No text, input values or CSS URLs returned. Contrast excludes images, opacity, filters, blending, shadows, pseudo-elements and unknown backgrounds; occlusion, focus, states, canvas, frames and shadow roots need separate inspection. Repeated surfaces may be intentional. Slop-signature counts are treatment frequencies with disclosed thresholds, not verdicts. Use screenshots and the relevant design skill to judge hierarchy, originality and composition.'};
  if(!root)return result;
  const fonts=new Map(),spaces=new Map(),slopExample={},svgIds=new Set();
  const slop=(kind,node)=>{result.slopSignals[kind]++;if(!slopExample[kind])slopExample[kind]=node;};
  const count=(map,key)=>{if(map.has(key))map.set(key,map.get(key)+1);else if(map.size<64)map.set(key,1);else result.truncated=true;};
  const round=n=>Math.round(n*100)/100;
  const identify=node=>{const parts=[];for(let at=node;at&&parts.length<4;at=at.parentElement){let index=1,steps=0;for(let sib=at.previousElementSibling;sib;sib=sib.previousElementSibling){if(++steps>256)return null;if(sib.localName===at.localName)index++;}parts.unshift(`${at.localName}:nth-of-type(${index})`);}return parts.join(' > ').slice(0,220);};
  const finding=(kind,node,facts)=>{if(result.findings.length<12)result.findings.push({kind,selector:identify(node),...facts});else result.truncated=true;};
  const rgb=raw=>{const match=/^rgba?\(([^)]+)\)$/.exec(raw);if(!match)return null;const n=match[1].split(/[, /]+/).filter(Boolean).map(Number);if(n.length<3||n.some(x=>!Number.isFinite(x))||(n.length>3&&n[3]!==1))return null;return n.slice(0,3).map(x=>x/255);};
  const luminance=c=>c.map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
  // Empty generated content can still paint a full-size overlay/background.
  const hasPseudo=node=>['::before','::after'].some(p=>!['none','normal'].includes(getComputedStyle(node,p).content));
  const background=node=>{let color=null,depth=0;for(let at=node;at;at=at.parentElement){if(++depth>32)return null;const s=getComputedStyle(at);
    if(hasPseudo(at))return null;
    if(Number(s.opacity)!==1||s.filter!=='none'||s.backdropFilter!=='none'||s.mixBlendMode!=='normal'||s.boxShadow!=='none'||(s.maskImage||'none')!=='none')return null;
    if(!color){if(s.backgroundImage!=='none')return null;const c=rgb(s.backgroundColor);if(c)color=c;else if(!/^rgba\([^)]*,\s*0\)$/.test(s.backgroundColor))return null;}
  }return color;};
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_ELEMENT);let node=walker.currentNode;
  while(node){
    if(result.visited>=limit||performance.now()-started>=timeLimit){result.truncated=true;break;}result.visited++;
    const style=getComputedStyle(node),rect=node.getBoundingClientRect();
    if(rect.width>0&&rect.height>0&&style.visibility==='visible'&&!node.closest('[hidden],[inert]')&&(!node.closest('[aria-hidden="true"]')||node.namespaceURI==='http://www.w3.org/2000/svg')){
      result.visible++;
      if(node.localName==='svg'&&!node.parentElement?.closest('svg')&&result.svg.sampled<24){
        const svg=result.svg;svg.sampled++;
        const note=(kind,facts={})=>{if(svg.findings.length<8)svg.findings.push({kind,selector:identify(node),...facts});};
        const view=node.viewBox?.baseVal;
        if(!view||view.width<=0||view.height<=0){svg.missingViewBox++;note('missing-viewbox');}
        let scanned=0;const parts=document.createTreeWalker(node,NodeFilter.SHOW_ELEMENT);let child=parts.currentNode;
        while(child){
          if(++scanned>128||performance.now()-started>=timeLimit){result.truncated=true;break;}
          if(child.id){if(svgIds.has(child.id)){svg.duplicateIds++;note('duplicate-id');}svgIds.add(child.id);}
          for(const attr of ['href','xlink:href','clip-path','mask','fill','stroke','filter']){
            const raw=child.getAttribute(attr)||'',ref=(attr==='href'||attr==='xlink:href')&&raw.startsWith('#')?raw.slice(1):/url\(\s*["']?#([^\s)'";]+)["']?\s*\)/.exec(raw)?.[1];
            if(ref&&!document.getElementById(ref)){svg.unresolvedRefs++;note('unresolved-reference');}
          }
          child=parts.nextNode();
        }
        if(view?.width>0&&view?.height>0&&style.overflow==='hidden'){
          try{const b=node.getBBox();if(b.width>0&&b.height>0&&(b.x<view.x-.5||b.y<view.y-.5||b.x+b.width>view.x+view.width+.5||b.y+b.height>view.y+view.height+.5)){svg.clippingCandidates++;note('fill-outside-viewbox',{bounds:{x:round(b.x),y:round(b.y),width:round(b.width),height:round(b.height)}});}}catch{/* unsupported geometry remains a pixel question */}
        }
      }
      let hasDirectText=false,directChildren=0;for(let child=node.firstChild;child&&directChildren++<64;child=child.nextSibling)if(child.nodeType===Node.TEXT_NODE&&child.textContent.trim()){hasDirectText=true;break;}
      const font={family:style.fontFamily.slice(0,120),sizePx:parseFloat(style.fontSize),weight:style.fontWeight,lineHeight:style.lineHeight};
      // Decorative geometry and inherited styles on empty layout wrappers
      // cannot establish a type level or outweigh the actual reading text.
      if(hasDirectText&&!node.matches('script,style,template')){count(fonts,JSON.stringify(font));result.textElements++;}
      for(const value of [style.gap,style.paddingTop,style.paddingRight,style.paddingBottom,style.paddingLeft,style.marginTop,style.marginBottom]){const n=parseFloat(value);if(Number.isFinite(n)&&n>0&&n<=512)count(spaces,String(round(n)));}
      if(/gradient\(/.test(style.backgroundImage))result.surfacePatterns.gradients++;
      if(style.boxShadow!=='none')result.surfacePatterns.shadows++;
      if(parseFloat(style.borderTopLeftRadius)>0)result.surfacePatterns.rounded++;
      // Rendered AI-slop signatures: computed-style frequencies, never verdicts.
      // A pill is a small control with fully rounded ends (radius reaches half
      // the short side); large rounded panels are not pills.
      const shortSide=Math.min(rect.width,rect.height);
      const isPill=shortSide>=8&&shortSide<=96&&rect.width>rect.height&&parseFloat(style.borderTopLeftRadius)>=shortSide/2-1;
      if(isPill)slop('pills',node);
      // A glow halo is a soft wide shadow with a near-zero offset (not a drop
      // shadow and not an inset fill). Computed serialization puts color first.
      if(style.boxShadow!=='none'&&!/inset/.test(style.boxShadow)){
        for(const shadow of style.boxShadow.matchAll(/(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px/g)){
          if(Number(shadow[3])>=16&&Math.abs(Number(shadow[1]))<=8&&Math.abs(Number(shadow[2]))<=8){slop('glowShadows',node);break;}
        }
      }
      if((style.backgroundClip==='text'||style.webkitBackgroundClip==='text')&&/gradient\(/.test(style.backgroundImage))slop('gradientText',node);
      if(style.backdropFilter&&style.backdropFilter!=='none'&&/blur\s*\(/.test(style.backdropFilter))slop('glass',node);
      if(style.textShadow&&style.textShadow!=='none')slop('textGlow',node);
      // Oversized display type needs visible words on the element itself, so a
      // sized wrapper and its headline do not count twice. Heavy radius skips
      // pills, which already have their own signature.
      if(hasDirectText&&font.sizePx>=80)slop('oversizedType',node);
      if(!isPill&&parseFloat(style.borderTopLeftRadius)>=24)slop('heavyRadius',node);
      if(rect.width>innerWidth+1&&style.position!=='fixed')finding('wider-than-viewport',node,{widthPx:round(rect.width)});
      if(hasDirectText&&!node.matches('script,style,template,input,textarea,select,:disabled,[aria-disabled="true"]')){
        const color=rgb(style.color),bg=background(node);
        const pseudo=hasPseudo(node),alternateFill=style.webkitTextFillColor&&style.webkitTextFillColor!==style.color;
        if(!color||!bg||style.textShadow!=='none'||pseudo||alternateFill||parseFloat(style.webkitTextStrokeWidth)>0||node.namespaceURI!=='http://www.w3.org/1999/xhtml'){result.contrast.indeterminate++;}
        else{
          const a=luminance(color),b=luminance(bg),ratio=(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
          const large=font.sizePx>=24||(font.sizePx>=56/3&&Number(font.weight)>=700),threshold=large?3:4.5;
          result.contrast.checked++;
          if(ratio<threshold){result.contrast.belowThreshold++;finding('solid-text-contrast',node,{ratio:round(ratio),threshold,sizePx:font.sizePx,weight:font.weight,foreground:style.color});}
        }
      }
    }
    node=walker.nextNode();
  }
  // One locating finding per over-threshold signature; counts stay in
  // slopSignals for the reviewer to judge against the design system.
  for(const [kind,threshold] of [['pills',4],['glowShadows',3],['gradientText',1],['glass',3],['textGlow',4],['oversizedType',2],['heavyRadius',6]]){
    if(result.slopSignals[kind]>=threshold&&slopExample[kind])finding('slop-'+kind.replace(/[A-Z]/g,c=>'-'+c.toLowerCase()),slopExample[kind],{count:result.slopSignals[kind],threshold});
  }
  result.typography=[...fonts].sort((a,b)=>b[1]-a[1]).slice(0,10).map(([key,count])=>({...JSON.parse(key),count}));
  if(fonts.size>10||spaces.size>16)result.truncated=true;
  result.spacing=[...spaces].sort((a,b)=>b[1]-a[1]).slice(0,16).map(([pixels,count])=>({pixels:Number(pixels),count}));
  const animations=document.getAnimations();result.motion.truncated=animations.length>100;
  for(const animation of animations.slice(0,100)){result.motion.sampled++;if(animation.playState==='running')result.motion.running++;if(animation.effect?.getTiming().iterations===Infinity)result.motion.infinite++;}
  result.limits={elements:limit,scanMs:timeLimit,findings:12,animations:100};
  return result;
}

/** Only caller-selected style tokens and shared roles are inspected. No copy,
 * input values, URLs, arbitrary attributes or page scripts are returned. */
export function normalizeUiSnapshotOptions(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('uiSnapshot must be an object');
  if (raw.groups !== undefined && (!Array.isArray(raw.groups) || raw.groups.length > 12)) throw Error('selectorGroups supports at most 12 groups');
  const groups = (raw.groups ?? []).map(group => {
    if (!group || typeof group !== 'object' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(group.name ?? '') || typeof group.selector !== 'string' || !group.selector.trim() || group.selector.length > 256)
      throw Error('Each selector group needs a name and selector (1..256 characters)');
    if (group.variant !== undefined && !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(group.variant)) throw Error('variant must be a short identifier');
    return { name: group.name, selector: group.selector, ...(group.variant ? { variant: group.variant } : {}) };
  });
  const keys = groups.map(group => `${group.name}:${group.variant ?? ''}`);
  if (new Set(keys).size !== keys.length) throw Error('Selector group name/variant pairs must be unique');
  if (raw.tokens !== undefined && (!Array.isArray(raw.tokens) || raw.tokens.length > 24 || raw.tokens.some(token => typeof token !== 'string' || !/^--[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(token))))
    throw Error('tokens supports at most 24 CSS custom property names');
  return { groups, tokens: raw.tokens === undefined ? undefined : [...new Set(raw.tokens)] };
}

export function inspectUiSnapshot(root, options) {
  const properties = ['color','backgroundColor','fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','borderRadius','borderWidth','padding','gap'];
  const result = { tokens: [], roles: [], missing: [], truncated: false, scanned: 0,
    device: { devicePixelRatio, maxTouchPoints: navigator.maxTouchPoints, pointerCoarse: matchMedia('(pointer: coarse)').matches, hover: matchMedia('(hover: hover)').matches, orientation: innerWidth > innerHeight ? 'landscape' : 'portrait' },
    limitations: 'Computed tokens and shared role styles only. Variants are declared with selectorGroups.variant or data-ui-variant. Differences may be intentional; no aesthetic or interaction approval. Hidden, shadow-root, iframe, pseudo-element and unsampled components remain uncovered.' };
  if (!root) return result;
  const style = getComputedStyle(root);
  const tokenNames = options.tokens ?? Array.from(style).filter(name => /^--[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name) && /color|font|text|space|gap|radius|border|shadow|surface|background|duration|motion|ease|size|line/i.test(name)).sort().slice(0,24);
  for (const name of tokenNames) {
    const value = style.getPropertyValue(name).trim();
    result.tokens.push({ name, status: !value ? 'missing' : value.length > 200 || /url\s*\(|(?:https?|data):/i.test(value) ? 'omitted' : 'measured', ...(value && value.length <= 200 && !/url\s*\(|(?:https?|data):/i.test(value) ? { value } : {}) });
  }
  const groups = options.groups.length ? options.groups : [{name:'body',selector:'body'},{name:'heading-1',selector:'h1'},{name:'navigation',selector:'nav,[role="navigation"]'},{name:'component',selector:'[data-ui-role]',named:true}];
  const started = performance.now();
  for (const group of groups) {
    let matches;
    try { matches = root.querySelectorAll(group.selector); if (root.matches(group.selector)) matches = [root,...matches]; }
    catch { result.missing.push({name:group.name,variant:group.variant ?? 'default',reason:'invalid-selector'}); continue; }
    let visible = 0;
    for (const node of matches) {
      if (++result.scanned > 120 || performance.now() - started > 100 || result.roles.length >= 24) { result.truncated = true; break; }
      const rect = node.getBoundingClientRect(), computed = getComputedStyle(node);
      if (!rect.width || !rect.height || computed.visibility !== 'visible' || node.closest('[hidden],[inert],[aria-hidden="true"]')) continue;
      visible++;
      const name = group.named ? node.getAttribute('data-ui-role') : group.name;
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name ?? '')) continue;
      const declared = group.variant ?? node.getAttribute('data-ui-variant');
      const variant = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(declared ?? '') ? declared : 'default';
      const values = Object.fromEntries(properties.map(property => [property, String(computed[property]).slice(0,160)]));
      if (result.roles.some(role => role.name === name && role.variant === variant && JSON.stringify(role.styles) === JSON.stringify(values))) continue;
      result.roles.push({ name, variant, selector: group.selector.slice(0,256), styles: values });
    }
    if (!visible) result.missing.push({name:group.name,variant:group.variant ?? 'default',reason:matches.length ? 'no-visible-match' : 'no-match'});
    if (result.truncated) break;
  }
  return result;
}
