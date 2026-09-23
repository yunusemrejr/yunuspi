import React from "react";
import { useCurrentFrame } from "remotion";
import { progress } from "../motion";
import { Heading, NeuralNet, Stage } from "../primitives";
import { cue, type TimedScene } from "../timeline";

export const Stack: React.FC<{ scene: TimedScene; layers: number[]; labels: string[]; kicker: string; title: string }> = ({ scene, layers, labels, kicker, title }) => {
  const frame = useCurrentFrame();
  return (
    <Stage seed={9}>
      <div style={{ position: "absolute", left: 0, right: 0, top: 40, display: "flex", justifyContent: "center" }}>
        <NeuralNet layers={layers} width={1500} height={470} build={progress(frame, cue(scene, "network"), 40)} signal={progress(frame, cue(scene, "signal"), 70)} labels={labels} nodeRadius={17} />
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 20 }}>
        <Heading kicker={kicker} title={title} at={cue(scene, "title")} align="center" size={96} />
      </div>
    </Stage>
  );
};
