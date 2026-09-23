import type React from "react";
import type { TimedScene } from "../timeline";
import { Ambiguity } from "./Ambiguity";
import { MatrixScene } from "./MatrixScene";
import { Stack } from "./Stack";
import { Weights } from "./Weights";

/** video.json `component` names resolve here. Add one entry per scene type. */
export const scenes: Record<string, React.FC<any & { scene: TimedScene }>> = {
  Ambiguity,
  Weights,
  MatrixScene,
  Stack,
};
