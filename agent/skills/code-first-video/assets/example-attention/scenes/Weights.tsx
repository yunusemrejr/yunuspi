import React from "react";
import { useCurrentFrame } from "remotion";
import { enter, progress, sweep } from "../motion";
import { Stage, TokenRow } from "../primitives";
import { type, useTheme } from "../theme";
import { cue, type TimedScene } from "../timeline";

export const Weights: React.FC<{ scene: TimedScene; tokens: string[]; focus: number; weights: number[]; winner: number; label: string }> = ({ scene, tokens, focus, weights, winner, label }) => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  return (
    <Stage seed={3}>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 24 }}>
        <TokenRow tokens={tokens} width={1680} appear={1} focus={focus} lift={1} weights={weights}
          arcs={sweep(frame, cue(scene, "arcs"), 110)} winner={winner} winnerGlow={progress(frame, cue(scene, "winner"), 20)} />
        <div style={{ fontFamily: theme.display, fontWeight: 600, fontSize: type.heading, ...enter(frame, cue(scene, "label")) }}>{label}</div>
      </div>
    </Stage>
  );
};
