import React from "react";
import { AbsoluteFill, Audio, interpolate, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { estimateSeconds } from "./captions";
import { ease } from "./motion";
import { Captions } from "./primitives/Captions";
import { BrandBug, CtaLayer } from "./primitives/Cta";
import { scenes as registry } from "./scenes";
import { Canvas, ThemeProvider } from "./theme";
import { ReviewLayout } from './review';
import { narrationWindows, spec, timeline, toFrames, type SceneSpec, type TimedScene } from "./timeline";

type Transition = SceneSpec["transition"];
const transitionFrames = (transition: Transition) => (transition && transition.type !== "none" ? Math.max(1, Math.round((transition.seconds ?? 0.5) * spec.fps)) : 0);

/** Style of an incoming (p 0→1) or outgoing (p 0→1 as it leaves) scene. The
 * outgoing scene stays mounted underneath for the overlap, so a transition is
 * a real crossfade or hand-off, not a dip through the background. */
function transitionStyle(kind: NonNullable<Transition>["type"], p: number, leaving: boolean): React.CSSProperties {
  const o = leaving ? 1 - p : p;
  switch (kind) {
    case "fade": return { opacity: o };
    case "slide": return leaving ? { opacity: o, transform: `translateX(${-p * 8}%)` } : { opacity: p, transform: `translateX(${(1 - p) * 8}%)` };
    case "slideup": return leaving ? { opacity: o, transform: `translateY(${-p * 8}%)` } : { opacity: p, transform: `translateY(${(1 - p) * 8}%)` };
    case "slidedown": return leaving ? { opacity: o, transform: `translateY(${p * 8}%)` } : { opacity: p, transform: `translateY(${(p - 1) * 8}%)` };
    case "wipe": return leaving ? {} : { clipPath: `inset(0 ${(1 - p) * 100}% 0 0)` };
    case "zoom": return leaving ? { opacity: o, transform: `scale(${1 + 0.05 * p})` } : { opacity: p, transform: `scale(${1.08 - 0.08 * p})` };
    default: return leaving ? { opacity: o, filter: `blur(${p * 10}px)` } : { opacity: Math.min(1, p * 1.5), filter: `blur(${(1 - p) * 16}px)` };
  }
}

/** Applies the scene's entry transition over its first frames and the next
 * scene's transition (as an exit) over the frames it stays mounted past its
 * natural end. Scenes do not fade themselves; this is the one owner. */
const Layer: React.FC<{ entry: Transition; exit: Transition; naturalFrames: number; children: React.ReactNode }> = ({ entry, exit, naturalFrames, children }) => {
  const frame = useCurrentFrame();
  const inFrames = transitionFrames(entry), outFrames = transitionFrames(exit);
  let style: React.CSSProperties = {};
  if (inFrames && entry) style = transitionStyle(entry.type, interpolate(frame, [0, inFrames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease.out }), false);
  if (outFrames && exit && frame >= naturalFrames) style = transitionStyle(exit.type, interpolate(frame, [naturalFrames, naturalFrames + outFrames], [0, 1], { extrapolateRight: "clamp", easing: ease.inOut }), true);
  return <AbsoluteFill style={style}>{children}</AbsoluteFill>;
};

export const SceneView: React.FC<{ scene: TimedScene }> = ({ scene }) => {
  const Component = registry[scene.component];
  if (!Component) throw new Error(`Scene "${scene.id}" uses unknown component "${scene.component}"; register it in src/scenes/index.ts`);
  return <Component scene={scene} {...(scene.props ?? {})} />;
};

/** Music volume ducks under every narration window with short ramps. */
function musicVolume(frame: number): number {
  const ramp = 10;
  const ducked = narrationWindows().some(([start, end]) => frame >= start - ramp && frame <= end + ramp);
  const duration = timeline().durationInFrames;
  const fade = Math.min(1, Math.max(0, frame / Math.max(1, spec.fps*.25)), Math.max(0, (duration - 1 - frame) / Math.max(1, spec.fps*.9)));
  if (!ducked) return spec.audio.musicVolume * fade;
  const distance = Math.min(...narrationWindows().map(([start, end]) => (frame < start ? start - frame : frame > end ? frame - end : 0)));
  return interpolate(distance, [0, ramp], [spec.audio.musicDuckedVolume, spec.audio.musicVolume], { extrapolateRight: "clamp" }) * fade;
}

export const Main: React.FC<{ reviewLayout?: boolean }> = ({reviewLayout=false}) => {
  const { scenes, durationInFrames } = timeline();
  // The end screen carries the full brand; the corner mark steps aside for it.
  const outro = scenes.find((scene) => scene.component === "OutroScene");
  const outroStart = outro ? outro.startSeconds : undefined;
  return (
    <ReviewLayout.Provider value={reviewLayout}><ThemeProvider>
      <AbsoluteFill style={{ background: spec.theme.background }}>
        <Canvas>
          {scenes.map((scene, i) => (
            <Sequence key={scene.id} from={scene.from} durationInFrames={scene.durationInFrames + transitionFrames(scenes[i + 1]?.transition)} name={scene.id}>
              <Layer entry={scene.transition} exit={scenes[i + 1]?.transition} naturalFrames={scene.durationInFrames}>
                <SceneView scene={scene} />
              </Layer>
              {spec.captions?.enabled && scene.narration ? (
                <Sequence from={toFrames(scene.narrationOffset ?? 0)} name={`captions:${scene.id}`}>
                  <Captions text={scene.narration} seconds={scene.narrationSeconds ?? estimateSeconds(scene.narration)} words={scene.narrationWords} style={spec.captions.style} maxWords={spec.captions.maxWords} position={spec.captions.position} />
                </Sequence>
              ) : null}
              {scene.narrationAudio ? (
                <Sequence from={toFrames(scene.narrationOffset ?? 0)} name={`narration:${scene.id}`}>
                  <Audio src={staticFile(scene.narrationAudio)} volume={spec.audio.narrationVolume} />
                </Sequence>
              ) : null}
            </Sequence>
          ))}
          <BrandBug endsAt={outroStart} />
          <CtaLayer />
        </Canvas>
        {spec.audio.music ? <Audio src={staticFile(spec.audio.music)} volume={musicVolume} endAt={durationInFrames} /> : null}
        {spec.audio.sfx.map((sfx, i) => (
          <Sequence key={`sfx-${i}`} from={toFrames(sfx.at)} name={`sfx:${sfx.src}`}>
            <Audio src={staticFile(sfx.src)} volume={sfx.volume ?? 0.6} />
          </Sequence>
        ))}
      </AbsoluteFill>
    </ThemeProvider></ReviewLayout.Provider>
  );
};

/** One scene in isolation, used for scene-range previews and stills. */
export const SceneComposition: React.FC<{ sceneId: string }> = ({ sceneId }) => {
  const scene = timeline().scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`Unknown scene ${sceneId}`);
  return (
    <ThemeProvider>
      <Canvas>
        <SceneView scene={{ ...scene, from: 0 }} />
      </Canvas>
    </ThemeProvider>
  );
};
