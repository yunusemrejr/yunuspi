import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { ease, enter, exitFade, progress, sweep } from "../motion";
import { Matrix, Stage } from "../primitives";
import { type, useTheme } from "../theme";
import { cue, type TimedScene } from "../timeline";

export const MatrixScene: React.FC<{ scene: TimedScene; labels: string[]; values: number[][]; highlightRow: number; label: string }> = ({ scene, labels, values, highlightRow, label }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const theme = useTheme();
  return (
    <Stage seed={5}>
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "space-between", opacity: exitFade(frame, durationInFrames) }}>
        <div style={{ width: 700 }}>
          <div style={{ fontFamily: theme.mono, fontSize: type.label, letterSpacing: "0.16em", textTransform: "uppercase", color: theme.accent, ...enter(frame, cue(scene, "matrix")) }}>Rows look at columns</div>
          <div style={{ marginTop: 28, fontFamily: theme.display, fontWeight: 700, fontSize: type.heading + 8, lineHeight: 1.1, textWrap: "balance", ...enter(frame, cue(scene, "label")) }}>{label}</div>
        </div>
        <Matrix values={values} cell={104} reveal={sweep(frame, cue(scene, "matrix"), 120)} rowLabels={labels} colLabels={labels}
          highlightRow={highlightRow} highlight={progress(frame, cue(scene, "highlight"), 20)} pulse={progress(frame, cue(scene, "parallel"), 36, ease.inOut)} />
      </div>
    </Stage>
  );
};
