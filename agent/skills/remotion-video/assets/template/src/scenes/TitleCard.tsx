import React from "react";
import { Heading, Stage } from "../primitives";
import { cue, type TimedScene } from "../timeline";

export const TitleCard: React.FC<{ scene: TimedScene; kicker?: string; title: string; subtitle?: string }> = ({ scene, kicker, title, subtitle }) => {
  return (
    <Stage seed={scene.index + 3}>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 80 }}>
        <Heading kicker={kicker} title={title} subtitle={subtitle} at={cue(scene, "title")} subtitleAt={cue(scene, "subtitle")} />
      </div>
    </Stage>
  );
};
