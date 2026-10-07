import React, { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AbsoluteFill, continueRender, delayRender, Img, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { BlenderShot, ShotScreen } from '../primitives/BlenderShot';
import { cameraAt, clamp, cueTime, fitLines, layerPose, motionEase, pathData, type Layer } from '../production';
import { ReviewLayout } from '../review';
import { useCanvas, useTheme } from '../theme';
import type { TimedScene } from '../timeline';

/** Fitted text uses the actual loaded font, not character counts. Explicit
 * newlines are respected; every line stays in its reserved layout region. */
function fitText(text: string, width: number, height: number, family: string, weight: number, wanted: number) {
  const key = JSON.stringify([text,width,height,family,weight,wanted]);
  const old = fittedCache.get(key); if (old) return old;
  textContext ??= document.createElement('canvas').getContext('2d')!;
  const fitted = fitLines(text,width,height,(line,size) => {
    textContext!.font = `${weight} ${size}px "${family}"`;
    return textContext!.measureText(line).width;
  },wanted);
  if (fittedCache.size >= 256) fittedCache.clear();
  fittedCache.set(key,fitted); return fitted;
}
let textContext: CanvasRenderingContext2D | null = null;
const fittedCache = new Map<string, ReturnType<typeof fitLines>>();

const Picture: React.FC<{ layer: Layer; width: number; height: number; t: number }> = ({ layer, width, height, t }) => {
  const { fps } = useVideoConfig(), theme = useTheme();
  const bar = layer.chrome === 'browser' ? Math.min(48, height * .065) : 0;
  const contentHeight = height - bar;
  const sw = layer.sourceWidth ?? width, sh = layer.sourceHeight ?? contentHeight;
  const fit = layer.camera?.length ? 'cover' : layer.fit ?? 'contain';
  const ratio = (fit === 'cover' ? Math.max : Math.min)(width/sw, contentHeight/sh);
  const imageWidth = sw*ratio, imageHeight = sh*ratio;
  const camera = cameraAt(layer.camera, (layer.startFrom ?? 0) + t * (layer.speed ?? 1), { x: width/imageWidth, y: contentHeight/imageHeight });
  const zx = imageWidth*camera.zoom, zy = imageHeight*camera.zoom;
  const cx = Math.max(width/(2*zx), Math.min(1-width/(2*zx), camera.x));
  const cy = Math.max(contentHeight/(2*zy), Math.min(1-contentHeight/(2*zy), camera.y));
  const trim = Math.round((layer.startFrom ?? 0) * fps);
  return <div style={{ position: 'absolute', inset: 0, borderRadius: layer.chrome === 'phone' ? 44 : layer.radius ?? 12, overflow: 'hidden', background: theme.surface,
    border: layer.chrome === 'phone' ? '12px solid #16191e' : layer.chrome === 'browser' ? '1px solid #ffffff30' : undefined,
    boxShadow: layer.chrome && layer.chrome !== 'none' ? '0 24px 48px #0004' : undefined }}>
    {bar > 0 ? <div style={{ height: bar, background: theme.surface, display: 'flex', alignItems: 'center', padding: '0 18px', gap: 8 }}>
      {[0, 1, 2].map(i => <div key={i} style={{ width: 9, height: 9, borderRadius: 9, background: theme.muted, opacity: .5 }} />)}
      <span style={{ fontFamily: theme.mono, fontSize: Math.min(20, bar * .45), color: theme.muted, marginLeft: 16 }}>{layer.label ?? ''}</span>
    </div> : null}
    <div style={{ position: 'absolute', left: 0, right: 0, top: bar, bottom: 0, overflow: 'hidden' }}>
      <div style={{ width: imageWidth, height: imageHeight, transformOrigin: '0 0', transform: `translate(${width/2-cx*zx}px,${contentHeight/2-cy*zy}px) scale(${camera.zoom})` }}>
        {layer.kind === 'image' ? <Img src={staticFile(layer.src!)} style={{ width: '100%', height: '100%', objectFit: layer.fit ?? 'contain' }} /> :
          <OffthreadVideo src={staticFile(layer.src!)} trimBefore={trim} playbackRate={layer.speed ?? 1} muted style={{ width: '100%', height: '100%', objectFit: layer.fit ?? 'contain' }} />}
      </div>
    </div>
  </div>;
};

/** Native storyboard compositor. Reserved regions, shared typography and one
 * choreography clock coordinate assets; the model supplies story and intent. */
export const StudioScene: React.FC<{ scene: TimedScene; layers: Layer[]; background?: string; ink?: string }> = ({ scene, layers, background, ink }) => {
  const frame = useCurrentFrame(), { fps } = useVideoConfig(), canvas = useCanvas(), theme = useTheme(), t = frame / fps;
  const probe = useContext(ReviewLayout), element = useRef<HTMLDivElement>(null);
  const [fontHandle]=useState(()=>delayRender('Fitting native typography')), [fontReady,setFontReady]=useState(false);
  useEffect(()=>{let alive=true;document.fonts.ready.then(()=>{if(alive){fittedCache.clear();setFontReady(true);}});return()=>{alive=false;continueRender(fontHandle);};},[fontHandle]);
  useLayoutEffect(()=>{if(fontReady)continueRender(fontHandle);},[fontReady,fontHandle]);
  useLayoutEffect(() => {
    if (!probe || !fontReady || !element.current) return;
    const facts = [...element.current.querySelectorAll<HTMLElement>('[data-production-text]')].map(node => ({
      id:node.dataset.productionText, size:Number(node.dataset.fontSize), lines:Number(node.dataset.lineCount),
      overflow:node.dataset.overflow === 'true' || node.scrollWidth > node.clientWidth+1 || node.scrollHeight > node.clientHeight+1,
    }));
    console.info('YUNUSPI_LAYOUT '+JSON.stringify({scene:scene.id,frame,seconds:t,text:facts}));
  },[probe,fontReady,frame,scene.id]);
  return <AbsoluteFill ref={element} style={{ background: background ?? theme.background, color: ink ?? theme.ink, perspective: 1400 }}>
    {layers.map(layer => {
      const [x, y, w, h] = layer.box, width = w * canvas.width, height = h * canvas.height;
      const pose = layerPose(t, layer.motion, scene.cues,canvas.width/canvas.height);
      const color=layer.color ?? (layer.colorRole ? theme[layer.colorRole] : undefined);
      const family = theme[layer.font ?? 'display'], weight = layer.weight ?? (layer.font === 'mono' ? 500 : theme.displayWeight ?? 800);
      const at = cueTime(layer.motion,scene.cues), p=motionEase((t-at)/Math.max(.01,layer.motion?.duration ?? .65),layer.motion?.easing);
      const number = (n: number) => `${layer.value?.prefix ?? ''}${n.toFixed(layer.value?.decimals ?? 0)}${layer.value?.suffix ?? ''}`;
      const text = layer.kind === 'counter' ? number((layer.value!.from)+(layer.value!.to-layer.value!.from)*clamp(p)) : layer.text;
      const measureText = layer.kind === 'counter' ? [number(layer.value!.from),number(layer.value!.to)].sort((a,b)=>b.length-a.length)[0] : text;
      const fitted = ['text','counter'].includes(layer.kind) ? fitText(measureText!, width, height, family, weight, layer.size ?? 112) : null;
      return <div key={layer.id} data-production-layer={layer.id} style={{ position: 'absolute', left: x * canvas.width, top: y * canvas.height, width, height,
        transform: `translate(${pose.x * canvas.width}px,${pose.y * canvas.height}px) rotateX(${pose.rotateX}deg) rotateY(${pose.rotateY}deg) rotate(${pose.rotate}deg) scale(${pose.scale*pose.scaleX},${pose.scale*pose.scaleY})`, opacity: pose.opacity,
        filter: pose.blur ? `blur(${pose.blur}px)` : undefined, backfaceVisibility:'hidden',
        clipPath: pose.reveal < 1 ? `inset(0 ${(1 - pose.reveal) * 100}% 0 0)` : undefined }}>
        {fitted ? <div data-production-text={layer.id} data-font-size={fitted.size} data-line-count={fitted.lines.length} data-overflow={fitted.overflow} style={{ width, height, color: color ?? ink ?? theme.ink, fontFamily: family, fontWeight: weight, fontSize: fitted.size,
          lineHeight: 1.08, letterSpacing: '-.035em', textAlign: layer.align ?? 'left', display: 'flex', flexDirection: 'column', justifyContent: 'center', fontVariantNumeric:layer.kind==='counter'?'tabular-nums':undefined }}>
          {layer.kind === 'counter' ? <div>{text}</div> : layer.reveal === 'words' || layer.reveal === 'typewriter' ? <div style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>
            {(layer.reveal === 'words' ? layer.text!.split(/(\s+)/) : Array.from(layer.text!)).map((token,i,all) => {
              const index = layer.reveal === 'words' ? all.slice(0,i).filter(v=>v.trim()).length : i;
              const show = !token.trim() || t >= (layer.wordCues?.[index] ? scene.cues?.[layer.wordCues[index]] : layer.wordTimes?.[index] ?? at+index*(layer.motion?.stagger ?? (layer.reveal==='words'?.12:.04)));
              return <span key={i} style={{visibility:show?'visible':'hidden'}}>{token}</span>;
            })}
          </div> : fitted.lines.map((line, i) => {
            const at = cueTime(layer.motion, scene.cues), p = layer.reveal === 'lines' ? motionEase((t-at-i*(layer.motion?.stagger ?? .1))/Math.max(.01,layer.motion?.duration ?? .65),layer.motion?.easing) : 1;
            return <div key={i} style={{ overflow: 'hidden' }}><div style={{ whiteSpace: 'nowrap', transform: `translateY(${(1-p)*105}%)` }}>{line || '\u00a0'}</div></div>;
          })}
        </div> : layer.kind === 'shot' ? <BlenderShot shot={layer.shot!} bounds={{ width, height }} fit={layer.fit} subjectFit={layer.subjectFit ?? layer.role !== 'background'} blend={false} mode={layer.mode} offset={layer.startFrom} speed={layer.speed}>
          {layer.screen ? <ShotScreen {...layer.screen} /> : null}
        </BlenderShot> : layer.kind === 'path' ? <svg width={width} height={height} style={{overflow:'visible'}}>
          <defs>{layer.path?.arrow ? <marker id={`arrow-${scene.id}-${layer.id}`} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7" fill="none" stroke={layer.stroke ?? color ?? theme.accent} strokeWidth="1.4" /></marker> : null}</defs>
          <path d={pathData(layer.path!.points,width,height,layer.path?.smooth,layer.path?.closed)} pathLength={1} fill={layer.path?.closed ? color ?? 'none' : 'none'} stroke={layer.stroke ?? color ?? theme.accent} strokeWidth={layer.strokeWidth ?? 4} strokeLinecap="round" strokeLinejoin="round"
            strokeDasharray={layer.path?.draw ? '1 1' : undefined} strokeDashoffset={layer.path?.draw ? 1-clamp(p) : undefined} markerEnd={layer.path?.arrow && (!layer.path.draw || p>=.99) ? `url(#arrow-${scene.id}-${layer.id})` : undefined} />
        </svg> : layer.kind === 'shape' ? <div style={{ width, height, boxSizing:'border-box', background: color ?? theme.accent, border:layer.stroke ? `${layer.strokeWidth ?? 2}px solid ${layer.stroke}`:undefined, borderRadius: layer.shape === 'ellipse' ? '50%' : layer.radius ?? 0, boxShadow:layer.shadow==='soft'?'0 20px 50px #0002':undefined }} /> :
          <Picture layer={layer} width={width} height={height} t={t} />}
      </div>;
    })}
  </AbsoluteFill>;
};
