import React from 'react';
import { AbsoluteFill, Img, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { BlenderShot, ShotScreen } from '../primitives/BlenderShot';
import { cameraAt, cueTime, layerPose, motionEase, type Layer } from '../production';
import { useCanvas, useTheme } from '../theme';
import type { TimedScene } from '../timeline';

/** Fitted text uses the actual loaded font, not character counts. Explicit
 * newlines are respected; every line stays in its reserved layout region. */
function fitText(text: string, width: number, height: number, family: string, weight: number, wanted: number) {
  const context = document.createElement('canvas').getContext('2d')!;
  const linesAt = (size: number) => {
    context.font = `${weight} ${size}px "${family}"`;
    return text.split('\n').flatMap(paragraph => {
      const lines: string[] = []; let line = '';
      for (const word of paragraph.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (line && context.measureText(next).width > width) { lines.push(line); line = word; } else line = next;
      }
      lines.push(line); return lines;
    });
  };
  let size = wanted, lines = linesAt(size);
  while (size > 14 && (lines.length * size * 1.08 > height || lines.some(line => context.measureText(line).width > width))) { size -= 1; lines = linesAt(size); }
  return { lines, size };
}

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
  return <AbsoluteFill style={{ background: background ?? theme.background, color: ink ?? theme.ink }}>
    {layers.map(layer => {
      const [x, y, w, h] = layer.box, width = w * canvas.width, height = h * canvas.height;
      const pose = layerPose(t, layer.motion, scene.cues);
      const family = theme[layer.font ?? 'display'], weight = layer.weight ?? (layer.font === 'mono' ? 500 : theme.displayWeight ?? 800);
      const fitted = layer.kind === 'text' ? fitText(layer.text!, width, height, family, weight, layer.size ?? 112) : null;
      return <div key={layer.id} data-production-layer={layer.id} style={{ position: 'absolute', left: x * canvas.width, top: y * canvas.height, width, height,
        transform: `translate(${pose.x * canvas.width}px,${pose.y * canvas.height}px) scale(${pose.scale}) rotate(${pose.rotate}deg)`, opacity: pose.opacity,
        clipPath: pose.reveal < 1 ? `inset(0 ${(1 - pose.reveal) * 100}% 0 0)` : undefined }}>
        {fitted ? <div data-production-text={layer.id} style={{ width, height, color: layer.color ?? ink ?? theme.ink, fontFamily: family, fontWeight: weight, fontSize: fitted.size,
          lineHeight: 1.08, letterSpacing: '-.035em', textAlign: layer.align ?? 'left', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          {fitted.lines.map((line, i) => {
            const at = cueTime(layer.motion, scene.cues), p = layer.reveal === 'lines' ? motionEase((t-at-i*(layer.motion?.stagger ?? .1))/Math.max(.01,layer.motion?.duration ?? .65),layer.motion?.easing) : 1;
            return <div key={i} style={{ overflow: 'hidden' }}><div style={{ whiteSpace: 'nowrap', transform: `translateY(${(1-p)*105}%)` }}>{line || '\u00a0'}</div></div>;
          })}
        </div> : layer.kind === 'shot' ? <BlenderShot shot={layer.shot!} bounds={{ width, height }} subjectFit blend={false} mode={layer.mode} offset={layer.startFrom} speed={layer.speed}>
          {layer.screen ? <ShotScreen {...layer.screen} /> : null}
        </BlenderShot> : layer.kind === 'shape' ? <div style={{ width, height, background: layer.color ?? theme.accent, borderRadius: layer.shape === 'ellipse' ? '50%' : layer.radius ?? 0 }} /> :
          <Picture layer={layer} width={width} height={height} t={t} />}
      </div>;
    })}
  </AbsoluteFill>;
};
