import "./fonts";
import React from "react";
import { Composition } from "remotion";
import { Main, SceneComposition } from "./Main";
import { Thumbnail } from "./Thumbnail";
import { spec, timeline } from "./timeline";

export const Root: React.FC = () => {
  const { scenes, durationInFrames } = timeline();
  return (
    <>
      <Composition id="Main" component={Main} durationInFrames={durationInFrames} fps={spec.fps} width={spec.width} height={spec.height} />
      <Composition id="thumbnail" component={Thumbnail} durationInFrames={1} fps={spec.fps} width={1280} height={720} />
      {scenes.map((scene) => (
        <Composition key={scene.id} id={`scene-${scene.id}`} component={SceneComposition} defaultProps={{ sceneId: scene.id }}
          durationInFrames={scene.durationInFrames} fps={spec.fps} width={spec.width} height={spec.height} />
      ))}
    </>
  );
};
