import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { exitFade } from "../motion";
import { Heading, Stage } from "../primitives";
import { cue, type TimedScene } from "../timeline";

export const TitleCard: React.FC<{ scene: TimedScene; kicker?: string; title: string; subtitle?: string }> = ({ scene, kicker, title, subtitle }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  return (
    <Stage seed={scene.index + 3}>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 80, opacity: exitFade(frame, durationInFrames) }}>
        <Heading kicker={kicker} title={title} subtitle={subtitle} at={cue(scene, "title")} subtitleAt={cue(scene, "subtitle")} />
      </div>
    </Stage>
  );
};
