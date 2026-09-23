import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { exitFade, progress, enter } from "../motion";
import { NeuralNet, Stage } from "../primitives";
import { type, useTheme } from "../theme";
import { cue, type TimedScene } from "../timeline";

/** Example of a concept shown as a working system rather than a slide: the
 * network builds, a signal travels through it, then a single label names it. */
export const DiagramScene: React.FC<{ scene: TimedScene; label: string; layers: number[] }> = ({ scene, label, layers }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const theme = useTheme();
  const build = progress(frame, cue(scene, "network"), 45);
  const signal = progress(frame, cue(scene, "signal"), 60);
  return (
    <Stage seed={scene.index + 5}>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 72, opacity: exitFade(frame, durationInFrames) }}>
        <NeuralNet layers={layers} width={1200} height={560} build={build} signal={signal} />
        <div style={{ fontSize: type.heading, fontFamily: theme.display, fontWeight: 600, ...enter(frame, cue(scene, "label")) }}>{label}</div>
      </div>
    </Stage>
  );
};
