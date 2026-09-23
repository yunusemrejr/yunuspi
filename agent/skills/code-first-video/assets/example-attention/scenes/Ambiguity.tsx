import React from "react";
import { useCurrentFrame } from "remotion";
import { enter, progress, sweep } from "../motion";
import { Stage, TokenRow } from "../primitives";
import { type, useTheme } from "../theme";
import { cue, type TimedScene } from "../timeline";

export const Ambiguity: React.FC<{ scene: TimedScene; tokens: string[]; focus: number; question: string }> = ({ scene, tokens, focus, question }) => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  return (
    <Stage seed={3}>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 40 }}>
        <div style={{ fontFamily: theme.display, fontWeight: 700, fontSize: type.title, ...enter(frame, cue(scene, "question"), 20) }}>{question}</div>
        <TokenRow tokens={tokens} width={1680} appear={sweep(frame, cue(scene, "tokens"), 40)} focus={focus} lift={progress(frame, cue(scene, "focus"), 18)} scan={sweep(frame, cue(scene, "scan"), 45)} />
      </div>
    </Stage>
  );
};
