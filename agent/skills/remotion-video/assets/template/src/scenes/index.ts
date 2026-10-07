import type React from "react";
import type { TimedScene } from "../timeline";
import { DiagramScene } from "./DiagramScene";
import { HtmlScene } from "./HtmlScene";
import { OutroScene } from "./OutroScene";
import { ShotScene } from "./ShotScene";
import { TitleCard } from "./TitleCard";
import { StudioScene } from './StudioScene';

/** video.json `component` names resolve here. Add one entry per scene type. */
export const scenes: Record<string, React.FC<any & { scene: TimedScene }>> = {
  TitleCard,
  DiagramScene,
  OutroScene,
  ShotScene,
  HtmlScene,
  StudioScene,
};
