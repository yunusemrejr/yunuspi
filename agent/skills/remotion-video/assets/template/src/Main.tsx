import React from "react";
import { AbsoluteFill, Audio, interpolate, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { estimateSeconds } from "./captions";
import { ease } from "./motion";
import { Captions } from "./primitives/Captions";
import { scenes as registry } from "./scenes";
import { ThemeProvider } from "./theme";
import { narrationWindows, spec, timeline, toFrames, type SceneSpec, type TimedScene } from "./timeline";

/** Entry transition over the first `seconds` of a scene (default 0.5 s). */
const Entry: React.FC<{ transition?: SceneSpec["transition"]; children: React.ReactNode }> = ({ transition, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!transition || transition.type === "none") return <>{children}</>;
  const frames = Math.max(1, Math.round((transition.seconds ?? 0.5) * fps));
  const p = interpolate(frame, [0, frames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease.out });
  const style: React.CSSProperties =
    transition.type === "fade" ? { opacity: p }
    : transition.type === "slide" ? { opacity: p, transform: `translateX(${(1 - p) * 8}%)` }
    : transition.type === "wipe" ? { clipPath: `inset(0 ${(1 - p) * 100}% 0 0)` }
    : transition.type === "zoom" ? { opacity: p, transform: `scale(${1.08 - 0.08 * p})` }
    : { opacity: Math.min(1, p * 1.5), filter: `blur(${(1 - p) * 16}px)` };
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
  if (!ducked) return spec.audio.musicVolume;
  const distance = Math.min(...narrationWindows().map(([start, end]) => (frame < start ? start - frame : frame > end ? frame - end : 0)));
  return interpolate(distance, [0, ramp], [spec.audio.musicDuckedVolume, spec.audio.musicVolume], { extrapolateRight: "clamp" });
}

export const Main: React.FC = () => {
  const { scenes, durationInFrames } = timeline();
  return (
    <ThemeProvider>
      <AbsoluteFill style={{ background: spec.theme.background }}>
        {scenes.map((scene) => (
          <Sequence key={scene.id} from={scene.from} durationInFrames={scene.durationInFrames} name={scene.id}>
            <Entry transition={scene.transition}>
              <SceneView scene={scene} />
            </Entry>
            {spec.captions?.enabled && scene.narration ? (
              <Sequence from={toFrames(scene.narrationOffset ?? 0)} name={`captions:${scene.id}`}>
                <Captions text={scene.narration} seconds={scene.narrationSeconds ?? estimateSeconds(scene.narration)} style={spec.captions.style} maxWords={spec.captions.maxWords} position={spec.captions.position} />
              </Sequence>
            ) : null}
            {scene.narrationAudio ? (
              <Sequence from={toFrames(scene.narrationOffset ?? 0)} name={`narration:${scene.id}`}>
                <Audio src={staticFile(scene.narrationAudio)} volume={spec.audio.narrationVolume} />
              </Sequence>
            ) : null}
          </Sequence>
        ))}
        {spec.audio.music ? <Audio src={staticFile(spec.audio.music)} volume={musicVolume} endAt={durationInFrames} /> : null}
        {spec.audio.sfx.map((sfx, i) => (
          <Sequence key={`sfx-${i}`} from={toFrames(sfx.at)} name={`sfx:${sfx.src}`}>
            <Audio src={staticFile(sfx.src)} volume={sfx.volume ?? 0.6} />
          </Sequence>
        ))}
      </AbsoluteFill>
    </ThemeProvider>
  );
};

/** One scene in isolation, used for scene-range previews and stills. */
export const SceneComposition: React.FC<{ sceneId: string }> = ({ sceneId }) => {
  const scene = timeline().scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`Unknown scene ${sceneId}`);
  return (
    <ThemeProvider>
      <SceneView scene={{ ...scene, from: 0 }} />
    </ThemeProvider>
  );
};
