/** Runs inside the existing isolated renderer. Numeric evidence, never a style score.
 * Contrast formula/thresholds: WCAG 2.2 SC 1.4.3 (solid opaque sRGB only).
 * https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html */
export function inspectDesignState(root) {
  const started=performance.now(),limit=600,timeLimit=120;
  const result={version:1,visited:0,visible:0,truncated:false,viewport:{width:innerWidth,height:innerHeight},
    horizontalOverflowPx:Math.max(0,document.documentElement.scrollWidth-document.documentElement.clientWidth),
    typography:[],spacing:[],surfacePatterns:{gradients:0,shadows:0,rounded:0},
    contrast:{checked:0,belowThreshold:0,indeterminate:0},findings:[],
    motion:{reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,running:0,infinite:0,sampled:0,truncated:false},
    limitations:'Bounded main-document computed-style sample, not an aesthetic score or accessibility certification. No text, input values or CSS URLs returned. Contrast excludes images, opacity, filters, blending, shadows, pseudo-elements and unknown backgrounds; occlusion, focus, states, canvas, frames and shadow roots need separate inspection. Repeated surfaces may be intentional. Use screenshots and the relevant design skill to judge hierarchy, originality and composition.'};
  if(!root)return result;
  const fonts=new Map(),spaces=new Map();
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
    if(rect.width>0&&rect.height>0&&style.visibility==='visible'&&!node.closest('[hidden],[inert],[aria-hidden="true"]')){
      result.visible++;
      const font={family:style.fontFamily.slice(0,120),sizePx:parseFloat(style.fontSize),weight:style.fontWeight,lineHeight:style.lineHeight};
      count(fonts,JSON.stringify(font));
      for(const value of [style.gap,style.paddingTop,style.paddingRight,style.paddingBottom,style.paddingLeft,style.marginTop,style.marginBottom]){const n=parseFloat(value);if(Number.isFinite(n)&&n>0&&n<=512)count(spaces,String(round(n)));}
      if(/gradient\(/.test(style.backgroundImage))result.surfacePatterns.gradients++;
      if(style.boxShadow!=='none')result.surfacePatterns.shadows++;
      if(parseFloat(style.borderTopLeftRadius)>0)result.surfacePatterns.rounded++;
      if(rect.width>innerWidth+1&&style.position!=='fixed')finding('wider-than-viewport',node,{widthPx:round(rect.width)});
      let hasText=false,children=0;for(let child=node.firstChild;child&&children++<64;child=child.nextSibling)if(child.nodeType===Node.TEXT_NODE&&child.textContent.trim()){hasText=true;break;}
      if(hasText&&!node.matches('script,style,template,input,textarea,select,:disabled,[aria-disabled="true"]')){
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
  result.typography=[...fonts].sort((a,b)=>b[1]-a[1]).slice(0,10).map(([key,count])=>({...JSON.parse(key),count}));
  if(fonts.size>10||spaces.size>16)result.truncated=true;
  result.spacing=[...spaces].sort((a,b)=>b[1]-a[1]).slice(0,16).map(([pixels,count])=>({pixels:Number(pixels),count}));
  const animations=document.getAnimations();result.motion.truncated=animations.length>100;
  for(const animation of animations.slice(0,100)){result.motion.sampled++;if(animation.playState==='running')result.motion.running++;if(animation.effect?.getTiming().iterations===Infinity)result.motion.infinite++;}
  result.limits={elements:limit,scanMs:timeLimit,findings:12,animations:100};
  return result;
}
