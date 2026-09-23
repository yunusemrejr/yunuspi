import React from "react";
import { AbsoluteFill, Audio, interpolate, Sequence, staticFile } from "remotion";
import { scenes as registry } from "./scenes";
import { ThemeProvider } from "./theme";
import { narrationWindows, spec, timeline, toFrames, type TimedScene } from "./timeline";

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
            <SceneView scene={scene} />
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
